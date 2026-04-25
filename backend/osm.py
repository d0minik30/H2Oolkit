"""OpenStreetMap water source and village search via Overpass API."""

import requests
import math

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
_TIMEOUT = 30
_MAX_RETRIES = 2

# Maps OSM tag combinations to a normalised source_type string
_SOURCE_TYPE_RULES = [
    ({"natural": "spring"}, "spring"),
    ({"man_made": "water_well"}, "well"),
    ({"amenity": "drinking_water"}, "spring"),
    ({"waterway": "river"}, "river"),
    ({"waterway": "canal"}, "river"),
    ({"waterway": "stream"}, "stream"),
    ({"waterway": "ditch"}, "stream"),
    ({"natural": "water"}, "lake"),   # lake/pond/reservoir
]

# Approximate daily flow capacity in litres — used when no GEE data exists.
# These are conservative lower-bound estimates for Carpathian-zone sources.
SOURCE_FLOW_ESTIMATES = {
    "river":  200_000,
    "stream":  20_000,
    "lake":   150_000,
    "spring":   3_000,
    "well":       800,
}

# How reliably a source type produces water year-round (0–1)
SOURCE_RELIABILITY = {
    "river":  0.85,
    "stream": 0.60,
    "lake":   0.80,
    "spring": 0.75,
    "well":   0.65,
}


def search_osm_springs(lat: float, lon: float, radius_m: int = 10000) -> list:
    """
    Query Overpass for natural=spring nodes within radius_m of (lat, lon).

    Returns a list of dicts with id, lat, lon, name, distance_m, tags.
    Falls back to empty list on API failure (non-fatal).
    """
    query = _build_query(lat, lon, radius_m)

    for attempt in range(_MAX_RETRIES):
        try:
            resp = requests.post(
                OVERPASS_URL,
                data={"data": query},
                timeout=_TIMEOUT,
            )
            resp.raise_for_status()
            elements = resp.json().get("elements", [])
            springs = [_parse_element(e, lat, lon) for e in elements if e.get("type") == "node"]
            springs.sort(key=lambda s: s["distance_m"])
            return springs
        except requests.exceptions.Timeout:
            if attempt == _MAX_RETRIES - 1:
                return []
        except Exception:
            return []
    return []


def search_all_water_sources(lat: float, lon: float, radius_m: int = 10_000) -> list:
    """
    Search for every mapped water body within radius_m of (lat, lon).

    Covers springs, wells, streams, rivers, lakes, and drinking-water points.
    Ways (rivers, lakes) are returned as their centroid. Each result includes
    a normalised `source_type` field for downstream ranking.
    """
    query = f"""
    [out:json][timeout:35];
    (
      node["natural"="spring"](around:{radius_m},{lat},{lon});
      node["man_made"="water_well"](around:{radius_m},{lat},{lon});
      node["amenity"="drinking_water"](around:{radius_m},{lat},{lon});
      node["waterway"~"^(stream|river|canal|ditch)$"](around:{radius_m},{lat},{lon});
      way["waterway"~"^(stream|river|canal)$"](around:{radius_m},{lat},{lon});
      way["natural"="water"](around:{radius_m},{lat},{lon});
      node["natural"="water"](around:{radius_m},{lat},{lon});
    );
    out center;
    """

    for attempt in range(_MAX_RETRIES):
        try:
            resp = requests.post(
                OVERPASS_URL,
                data={"data": query},
                timeout=_TIMEOUT,
            )
            resp.raise_for_status()
            elements = resp.json().get("elements", [])
            sources = [_parse_water_source(e, lat, lon) for e in elements]
            sources = [s for s in sources if s is not None]
            # Deduplicate by (source_type, rounded lat/lon)
            seen: set = set()
            unique = []
            for s in sources:
                key = (s["source_type"], round(s["lat"], 4), round(s["lon"], 4))
                if key not in seen:
                    seen.add(key)
                    unique.append(s)
            unique.sort(key=lambda s: s["distance_m"])
            return unique
        except requests.exceptions.Timeout:
            if attempt == _MAX_RETRIES - 1:
                return []
        except Exception:
            return []
    return []


