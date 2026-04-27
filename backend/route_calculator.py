"""
Pipeline route calculation.

Distance
--------
Uses 3D straight-line distance — the physically correct model for a buried
water pipeline that runs cross-terrain rather than following roads:

    3D distance = sqrt(horizontal_m² + elevation_diff_m²)

A terrain factor of 1.10 is then applied to account for the fact that
terrain is never perfectly flat between two points (slight detours around
gullies, rock outcrops, etc.).  This is intentionally conservative — pipelines
do NOT follow roads, so road-routing APIs like OSRM are wrong here and
systematically over-estimate by following winding valley roads.

Visualisation
-------------
The route is drawn as a straight dashed line on the map, which is the
standard cartographic convention for planned pipelines.
"""

import math

TERRAIN_FACTOR = 1.10   # 3D straight-line × this = installed pipe length


def calculate_pipeline_route(
    spring_lat: float,
    spring_lon: float,
    village_lat: float,
    village_lon: float,
    spring_elevation: float,
    village_elevation: float,
) -> dict:
    """
    Estimate pipeline route parameters between a water source and a village.

    Returns straight-line and terrain-adjusted distances, elevation delta,
    pipe sizing, feed type, and a straight-line geometry for map rendering.
    """
    horizontal_m     = haversine_m(spring_lat, spring_lon, village_lat, village_lon)
    elevation_diff_m = spring_elevation - village_elevation   # positive = gravity feed
    abs_elev         = abs(elevation_diff_m)

    # True 3D pipe length: diagonal through terrain
    distance_3d_m  = math.sqrt(horizontal_m ** 2 + abs_elev ** 2)
    routed_m       = distance_3d_m * TERRAIN_FACTOR
    routed_km      = routed_m / 1_000.0

    slope_pct      = abs_elev / max(horizontal_m, 1) * 100
    gravity_feed   = elevation_diff_m > 0
    feed_type      = "gravity" if gravity_feed else "pumped"

    if routed_km <= 1.0:
        pipe_diameter_mm = 63
    elif routed_km <= 5.0:
        pipe_diameter_mm = 90
    else:
        pipe_diameter_mm = 110

    pressure_class = "PN10" if slope_pct < 5 else "PN16"

    # Straight-line geometry for the map (pipelines are drawn as straight lines)
    geometry = _straight_waypoints(spring_lat, spring_lon, village_lat, village_lon)

    return {
        "straight_line_distance_m":     round(horizontal_m, 1),
        "terrain_adjusted_distance_m":  round(routed_m, 1),
        "terrain_adjusted_distance_km": round(routed_km, 3),
        "elevation_difference_m":       round(elevation_diff_m, 1),
        "slope_pct":                    round(slope_pct, 2),
        "feed_type":                    feed_type,
        "pipe_diameter_mm":             pipe_diameter_mm,
        "pressure_class":               pressure_class,
        "terrain_factor":               TERRAIN_FACTOR,
        "routing_source":               "3d_straight_line",
        "route_geometry":               geometry,
        "waypoints":                    geometry,   # backward compat
        "confidence":                   0.75,
        "recommendation":               _recommendation(
            routed_km, elevation_diff_m, slope_pct, gravity_feed
        ),
    }


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres between two WGS-84 points."""
    R = 6_371_000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _straight_waypoints(
    lat1: float, lon1: float,
    lat2: float, lon2: float,
    n: int = 4,
) -> list:
    """Straight-line geometry with n evenly-spaced intermediate points."""
    points = [[lat1, lon1]]
    for i in range(1, n + 1):
        frac = i / (n + 1)
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
        parts.append(
            f"Gravity-fed ({elev_diff_m:.0f} m above village) — no pumping needed."
        )
    else:
        parts.append(
            f"{abs(elev_diff_m):.0f} m below village — pumping station required."
        )

    if slope_pct > 15:
        parts.append(
            "Steep terrain — pressure-reducing valves and anchored pipe sections required."
        )

    return " ".join(parts)
