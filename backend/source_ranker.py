"""
Ranks water sources by how efficiently each could supply a given village.

Efficiency score = weighted sum of scoring components:

  spring_probability (20%) — satellite-derived probability of persistent water
  topography         (30%) — is the source above the village? gravity feed is far
                             cheaper and more reliable than pumping
  distance           (20%) — shorter pipeline = lower cost + less head loss
  reliability        (15%) — perennial river > seasonal stream > uncertain spring
  cost_efficiency    (15%) — shorter pipeline km scores higher (normalised)

Spring probability is satellite-derived from NDVI, soil moisture, JRC water
occurrence, topography, and distance to rivers. Topography is still dominant
for cost calculation (pumping vs gravity), but satellite data now drives
source discovery confidence.
"""

import numpy as np
from .route_calculator import calculate_pipeline_route
from .cost_estimator import estimate_infrastructure_cost

_WEIGHTS = {
    "spring_probability": 0.20,
    "topography":         0.30,
    "distance":           0.20,
    "reliability":        0.15,
    "cost_efficiency":    0.15,
}

# How intermittent sources are penalised on their reliability score
_INTERMITTENT_PENALTY = 0.20

# Small bonus applied to springs not found in the official EU-Hydro network
_EU_HYDRO_UNLINKED_BONUS = 0.05


def rank_water_sources(
    sources: list,
    village: dict,
    weather_data: dict,
) -> list:
    """
    Score and rank every source against the given village.

    sources      : list from osm.search_all_water_sources(), each must have
                   an `elevation` key (filled by elevation.py before this call).
                   May also contain EU-Hydro sources merged in by analyzer.py.
                   Each source may optionally carry:
                       eu_hydro_linked  : bool | None
                       eu_hydro_note    : str  | None
    village      : {lat, lon, elevation, population}
    weather_data : result from weather.get_historical_precipitation()

    Returns the same list sorted descending by efficiency_score, with
    route, cost, scores, supply_method, discovery_priority, rank, and
    recommendation added to every entry.
    """
    if not sources:
        return []

    village_lat  = village["lat"]
    village_lon  = village["lon"]
    village_elev = village.get("elevation", 0.0)
    population   = village.get("population", 500)
    annual_recharge_mm = weather_data.get("estimated_recharge_mm", 85.0)

    enriched = []
    for source in sources:
        source_elev = source.get("elevation") or village_elev

        route = calculate_pipeline_route(
            spring_lat=source["lat"],
            spring_lon=source["lon"],
            village_lat=village_lat,
            village_lon=village_lon,
            spring_elevation=source_elev,
            village_elevation=village_elev,
        )

        daily_flow = _estimate_daily_flow(
            source["source_type"],
            annual_recharge_mm,
            source.get("intermittent", False),
        )

        cost = estimate_infrastructure_cost(
            distance_to_village_km=route["terrain_adjusted_distance_km"],
            elevation_difference_m=route["elevation_difference_m"],
            village_population=population,
            daily_flow_liters=daily_flow,
        )

        topo_score = _topo_score(route["elevation_difference_m"])
        dist_score = _distance_score(source["distance_m"])
        rel_score  = _reliability_score(
            source["reliability_base"],
            source.get("intermittent", False),
        )
        # Spring probability score — comes from satellite data analysis
        spring_prob_score = source.get("spring_probability", 0.5)

        enriched.append({
            **source,
            "elevation": source_elev,
            "route": route,
            "cost": cost,
            "estimated_daily_flow_liters": round(daily_flow, 1),
            "supply_method": _supply_method(route["elevation_difference_m"]),
            "scores": {
                "spring_probability": round(spring_prob_score, 3),
                "topography":         round(topo_score, 3),
                "distance":           round(dist_score, 3),
                "reliability":        round(rel_score, 3),
                "cost_efficiency":    0.0,  # filled after normalisation below
            },
            # Preserve EU-Hydro fields if present, default to None if absent
            "eu_hydro_linked": source.get("eu_hydro_linked"),
            "eu_hydro_note":   source.get("eu_hydro_note"),
        })

    # Cost efficiency: shorter pipeline scores higher (normalised across candidate set).
    pipe_kms = [e["cost"]["pipeline_km"] for e in enriched]
    max_pipe  = max(pipe_kms) if pipe_kms else 1.0
    min_pipe  = min(pipe_kms) if pipe_kms else 0.0
    pipe_range = max(max_pipe - min_pipe, 0.01)

    for e in enriched:
        cost_score = 1.0 - (e["cost"]["pipeline_km"] - min_pipe) / pipe_range
        e["scores"]["cost_efficiency"] = round(cost_score, 3)

        base_score = (
            _WEIGHTS["spring_probability"] * e["scores"]["spring_probability"]
            + _WEIGHTS["topography"]       * e["scores"]["topography"]
            + _WEIGHTS["distance"]         * e["scores"]["distance"]
            + _WEIGHTS["reliability"]      * e["scores"]["reliability"]
            + _WEIGHTS["cost_efficiency"]  * e["scores"]["cost_efficiency"]
        )

        # Boost springs that are NOT in the official EU-Hydro water network —
        # these are undiscovered/informal sources worth surfacing to the user.
        if e.get("eu_hydro_linked") is False:
            base_score = min(1.0, base_score + _EU_HYDRO_UNLINKED_BONUS)
            e["discovery_priority"] = "high"
        elif e.get("eu_hydro_linked") is True:
            e["discovery_priority"] = "low"      # already catalogued
        else:
            e["discovery_priority"] = "unknown"  # GEE unavailable or not checked

        e["efficiency_score"] = round(base_score, 3)

    enriched.sort(key=lambda x: x["efficiency_score"], reverse=True)

    for rank, entry in enumerate(enriched, start=1):
        entry["rank"] = rank
        entry["recommendation"] = _source_recommendation(entry, population)

    return enriched


