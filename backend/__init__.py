"""H2Oolkit backend — real-time water source detection and feasibility analysis.

All static/mock data has been removed. Source discovery is performed live via
OpenStreetMap (Overpass API) and EU-Hydro (Google Earth Engine), and feasibility
is calculated per user-chosen collection point.
"""

from .weather import get_historical_precipitation
from .spring_detector import calculate_spring_probability
from .osm import search_osm_springs, search_all_water_sources
from .elevation import get_elevation, get_elevations_batch
from .cost_estimator import estimate_infrastructure_cost
from .water_reserve import estimate_water_reserve
from .route_calculator import calculate_pipeline_route
from .source_ranker import rank_water_sources
from .analyzer import analyze_spring_location, analyze_village_water_supply

__all__ = [
    "get_historical_precipitation",
    "calculate_spring_probability",
    "search_osm_springs",
    "search_all_water_sources",
    "get_elevation",
    "get_elevations_batch",
    "estimate_infrastructure_cost",
    "estimate_water_reserve",
    "calculate_pipeline_route",
    "rank_water_sources",
    "analyze_spring_location",
    "analyze_village_water_supply",
]
