"""Pipeline route calculation: Haversine distance + elevation analysis."""

import math

EARTH_RADIUS_M = 6_371_000.0
TERRAIN_FACTOR = 1.25         # straight-line to actual route multiplier for mountain terrain


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

    Returns straight-line and terrain-adjusted distances, elevation delta,
    pipe sizing recommendation, and cost multipliers.
    """
    straight_m = haversine_m(spring_lat, spring_lon, village_lat, village_lon)
    terrain_adjusted_m = straight_m * TERRAIN_FACTOR
    terrain_adjusted_km = terrain_adjusted_m / 1_000.0

    elevation_diff_m = spring_elevation - village_elevation  # positive = gravity feed
    slope_pct = abs(elevation_diff_m) / max(straight_m, 1) * 100

    gravity_feed = elevation_diff_m > 0
    feed_type = "gravity" if gravity_feed else "pumped"

    # Pipe diameter recommendation based on typical village flow requirements
    if terrain_adjusted_km <= 1.0:
        pipe_diameter_mm = 63
    elif terrain_adjusted_km <= 5.0:
        pipe_diameter_mm = 90
    else:
        pipe_diameter_mm = 110

    # Pressure class — higher if pumped or steep gravity
    pressure_class = "PN10" if slope_pct < 5 else "PN16"

    waypoints = _intermediate_waypoints(spring_lat, spring_lon, village_lat, village_lon, n=4)

    recommendation = _recommendation(
        terrain_adjusted_km, elevation_diff_m, slope_pct, gravity_feed
    )

    return {
        "straight_line_distance_m": round(straight_m, 1),
        "terrain_adjusted_distance_m": round(terrain_adjusted_m, 1),
        "terrain_adjusted_distance_km": round(terrain_adjusted_km, 3),
        "elevation_difference_m": round(elevation_diff_m, 1),
        "slope_pct": round(slope_pct, 2),
        "feed_type": feed_type,
        "pipe_diameter_mm": pipe_diameter_mm,
        "pressure_class": pressure_class,
        "terrain_factor": TERRAIN_FACTOR,
        "waypoints": waypoints,
        "confidence": 0.70,
        "recommendation": recommendation,
    }


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Return great-circle distance in metres between two WGS-84 points."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return EARTH_RADIUS_M * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _intermediate_waypoints(
    lat1: float, lon1: float,
    lat2: float, lon2: float,
    n: int = 4,
) -> list[dict]:
    """Generate n evenly-spaced intermediate route points (for map rendering)."""
    points = []
    for i in range(1, n + 1):
        frac = i / (n + 1)
        points.append({
            "lat": round(lat1 + (lat2 - lat1) * frac, 6),
            "lon": round(lon1 + (lon2 - lon1) * frac, 6),
        })
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