# ---------------------------------------------------------------------------
# Sub-score functions — each returns 0.0–1.0
# ---------------------------------------------------------------------------

def _topo_score(elevation_diff_m: float) -> float:
    """
    elevation_diff = source_elevation - village_elevation.
    Positive = source is above village = gravity feed possible.
    """
    if elevation_diff_m >= 50:
        # Ideal gravity zone: good pressure, no pump needed.
        # Slightly reduce score above 200 m because pressure-reduction valves add cost.
        return float(np.clip(1.0 - max(elevation_diff_m - 200, 0) / 500, 0.80, 1.0))
    if elevation_diff_m >= 10:
        # Marginal gravity — enough head for slow gravity feed
        return 0.65 + 0.15 * (elevation_diff_m - 10) / 40
    if elevation_diff_m >= 0:
        # Essentially flat — gravity-feed pressure is very low, booster may be needed
        return 0.50 + 0.15 * (elevation_diff_m / 10)
    if elevation_diff_m >= -50:
        # Shallow pump: extra capital cost + ongoing electricity
        return 0.50 - 0.20 * (abs(elevation_diff_m) / 50)
    if elevation_diff_m >= -150:
        # Medium pump: significant lift
        return 0.30 - 0.15 * (abs(elevation_diff_m) - 50) / 100
    # Deep pump: very costly
    return float(np.clip(0.15 - (abs(elevation_diff_m) - 150) / 500, 0.0, 0.15))


def _distance_score(distance_m: float) -> float:
    """Shorter distance = cheaper pipeline, less head loss."""
    if distance_m <= 300:
        return 1.0
    if distance_m <= 1_000:
        return 1.0 - 0.15 * (distance_m - 300) / 700
    if distance_m <= 3_000:
        return 0.85 - 0.25 * (distance_m - 1_000) / 2_000
    if distance_m <= 7_000:
        return 0.60 - 0.35 * (distance_m - 3_000) / 4_000
    if distance_m <= 15_000:
        return 0.25 - 0.20 * (distance_m - 7_000) / 8_000
    return max(0.0, 0.05 - (distance_m - 15_000) / 50_000)


