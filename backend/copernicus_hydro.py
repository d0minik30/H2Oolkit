"""
Local EU-Hydro GPKG integration.

Loads HYDRO/InlandWater (Romanian lakes/reservoirs) and HYDRO/River_Net_p
(river polygons) from backend/data/EU-Hydro.gpkg at first use, then caches
the GeoDataFrames in memory for fast spatial queries on subsequent requests.

Public API
----------
query_eu_hydro_sources(lat, lon, radius_m)   → list[dict]   lake/reservoir sources
annotate_sources_eu_hydro_link(sources, ...)  → list[dict]   adds eu_hydro_linked flag
get_distance_to_nearest_river_m(lat, lon)     → float | None
is_available()                                → bool
"""

import logging
import math
from pathlib import Path

log = logging.getLogger("h2oolkit.copernicus")

_GPKG_PATH   = Path(__file__).parent / "data" / "EU-Hydro.gpkg"
_LAYER_LAKES  = "HYDRO/InlandWater"
_LAYER_RIVERS = "HYDRO/River_Net_p"

_lakes_gdf  = None   # GeoDataFrame | False
_rivers_gdf = None   # GeoDataFrame | False


# ── Lazy loaders ──────────────────────────────────────────────────────────────

def _load_lakes():
    global _lakes_gdf
    if _lakes_gdf is not None:
        return _lakes_gdf
    try:
        import geopandas as gpd
        import warnings
        gdf = gpd.read_file(_GPKG_PATH, layer=_LAYER_LAKES)
        gdf = gdf[gdf.geometry.notna()].copy()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            gdf["centroid_lat"] = gdf.geometry.centroid.y
            gdf["centroid_lon"] = gdf.geometry.centroid.x
        _ = gdf.sindex  # build spatial index once
        _lakes_gdf = gdf
        log.info("EU-Hydro lakes loaded: %d features", len(gdf))
    except Exception as exc:
        log.warning("Failed to load EU-Hydro lakes: %s", exc)
        _lakes_gdf = False
    return _lakes_gdf


def _load_rivers():
    global _rivers_gdf
    if _rivers_gdf is not None:
        return _rivers_gdf
    try:
        import geopandas as gpd
        gdf = gpd.read_file(_GPKG_PATH, layer=_LAYER_RIVERS)
        gdf = gdf[gdf.geometry.notna()].copy()
        _ = gdf.sindex
        _rivers_gdf = gdf
        log.info("EU-Hydro river polygons loaded: %d features", len(gdf))
    except Exception as exc:
        log.warning("Failed to load EU-Hydro rivers: %s", exc)
        _rivers_gdf = False
    return _rivers_gdf


# ── Public helpers ────────────────────────────────────────────────────────────

def is_available() -> bool:
    """True if the lakes layer loaded successfully."""
    return _load_lakes() is not False


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def _lake_flow_liters(area_m2: float) -> float:
    """
    Conservative sustainable daily withdrawal estimate.
    Assumes 3 m average depth, 1 % annual volume turnover.
    """
    if area_m2 <= 0:
        return 5_000.0
    volume_m3 = area_m2 * 3
    daily = (volume_m3 * 0.01 / 365) * 1_000
    return round(min(max(daily, 5_000.0), 10_000_000.0), 1)


# ── Core query functions ──────────────────────────────────────────────────────

