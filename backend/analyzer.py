"""Master orchestrator: combines all processing modules into a single analysis result."""

import logging
from .weather import get_historical_precipitation
from .spring_detector import calculate_spring_probability
from .osm import search_osm_springs, search_osm_villages, search_all_water_sources
from .cost_estimator import estimate_infrastructure_cost
from .water_reserve import estimate_water_reserve
from .route_calculator import calculate_pipeline_route, haversine_m
from .elevation import get_elevation, get_elevations_batch
from .source_ranker import rank_water_sources
from .satellite import get_gee_satellite_data
from .copernicus_hydro import (
    query_eu_hydro_sources,
    get_distance_to_nearest_river_m,
    annotate_sources_eu_hydro_link,
)
from .source_merger import merge_sources


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
    feasibility_score = _calculate_feasibility_score(spring, reserve, route, cost, satellite_data)

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
        "feasibility_score": round(feasibility_score, 1),
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
    pipe_km = cost["pipeline_km"]

    return (
        f"Viable spring site ({prob:.0%} probability, {flow:,.0f} L/day estimated flow). "
        f"{feed.capitalize()} pipeline to village: {pipe_km:.1f} km of pipe required."
    )


def _calculate_feasibility_score(
    spring: dict, reserve: dict, route: dict, cost: dict, satellite_data: dict
) -> float:
    """
    Calculate a feasibility score from 0 to 100 based on multiple factors.
    Higher score indicates more feasible project.
    """
    # Distance score: closer is better (max 100 for <1km, decreases linearly)
    dist_km = route["terrain_adjusted_distance_km"]
    score_distance = max(0, 100 - (dist_km - 1) * 20) if dist_km > 1 else 100

    # Slope score: lower slope is better for construction.
    # Coefficient 1.2 (not 2) — Carpathian mountain pipelines routinely run
    # on 20-40 % slopes; the old coefficient 2 unfairly penalised close-but-high
    # sources that are actually excellent gravity-feed candidates.
    slope_pct = route["slope_pct"]
    score_slope = max(0, 100 - slope_pct * 1.2)

    # Elevation score: above town level is best (gravity feed)
    elev_diff = route["elevation_difference_m"]
    if elev_diff > 0:
        score_elev = 100
    else:
        # Below town: penalty based on how much lower
        score_elev = max(0, 80 - abs(elev_diff) / 10 * 10)

    # Flow capacity score: higher flow is better
    flow_liters = reserve["daily_flow_liters"]
    score_flow = min(100, flow_liters / 50)  # 5000 L/day = 100

    # Debit estimation using satellite: approximate width from NDWI (wetness index)
    # Higher NDWI suggests wider water body
    ndwi = satellite_data.get("ndvi_wet", 0.5)  # Use wet NDVI as proxy
    estimated_width_m = max(0.5, ndwi * 20)  # Rough estimate: NDWI 0.5 -> 10m width
    # Average flow velocity ~0.5 m/s for streams, debit m3/s = width * depth * velocity
    # Assume depth ~0.3m for small streams
    estimated_debit_m3_day = estimated_width_m * 0.3 * 0.5 * 86400  # m3/day
    score_debit = min(100, estimated_debit_m3_day / 100)  # 8640 m3/day = 100

    # Pipeline distance score: shorter pipe run = simpler installation
    pipe_km = cost["pipeline_km"]
    score_materials = max(0, 100 - (pipe_km / 15) * 100)  # 15 km = score 0

    # Spring probability bonus
    spring_prob = spring["spring_probability"]
    score_spring = spring_prob * 100

    # Weighted average
    weights = {
        "distance": 0.15,
        "slope": 0.15,
        "elevation": 0.20,
        "flow": 0.15,
        "debit": 0.10,
        "materials": 0.10,
        "spring": 0.15,
    }

    total_score = (
        score_distance * weights["distance"] +
        score_slope * weights["slope"] +
        score_elev * weights["elevation"] +
        score_flow * weights["flow"] +
        score_debit * weights["debit"] +
        score_materials * weights["materials"] +
        score_spring * weights["spring"]
    )

    return min(100, max(0, total_score))