def _reliability_score(base: float, intermittent: bool) -> float:
    """Year-round water availability."""
    score = base
    if intermittent:
        score -= _INTERMITTENT_PENALTY
    return float(np.clip(score, 0.0, 1.0))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _estimate_daily_flow(
    source_type: str,
    annual_recharge_mm: float,
    intermittent: bool,
) -> float:
    """
    Rough daily flow estimate anchored to local precipitation.

    Uses a proxy catchment area per source type and the water_reserve
    formula (recharge × catchment × runoff × safety factor).
    """
    proxy_catchment_km2 = {
        "river":  80.0,
        "stream":  8.0,
        "lake":   40.0,
        "spring":  1.5,
        "well":    0.3,
    }.get(source_type, 1.0)

    catchment_m2 = proxy_catchment_km2 * 1_000_000
    # Same formula as water_reserve: recharge × runoff(0.25) × safety(0.70)
    annual_m3 = catchment_m2 * (annual_recharge_mm / 1000) * 0.25 * 0.70
    daily_liters = (annual_m3 / 365) * 1000

    if intermittent:
        daily_liters *= 0.40   # available only part of the year

    return max(100.0, round(daily_liters, 1))


def _supply_method(elevation_diff_m: float) -> str:
    if elevation_diff_m >= 10:
        return "gravity_feed"
    if elevation_diff_m >= 0:
        return "gravity_feed_low_pressure"
    if elevation_diff_m >= -50:
        return "pumped_low_lift"
    if elevation_diff_m >= -150:
        return "pumped_medium_lift"
    return "pumped_high_lift"


def _source_recommendation(entry: dict, population: int) -> str:
    name        = entry.get("name", "This source")
    stype       = entry["source_type"]
    method      = entry["supply_method"]
    flow        = entry["estimated_daily_flow_liters"]
    pipe_km     = entry["cost"]["pipeline_km"]
    feasibility = entry["cost"]["feasibility"]
    dist_km     = entry["route"]["terrain_adjusted_distance_km"]
    score       = entry["efficiency_score"]
    elev_diff   = entry["route"]["elevation_difference_m"]
    discovery   = entry.get("discovery_priority", "unknown")
    eu_note     = entry.get("eu_hydro_note", "")

    method_labels = {
        "gravity_feed":             "gravity-fed (no pump required)",
        "gravity_feed_low_pressure":"gravity-fed with low pressure (booster may help)",
        "pumped_low_lift":          f"pumped ({abs(elev_diff):.0f} m lift)",
        "pumped_medium_lift":       f"pumped ({abs(elev_diff):.0f} m lift — significant energy cost)",
        "pumped_high_lift":         f"pumped ({abs(elev_diff):.0f} m lift — high energy cost)",
    }
    method_text = method_labels.get(method, method)

    if feasibility == "insufficient_supply":
        feasibility_note = (
            f" Flow ({flow:,.0f} L/day) is insufficient for village demand alone"
            " — consider combining sources."
        )
    elif feasibility == "marginal":
        feasibility_note = (
            f" Flow ({flow:,.0f} L/day) covers partial demand"
            " — supplement with a second source."
        )
    else:
        feasibility_note = f" Estimated flow ({flow:,.0f} L/day) meets village demand."

    pipeline_note = f" Pipeline required: {pipe_km:.1f} km."

    # Discovery note for EU-Hydro unlinked springs
    discovery_note = ""
    if discovery == "high":
        discovery_note = " ⚑ Undiscovered source — not in official EU-Hydro network; field survey recommended."
    elif eu_note:
        discovery_note = f" {eu_note}"

    return (
        f"Rank #{entry['rank']} (score {score:.2f}): {name} — {stype}, "
        f"{dist_km:.1f} km, {method_text}."
        f"{feasibility_note}{pipeline_note}{discovery_note}"
    )