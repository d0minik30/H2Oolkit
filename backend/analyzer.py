"""Master orchestrator: combines all processing modules into a single analysis result."""

from .weather import get_historical_precipitation
from .spring_detector import calculate_spring_probability
from .osm import search_osm_springs, search_osm_villages, search_all_water_sources
from .cost_estimator import estimate_infrastructure_cost
from .water_reserve import estimate_water_reserve
from .route_calculator import calculate_pipeline_route
from .elevation import get_elevation, get_elevations_batch
from .source_ranker import rank_water_sources


def analyze_spring_location(
    lat: float,
    lon: float,
    satellite_data: dict,
    nearest_village: dict | None = None,
) -> dict:
    """
    Full analysis of a candidate spring location.

    satellite_data must conform to the GEE data contract:
        ndvi_dry, ndvi_wet, soil_moisture_summer, jrc_occurrence,
        slope_degrees, elevation, catchment_area_km2, distance_to_river_m

    nearest_village (optional): {lat, lon, name, population}
      If not provided, OSM is queried automatically.

    Returns a flat analysis dict ready for API response and PDF generation.
    """
    # 1. Precipitation history
    weather = get_historical_precipitation(lat, lon, years=10)

    # 2. Spring probability
    spring = calculate_spring_probability(
        ndvi_dry=satellite_data["ndvi_dry"],
        ndvi_wet=satellite_data["ndvi_wet"],
        soil_moisture_summer=satellite_data["soil_moisture_summer"],
        jrc_occurrence=satellite_data["jrc_occurrence"],
        slope_degrees=satellite_data["slope_degrees"],
        elevation=satellite_data["elevation"],
        distance_to_river_m=satellite_data["distance_to_river_m"],
    )

    # 3. Water reserve
    reserve = estimate_water_reserve(
        catchment_area_km2=satellite_data["catchment_area_km2"],
        annual_recharge_mm=weather["estimated_recharge_mm"],
        precipitation_trend=weather["trend_mm_per_year"],
        spring_probability=spring["spring_probability"],
    )

    # 4. Resolve nearest village
    if nearest_village is None:
        villages = search_osm_villages(lat, lon, radius_m=15_000)
        nearest_village = villages[0] if villages else _default_village(lat, lon)

    village_lat = nearest_village.get("lat", lat)
    village_lon = nearest_village.get("lon", lon)
    village_population = nearest_village.get("population", 500)
    village_name = nearest_village.get("name", "Nearest village")

    # 5. Pipeline route
    route = calculate_pipeline_route(
        spring_lat=lat,
        spring_lon=lon,
        village_lat=village_lat,
        village_lon=village_lon,
        spring_elevation=satellite_data["elevation"],
        village_elevation=nearest_village.get("elevation", satellite_data["elevation"] - 20),
    )

    # 6. Infrastructure cost
    cost = estimate_infrastructure_cost(
        distance_to_village_km=route["terrain_adjusted_distance_km"],
        elevation_difference_m=route["elevation_difference_m"],
        village_population=village_population,
        daily_flow_liters=reserve["daily_flow_liters"],
    )

    # 7. Nearby known springs from OSM
    known_springs = search_osm_springs(lat, lon, radius_m=5_000)

    overall_confidence = _aggregate_confidence(
        spring["confidence"], weather["confidence"], reserve["confidence"]
    )
    overall_recommendation = _master_recommendation(spring, cost, reserve, route)

    return {
        "location": {"lat": lat, "lon": lon, "elevation": satellite_data["elevation"]},
        "village": {
            "name": village_name,
            "lat": village_lat,
            "lon": village_lon,
            "population": village_population,
        },
        "spring_analysis": spring,
        "weather": {
            "mean_annual_precipitation_mm": weather["mean_annual_precipitation_mm"],
            "estimated_recharge_mm": weather["estimated_recharge_mm"],
            "trend_mm_per_year": weather["trend_mm_per_year"],
            "confidence": weather["confidence"],
            "recommendation": weather["recommendation"],
            "fallback": weather.get("fallback", False),
        },
        "water_reserve": reserve,
        "route": route,
        "cost": cost,
        "known_springs_nearby": known_springs[:5],
        "overall_confidence": round(overall_confidence, 2),
        "recommendation": overall_recommendation,
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _aggregate_confidence(*values: float) -> float:
    return sum(values) / len(values)


def _master_recommendation(spring: dict, cost: dict, reserve: dict, route: dict) -> str:
    prob = spring["spring_probability"]
    feasibility = cost["feasibility"]
    flow = reserve["daily_flow_liters"]
    total_eur = cost["total_cost_eur"]
    grant = cost["pnrr_grant_eur"]

    if prob < 0.40:
        return (
            f"Spring probability is low ({prob:.0%}) — infrastructure investment not recommended "
            "without field confirmation using Galileo-guided survey."
        )

    if feasibility == "insufficient_supply":
        return (
            f"Spring probability is {prob:.0%} but estimated flow ({flow:,.0f} L/day) is insufficient. "
            "Consider combining with neighbouring springs before investing."
        )

    feed = "gravity-fed" if route["feed_type"] == "gravity" else "pumped"
    pnrr_note = (
        f" PNRR financing available: {grant:,.0f} EUR grant reduces village cost to "
        f"{cost['village_contribution_eur']:,.0f} EUR."
        if cost["pnrr_eligible"] else ""
    )

    return (
        f"Viable spring site ({prob:.0%} probability, {flow:,.0f} L/day estimated flow). "
        f"{feed.capitalize()} {route['terrain_adjusted_distance_km']:.1f} km pipeline to village. "
        f"Total infrastructure cost: {total_eur:,.0f} EUR.{pnrr_note}"
    )


def analyze_village_water_supply(
    village_lat: float,
    village_lon: float,
    village_population: int = 500,
    radius_m: int = 10_000,
    village_elevation: float | None = None,
    village_name: str = "Village",
) -> dict:
    """
    Village-centric analysis: find every water source within radius_m,
    look up their elevations, and rank them by supply efficiency.

    Efficiency weighs topography (gravity vs pumping) most heavily,
    then distance, reliability, and cost.  The best option is ranked #1.

    Returns a dict with ranked_sources, best_option, alternatives, and a
    plain-language recommendation ready for the frontend or PDF generator.
    """
    # 1. Village elevation — looked up if not provided
    if village_elevation is None:
        village_elevation = get_elevation(village_lat, village_lon)

    village = {
        "lat": village_lat,
        "lon": village_lon,
        "elevation": village_elevation,
        "population": village_population,
        "name": village_name,
    }

    # 2. Regional precipitation (single call — all sources in radius share it)
    weather = get_historical_precipitation(village_lat, village_lon, years=10)

    # 3. Discover all water bodies
    sources = search_all_water_sources(village_lat, village_lon, radius_m=radius_m)

    if not sources:
        return {
            "village": village,
            "sources_found": 0,
            "ranked_sources": [],
            "best_option": None,
            "alternatives": [],
            "weather": _weather_summary(weather),
            "overall_confidence": 0.20,
            "recommendation": (
                "No water sources found within the search radius. "
                "Consider expanding the radius or conducting a field survey."
            ),
        }

    # 4. Batch elevation lookup for all sources (one API call)
    points = [{"lat": s["lat"], "lon": s["lon"]} for s in sources]
    elevations = get_elevations_batch(points)
    for source, elev in zip(sources, elevations):
        source["elevation"] = elev if elev else village_elevation

    # 5. Rank by supply efficiency
    ranked = rank_water_sources(sources, village, weather)

    best = ranked[0] if ranked else None
    alternatives = ranked[1:4]  # up to 3 alternatives shown

    confidence = _village_confidence(ranked, weather)
    recommendation = _village_recommendation(best, alternatives, village_population, weather)

    return {
        "village": village,
        "sources_found": len(sources),
        "ranked_sources": ranked,
        "best_option": best,
        "alternatives": alternatives,
        "weather": _weather_summary(weather),
        "overall_confidence": round(confidence, 2),
        "recommendation": recommendation,
    }


# ---------------------------------------------------------------------------
# Village analysis helpers
# ---------------------------------------------------------------------------

def _weather_summary(weather: dict) -> dict:
    return {
        "mean_annual_precipitation_mm": weather["mean_annual_precipitation_mm"],
        "estimated_recharge_mm":        weather["estimated_recharge_mm"],
        "trend_mm_per_year":            weather["trend_mm_per_year"],
        "confidence":                   weather["confidence"],
        "fallback":                     weather.get("fallback", False),
    }


def _village_confidence(ranked: list, weather: dict) -> float:
    if not ranked:
        return 0.20
    # Average the top-3 efficiency scores as a proxy for how clearly one option dominates
    top_scores = [r["efficiency_score"] for r in ranked[:3]]
    avg_score = sum(top_scores) / len(top_scores)
    weather_conf = weather.get("confidence", 0.5)
    return (avg_score * 0.6 + weather_conf * 0.4)


def _village_recommendation(
    best: dict | None,
    alternatives: list,
    population: int,
    weather: dict,
) -> str:
    if best is None:
        return "No water sources found — field survey required."

    name     = best.get("name", "Best candidate")
    stype    = best["source_type"]
    method   = best["supply_method"]
    dist_km  = best["route"]["terrain_adjusted_distance_km"]
    cost_eur = best["cost"]["total_cost_eur"]
    contrib  = best["cost"]["village_contribution_eur"]
    flow     = best["estimated_daily_flow_liters"]
    elev_diff = best["route"]["elevation_difference_m"]
    pnrr     = best["cost"]["pnrr_eligible"]

    method_text = {
        "gravity_feed":             "gravity-fed — no pumping cost",
        "gravity_feed_low_pressure":"gravity-fed with low pressure",
        "pumped_low_lift":          f"pumped ({abs(elev_diff):.0f} m lift)",
        "pumped_medium_lift":       f"pumped ({abs(elev_diff):.0f} m lift)",
        "pumped_high_lift":         f"pumped ({abs(elev_diff):.0f} m lift — high ongoing energy cost)",
    }.get(method, method)

    trend = weather.get("trend_mm_per_year", 0)
    trend_note = ""
    if trend < -10:
        trend_note = " Note: local precipitation is declining — long-term flow may decrease."

    pnrr_note = (
        f" PNRR grant covers 85%; village contribution ~{contrib:,.0f} EUR."
        if pnrr else
        f" No PNRR eligibility — total cost {cost_eur:,.0f} EUR must be locally financed."
    )

    alt_note = ""
    if alternatives:
        alt_names = ", ".join(a.get("name", a["source_type"]) for a in alternatives[:2])
        alt_note = f" Viable alternatives: {alt_names}."

    return (
        f"Best option: {name} ({stype}), {dist_km:.1f} km away, {method_text}. "
        f"Estimated flow {flow:,.0f} L/day for {population} residents."
        f"{pnrr_note}{alt_note}{trend_note}"
    )


def _default_village(lat: float, lon: float) -> dict:
    return {
        "lat": lat,
        "lon": lon + 0.05,
        "name": "Nearest settlement (estimated)",
        "population": 300,
        "elevation": 0,
    }