def search_osm_villages(lat: float, lon: float, radius_m: int = 15000) -> list:
    """Find nearby villages/communes for infrastructure cost routing."""
    query = f"""
    [out:json][timeout:25];
    (
      node["place"~"^(village|town|hamlet)$"](around:{radius_m},{lat},{lon});
    );
    out body;
    """
    try:
        resp = requests.post(OVERPASS_URL, data={"data": query}, timeout=_TIMEOUT)
        resp.raise_for_status()
        elements = resp.json().get("elements", [])
        villages = []
        for e in elements:
            if e.get("type") != "node":
                continue
            tags = e.get("tags", {})
            dist = _haversine_m(lat, lon, e["lat"], e["lon"])
            villages.append({
                "id": e["id"],
                "lat": e["lat"],
                "lon": e["lon"],
                "name": tags.get("name", "Unknown"),
                "population": _parse_int(tags.get("population")),
                "place_type": tags.get("place", "village"),
                "distance_m": round(dist, 1),
            })
        villages.sort(key=lambda v: v["distance_m"])
        return villages
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_water_source(element: dict, ref_lat: float, ref_lon: float) -> dict | None:
    """Convert a raw Overpass element (node or way centroid) to a water source dict."""
    tags = element.get("tags", {})

    # Resolve coordinates: nodes have lat/lon directly; ways expose a center object
    if element.get("type") == "node":
        elat, elon = element.get("lat"), element.get("lon")
    elif element.get("type") == "way":
        center = element.get("center", {})
        elat, elon = center.get("lat"), center.get("lon")
    else:
        return None

    if elat is None or elon is None:
        return None

    source_type = _classify_source_type(tags)
    dist = _haversine_m(ref_lat, ref_lon, elat, elon)

    return {
        "id": element["id"],
        "osm_type": element["type"],
        "lat": elat,
        "lon": elon,
        "elevation": None,         # filled in later by elevation.py batch lookup
        "name": tags.get("name", tags.get("description", f"Unnamed {source_type}")),
        "source_type": source_type,
        "distance_m": round(dist, 1),
        "drinking_water": tags.get("drinking_water", "unknown"),
        "intermittent": tags.get("intermittent", "no") == "yes",
        "estimated_daily_flow_liters": SOURCE_FLOW_ESTIMATES.get(source_type, 1_000),
        "reliability_base": SOURCE_RELIABILITY.get(source_type, 0.50),
        "tags": tags,
    }


def _classify_source_type(tags: dict) -> str:
    for tag_match, source_type in _SOURCE_TYPE_RULES:
        if all(tags.get(k) == v for k, v in tag_match.items()):
            return source_type
    return "spring"   # default — most unmapped water nodes are springs


def _build_query(lat: float, lon: float, radius_m: int) -> str:
    return f"""
    [out:json][timeout:25];
    (
      node["natural"="spring"](around:{radius_m},{lat},{lon});
      node["amenity"="drinking_water"]["natural"="spring"](around:{radius_m},{lat},{lon});
    );
    out body;
    """


def _parse_element(element: dict, ref_lat: float, ref_lon: float) -> dict:
    tags = element.get("tags", {})
    dist = _haversine_m(ref_lat, ref_lon, element["lat"], element["lon"])
    return {
        "id": element["id"],
        "lat": element["lat"],
        "lon": element["lon"],
        "name": tags.get("name", tags.get("description", "Unnamed spring")),
        "distance_m": round(dist, 1),
        "drinking_water": tags.get("drinking_water", "unknown"),
        "flow": tags.get("flow_rate", tags.get("intermittent", "unknown")),
        "tags": tags,
    }


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6_371_000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _parse_int(value) -> int:
    try:
        return int(str(value).replace(",", "").replace(".", "").strip())
    except Exception:
        return 0