def query_eu_hydro_sources(lat: float, lon: float, radius_m: int) -> list:
    """
    Return EU-Hydro lake and reservoir sources whose polygon intersects a
    circle of radius_m metres centred on (lat, lon).

    Each result dict matches the OSM source dict contract expected by
    source_ranker.py and the rest of the analysis pipeline.
    """
    lakes = _load_lakes()
    if lakes is False:
        return []

    try:
        from shapely.geometry import Point

        point  = Point(lon, lat)
        deg_buf = radius_m / 111_000
        point_buf = point.buffer(deg_buf)

        candidates_idx = list(lakes.sindex.intersection(point_buf.bounds))
        if not candidates_idx:
            return []

        candidates  = lakes.iloc[candidates_idx]
        intersecting = candidates[candidates.geometry.intersects(point_buf)]

        results = []
        for _, row in intersecting.iterrows():
            clat       = float(row["centroid_lat"])
            clon       = float(row["centroid_lon"])
            dist       = _haversine_m(lat, lon, clat, clon)
            area_m2    = float(row.get("AREA")     or 0)
            altitude   = float(row.get("ALTITUDE") or 0)
            inspire_id = str(row.get("INSPIRE_ID") or row.get("OBJECTID") or "")

            raw_name = str(row.get("NAM")   or "")
            lakid    = str(row.get("LAKID") or "")
            _INVALID = {"UNK", "NA", "NAN", ""}
            if raw_name.upper() not in _INVALID:
                name = raw_name
            elif lakid.upper() not in _INVALID:
                name = f"Lake {lakid}"
            else:
                name = f"Unnamed lake ({inspire_id[-8:]})" if inspire_id else "Unnamed lake"

            lke_type = str(row.get("LKE_TYPE") or "U")
            if lke_type == "R":
                source_type      = "reservoir"
                reliability_base = 0.85
                type_label       = "reservoir"
            else:
                source_type      = "lake"
                reliability_base = 0.80 if lke_type == "N" else 0.70
                type_label       = "lake"

            results.append({
                "id":                         f"eu_hydro_{inspire_id}",
                "osm_type":                   "eu_hydro",
                "lat":                        round(clat, 6),
                "lon":                        round(clon, 6),
                "elevation":                  altitude if altitude > 0 else None,
                "name":                       name,
                "source_type":                source_type,
                "distance_m":                 round(dist, 1),
                "drinking_water":             "unknown",
                "intermittent":               False,
                "estimated_daily_flow_liters": _lake_flow_liters(area_m2),
                "reliability_base":           reliability_base,
                "eu_hydro_linked":            True,
                "eu_hydro_note":              (
                    f"EU-Hydro official {type_label} — "
                    f"area {area_m2 / 1_000_000:.3f} km²."
                ),
                "data_source": "eu_hydro",
                "tags": {
                    "lake_type":   lke_type,
                    "area_m2":     area_m2,
                    "eu_hydro_id": inspire_id,
                },
            })

        return results

    except Exception as exc:
        log.warning("EU-Hydro lake query failed: %s", exc)
        return []


def annotate_sources_eu_hydro_link(
    sources: list,
    link_distance_m: float = 150.0,
) -> list:
    """
    For every source whose ``eu_hydro_linked`` is not already set, check
    whether it lies within link_distance_m of an official EU-Hydro water
    body (lake polygon or river polygon).  Sets ``eu_hydro_linked`` (bool)
    and ``eu_hydro_note`` (str) on each source in-place.
    """
    lakes  = _load_lakes()
    rivers = _load_rivers()

    if lakes is False and rivers is False:
        for s in sources:
            if s.get("eu_hydro_linked") is None:
                s["eu_hydro_linked"] = None
                s["eu_hydro_note"]   = "EU-Hydro check skipped (GPKG unavailable)"
        return sources

    try:
        from shapely.geometry import Point

        link_deg = link_distance_m / 111_000

        for source in sources:
            if source.get("eu_hydro_linked") is not None:
                continue  # already set (EU-Hydro sources, or merged records)

            point = Point(source["lon"], source["lat"])
            buf   = point.buffer(link_deg)
            linked = False

            if lakes is not False:
                cands = list(lakes.sindex.intersection(buf.bounds))
                if cands and lakes.iloc[cands].geometry.intersects(buf).any():
                    linked = True

            if not linked and rivers is not False:
                cands = list(rivers.sindex.intersection(buf.bounds))
                if cands and rivers.iloc[cands].geometry.intersects(buf).any():
                    linked = True

            source["eu_hydro_linked"] = linked
            source["eu_hydro_note"]   = (
                "Within official EU-Hydro water body zone — likely already catalogued."
                if linked else
                "Not found in EU-Hydro official water network — potential undiscovered source."
            )

    except Exception as exc:
        log.warning("EU-Hydro annotation failed: %s", exc)

    return sources


def get_distance_to_nearest_river_m(lat: float, lon: float) -> float | None:
    """
    Distance in metres from (lat, lon) to the nearest EU-Hydro river polygon.
    Returns None if river data is unavailable.
    """
    rivers = _load_rivers()
    if rivers is False:
        return None

    try:
        from shapely.geometry import Point

        point    = Point(lon, lat)
        deg_50km = 50_000 / 111_000
        cands    = list(rivers.sindex.intersection([
            lon - deg_50km, lat - deg_50km,
            lon + deg_50km, lat + deg_50km,
        ]))
        if not cands:
            return None

        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            min_dist_deg = rivers.iloc[cands].geometry.distance(point).min()
        return round(float(min_dist_deg) * 111_000, 1)

    except Exception as exc:
        log.warning("River distance calculation failed: %s", exc)
        return None
