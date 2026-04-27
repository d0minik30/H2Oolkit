"""
Pipeline route calculation.

Distance
--------
Primary:  OSRM public routing API (foot profile) — follows actual OpenStreetMap
          paths, tracks, and trails through mountain terrain.  Returns real-world
          route distance and the path geometry for map visualisation.

Fallback: If OSRM is unreachable, times out, or returns an implausible route,
          falls back to Haversine straight-line × TERRAIN_FACTOR (1.25).

The OSRM foot profile is used (not car) because mountain pipelines in the
Carpathians follow hiking tracks and forest roads rather than paved roads.
"""

import logging
import math
import requests

log = logging.getLogger("h2oolkit.route")

EARTH_RADIUS_M  = 6_371_000.0
TERRAIN_FACTOR  = 1.25          # straight-line fallback multiplier
_OSRM_BASE      = "http://router.project-osrm.org/route/v1/foot"
_OSRM_TIMEOUT_S = 6             # per-request timeout
_OSRM_MAX_RATIO = 8.0           # if OSRM route > 8× straight-line, distrust it


def calculate_pipeline_route(
    spring_lat: float,
    spring_lon: float,
    village_lat: float,
    village_lon: float,
    spring_elevation: float,
    village_elevation: float,
) -> dict:
    """
    Estimate pipeline route parameters between spring and village.

    Returns straight-line distance, routed distance (OSRM or fallback),
    elevation delta, pipe sizing, and the route geometry as a list of
    [lat, lon] pairs for frontend map rendering.
    """
    straight_m = haversine_m(spring_lat, spring_lon, village_lat, village_lon)

    osrm = _fetch_osrm_route(spring_lat, spring_lon, village_lat, village_lon, straight_m)

    if osrm:
        routed_m      = osrm["distance_m"]
        route_geometry = osrm["geometry"]   # [[lat, lon], ...]
        routing_source = "osrm"
    else:
        routed_m      = straight_m * TERRAIN_FACTOR
        # Geometry: straight line with 4 intermediate waypoints
        route_geometry = _straight_waypoints(spring_lat, spring_lon, village_lat, village_lon)
        routing_source = "straight_line_estimate"

    routed_km = routed_m / 1_000.0

    elevation_diff_m = spring_elevation - village_elevation   # positive = gravity feed
    slope_pct = abs(elevation_diff_m) / max(straight_m, 1) * 100

    gravity_feed = elevation_diff_m > 0
    feed_type    = "gravity" if gravity_feed else "pumped"

    if routed_km <= 1.0:
        pipe_diameter_mm = 63
    elif routed_km <= 5.0:
        pipe_diameter_mm = 90
    else:
        pipe_diameter_mm = 110

    pressure_class = "PN10" if slope_pct < 5 else "PN16"

    return {
        "straight_line_distance_m":      round(straight_m, 1),
        "terrain_adjusted_distance_m":   round(routed_m, 1),
        "terrain_adjusted_distance_km":  round(routed_km, 3),
        "elevation_difference_m":        round(elevation_diff_m, 1),
        "slope_pct":                     round(slope_pct, 2),
        "feed_type":                     feed_type,
        "pipe_diameter_mm":              pipe_diameter_mm,
        "pressure_class":                pressure_class,
        "terrain_factor":                round(routed_m / max(straight_m, 1), 3),
        "routing_source":                routing_source,
        "route_geometry":                route_geometry,
        # kept for backward compatibility
        "waypoints":                     route_geometry,
        "confidence":                    0.85 if osrm else 0.60,
        "recommendation":                _recommendation(routed_km, elevation_diff_m, slope_pct, gravity_feed),
    }


# ── OSRM integration ──────────────────────────────────────────────────────────

def _fetch_osrm_route(
    lat1: float, lon1: float,
    lat2: float, lon2: float,
    straight_m: float,
) -> dict | None:
    """
    Call the OSRM public routing API (foot profile).

    Returns {"distance_m": float, "geometry": [[lat, lon], ...]} or None on failure.
    Geometry points are in [lat, lon] order (Leaflet-ready).
    """
    url = f"{_OSRM_BASE}/{lon1},{lat1};{lon2},{lat2}"
    params = {"overview": "full", "geometries": "geojson"}

    try:
        resp = requests.get(url, params=params, timeout=_OSRM_TIMEOUT_S)
        resp.raise_for_status()
        data = resp.json()

        if data.get("code") != "Ok" or not data.get("routes"):
            log.debug("OSRM returned no route for %.4f,%.4f → %.4f,%.4f", lat1, lon1, lat2, lon2)
            return None

        route     = data["routes"][0]
        distance_m = float(route["distance"])

        # Sanity check: if OSRM route is unrealistically long, discard it
        if straight_m > 0 and distance_m / straight_m > _OSRM_MAX_RATIO:
            log.warning(
                "OSRM route %.0f m is %.1f× straight-line — discarding",
                distance_m, distance_m / straight_m,
            )
            return None

        # GeoJSON coordinates are [lon, lat]; flip to [lat, lon] for Leaflet
        coords = route["geometry"]["coordinates"]
        geometry = [[pt[1], pt[0]] for pt in coords]

        log.debug(
            "OSRM route: %.0f m (%d points) vs straight-line %.0f m",
            distance_m, len(geometry), straight_m,
        )
        return {"distance_m": distance_m, "geometry": geometry}

    except requests.Timeout:
        log.warning("OSRM timed out for %.4f,%.4f → %.4f,%.4f", lat1, lon1, lat2, lon2)
    except Exception as exc:
        log.warning("OSRM request failed: %s", exc)

    return None


# ── Helpers ───────────────────────────────────────────────────────────────────

def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres between two WGS-84 points."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return EARTH_RADIUS_M * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _straight_waypoints(
    lat1: float, lon1: float,
    lat2: float, lon2: float,
    n_intermediate: int = 4,
) -> list:
    """Fallback geometry: straight line with intermediate points."""
    points = [[lat1, lon1]]
    for i in range(1, n_intermediate + 1):
        frac = i / (n_intermediate + 1)
        points.append([
            round(lat1 + (lat2 - lat1) * frac, 6),
            round(lon1 + (lon2 - lon1) * frac, 6),
        ])
    points.append([lat2, lon2])
    return points


def _recommendation(
    dist_km: float, elev_diff_m: float, slope_pct: float, gravity: bool
) -> str:
    parts = []

    if dist_km < 1:
        parts.append(f"Short route ({dist_km:.2f} km) — low pipeline cost.")
    elif dist_km < 5:
        parts.append(f"Moderate route length ({dist_km:.1f} km).")
    else:
        parts.append(f"Long route ({dist_km:.1f} km) — significant pipeline investment required.")

    if gravity:
        parts.append(f"Gravity-fed (spring is {elev_diff_m:.0f} m above village) — no pumping needed.")
    else:
        parts.append(
            f"Spring is {abs(elev_diff_m):.0f} m below village — pumping station required."
        )

    if slope_pct > 15:
        parts.append("Steep terrain may require pressure-reducing valves and anchored pipe sections.")

    return " ".join(parts)