def analyze_village_water_supply(
    village_lat: float,
    village_lon: float,
    village_population: int = 500,
    radius_m: int = 10_000,
    village_elevation: float | None = None,
    village_name: str = "Village",
    include_feasibility: bool = True,
    search_lat: float | None = None,
    search_lon: float | None = None,
    search_radius_m: int | None = None,
) -> dict:
    """
    Village-centric analysis: find every water source within radius_m,
    look up their elevations, and rank them by supply efficiency.

    village_lat/lon  : the destination ("collection point") used for distance
                       and feasibility calculations (gravity vs pump, cost).
    search_lat/lon   : optional separate centre for source DISCOVERY. Defaults
                       to the village location. Use when the user searches a
                       location (the scan circle), then picks a collection
                       point inside that circle — sources should still be the
                       ones found around the original search centre.
    """
    sl = village_lat if search_lat is None else search_lat
    so = village_lon if search_lon is None else search_lon
    sr = radius_m    if search_radius_m is None else search_radius_m

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
    weather = get_historical_precipitation(sl, so, years=10)

    # 3. Discover OSM water bodies, keep usable types only, cap early so
    #    EU-Hydro annotation only runs on the candidates we will actually analyse.
    _USABLE_TYPES = {'spring', 'well', 'lake', 'reservoir', 'river', 'stream'}
    osm_sources = [
        s for s in search_all_water_sources(sl, so, radius_m=sr)
        if s.get('source_type') in _USABLE_TYPES
    ]
    osm_sources.sort(key=lambda s: s['distance_m'])
    osm_sources = osm_sources[:30]   # 2× buffer; dedup + ranker selects the best 15

    # 4. Discover EU-Hydro lake/reservoir sources from local GPKG
    eu_hydro_sources = query_eu_hydro_sources(sl, so, radius_m=sr)

    # 5. Merge OSM + EU-Hydro, deduplicating overlapping records
    sources = merge_sources(osm_sources, eu_hydro_sources)

    # 6. Annotate with official water-body proximity (~30 candidates only)
    sources = annotate_sources_eu_hydro_link(sources)

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

    # 7. Batch elevation lookup for all sources (one API call)
    points = [{"lat": s["lat"], "lon": s["lon"]} for s in sources]
    elevations = get_elevations_batch(points)
    for source, elev in zip(sources, elevations):
        source["elevation"] = elev if elev else village_elevation

    # Recompute distance from the COLLECTION POINT (village) so the ranker's
    # distance-score and route calculator both use the same reference.
    for source in sources:
        source["distance_m"] = round(
            haversine_m(village_lat, village_lon, source["lat"], source["lon"]), 1
        )

    # Keep only sources inside the scan circle (from the collection point)
    sources = [s for s in sources if s["distance_m"] <= sr]

    # 8. GEE satellite data — fetched ONCE for the search centre, reused for
    #    every source.  The old approach called GEE once per source, causing
    #    2-7 minute waits (15 sources x 6 serial .getInfo() round-trips each).
    #    NDVI, soil moisture and JRC vary gradually over a 7 km radius, so one
    #    centre reading is accurate enough.  Per-source overrides are applied
    #    below for elevation (Open-Topo-Data batch) and river distance (GPKG).
    log_analyzer = logging.getLogger('h2oolkit')
    try:
        center_sat = get_gee_satellite_data(sl, so)
        log_analyzer.info(
            "GEE satellite data fetched for centre (%.4f,%.4f) available=%s",
            sl, so, center_sat["available"],
        )
    except Exception as exc:
        log_analyzer.warning("GEE centre fetch failed, using defaults: %s", exc)
        center_sat = {
            "ndvi_dry": 0.35, "ndvi_wet": 0.50,
            "soil_moisture_summer": 0.40, "jrc_occurrence": 35.0,
            "slope_degrees": 8.0, "elevation": village_elevation,
            "distance_to_river_m": 500.0, "catchment_area_km2": 5.0,
            "available": False,
        }

    for source in sources:
        sat_data = dict(center_sat)
        sat_data["elevation"] = source.get("elevation") or center_sat["elevation"]

        local_river_dist = get_distance_to_nearest_river_m(source["lat"], source["lon"])
        if local_river_dist is not None:
            sat_data["distance_to_river_m"] = local_river_dist

        spring_prob = calculate_spring_probability(
            ndvi_dry=sat_data["ndvi_dry"],
            ndvi_wet=sat_data["ndvi_wet"],
            soil_moisture_summer=sat_data["soil_moisture_summer"],
            jrc_occurrence=sat_data["jrc_occurrence"],
            slope_degrees=sat_data["slope_degrees"],
            elevation=sat_data["elevation"],
            distance_to_river_m=sat_data["distance_to_river_m"],
        )

        # Confirmed EU-Hydro water bodies get a fixed high water-presence score
        if source.get("data_source") == "eu_hydro" and \
           source.get("source_type") in ("lake", "reservoir"):
            spring_prob["spring_probability"] = 0.85

        source["satellite_data"]   = sat_data
        source["spring_analysis"]  = spring_prob
        source["spring_probability"] = spring_prob["spring_probability"]
        source["gee_available"]    = center_sat["available"]

    # 9. Rank by supply efficiency (now includes spring probability component)
    ranked = rank_water_sources(sources, village, weather)

    # Add feasibility score to each ranked source
    for source in ranked:
        # Estimate reserve for this source
        reserve = estimate_water_reserve(
            catchment_area_km2=source.get("satellite_data", {}).get("catchment_area_km2", 5.0),
            annual_recharge_mm=weather["estimated_recharge_mm"],
            precipitation_trend=weather["trend_mm_per_year"],
            spring_probability=source.get("spring_probability", 0.5),
        )
        source["water_reserve"] = reserve
        if include_feasibility:
            source["feasibility_score"] = round(_calculate_feasibility_score(
                source.get("spring_analysis", {"spring_probability": 0.5, "confidence": 0.5}),
                reserve,
                source["route"],
                source["cost"],
                source.get("satellite_data", {})
            ), 1)

    # Show only the top 15 sources
    ranked = ranked[:15]

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

    name      = best.get("name", "Best candidate")
    stype     = best["source_type"]
    method    = best["supply_method"]
    dist_km   = best["route"]["terrain_adjusted_distance_km"]
    pipe_km   = best["cost"]["pipeline_km"]
    flow      = best["estimated_daily_flow_liters"]
    elev_diff = best["route"]["elevation_difference_m"]

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

    pipe_note = f" Pipeline required: {pipe_km:.1f} km of pipe."

    alt_note = ""
    if alternatives:
        alt_names = ", ".join(a.get("name", a["source_type"]) for a in alternatives[:2])
        alt_note = f" Viable alternatives: {alt_names}."

    return (
        f"Best option: {name} ({stype}), {dist_km:.1f} km away, {method_text}. "
        f"Estimated flow {flow:,.0f} L/day for {population} residents."
        f"{pipe_note}{alt_note}{trend_note}"
    )


def _default_village(lat: float, lon: float) -> dict:
    return {
        "lat": lat,
        "lon": lon + 0.05,
        "name": "Nearest settlement (estimated)",
        "population": 300,
        "elevation": 0,
    }