"""
Bridges the frontend spring-record format (`data/springs.json` +
`data/springs.geojson`) to the input contract expected by
`analyzer.analyze_spring_location()`.

Frontend record (merged from springs.json + springs.geojson):
    {
      id, name, region, reserve, confidence, distance_km,
      cost_eur, status, lat, lon, elevation_m, geology_type,
      drainage_basin, catchment_area_km2, nearest_village,
      land_cover, aquifer_depth_m,
      satellite: { sentinel1_sar_anomaly, sentinel2_ndwi,
                   dem_slope_deg, last_pass_utc, orbit_direction }
    }

Backend `satellite_data` contract:
    { ndvi_dry, ndvi_wet, soil_moisture_summer, jrc_occurrence,
      slope_degrees, elevation, catchment_area_km2, distance_to_river_m }
"""

import json
import os
from typing import Optional

_ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..'))
_SPRINGS_JSON   = os.path.join(_ROOT, 'data', 'springs.json')
_SPRINGS_GEOJSON = os.path.join(_ROOT, 'data', 'springs.geojson')


def load_springs() -> list[dict]:
    """
    Read springs.json + springs.geojson from disk, merge by id, and
    separate village-zone polygons. Mirrors js/data-bridge.js semantics
    so backend and frontend always see the same merged record.
    """
    with open(_SPRINGS_JSON, encoding='utf-8') as f:
        attrs = json.load(f)
    with open(_SPRINGS_GEOJSON, encoding='utf-8') as f:
        geojson = json.load(f)

    geo_index = {}
    village_zones = []
    for feature in geojson.get('features', []):
        props = feature.get('properties', {})
        ftype = props.get('feature_type')
        if ftype == 'village_zone':
            village_zones.append(feature)
            continue
        coords = feature.get('geometry', {}).get('coordinates', [None, None])
        geo_index[props.get('id')] = {
            'lat': coords[1],
            'lon': coords[0],
            **props,
        }

    merged = []
    for attr in attrs:
        geo = geo_index.get(attr['id'], {})
        merged.append({**attr, **geo})
    return merged, village_zones


def get_spring_by_id(spring_id: str) -> Optional[dict]:
    springs, _ = load_springs()
    return next((s for s in springs if s.get('id') == spring_id), None)


def get_village_zones() -> list[dict]:
    _, zones = load_springs()
    return zones


def spring_to_satellite_data(spring: dict) -> dict:
    """
    Translate a frontend spring record to the satellite_data dict
    expected by `analyze_spring_location`.

    Preferred sources (set by process_pipeline.py when extract_satellite.py has run):
      ndvi_dry  ← satellite.ndvi_dry   (Sep NDVI — actual dry-season vegetation index)
      ndvi_wet  ← satellite.ndvi_wet   (Jun NDVI — actual wet-season vegetation index)

    Fallback when actual NDVI is absent (older data files or no grid):
      ndvi_dry  ← sentinel2_ndwi       (NDWI approximates dry-season moisture)
      ndvi_wet  ← NDWI × 1.18         (wet-season vegetation typically ~18% higher)

    Other fields:
      soil_moisture_summer ← sentinel1_sar_anomaly (0–1, already normalised)
      jrc_occurrence       ← SAR anomaly × 100
      slope_degrees        ← dem_slope_deg
      elevation            ← elevation_m
      catchment_area_km2   ← catchment_area_km2
      distance_to_river_m  ← 500 m default (not stored in cached data)
    """
    sat = spring.get('satellite', {}) or {}
    ndwi = float(sat.get('sentinel2_ndwi') or 0.0)
    sar  = float(sat.get('sentinel1_sar_anomaly') or 0.0)
    slope = float(sat.get('dem_slope_deg') or 8.0)
    elevation = float(spring.get('elevation_m') or 0.0)
    catchment = float(spring.get('catchment_area_km2') or 5.0)

    # Use actual NDVI dry/wet when present; fall back to NDWI approximation
    ndvi_dry = float(sat.get('ndvi_dry') or ndwi or 0.0)
    ndvi_wet = float(sat.get('ndvi_wet') or (ndwi * 1.18) or 0.0)

    return {
        'ndvi_dry':            round(min(0.95, max(0.0, ndvi_dry)), 3),
        'ndvi_wet':            round(min(0.95, max(0.0, ndvi_wet)), 3),
        'soil_moisture_summer': round(min(1.0, max(0.0, sar)), 3),
        'jrc_occurrence':      round(min(100.0, max(0.0, sar * 100.0)), 1),
        'slope_degrees':       slope,
        'elevation':           elevation,
        'catchment_area_km2':  catchment,
        'distance_to_river_m': 500.0,
    }


def village_zone_to_dict(zone: dict) -> dict:
    """Convert a village_zone GeoJSON feature to a flat village dict."""
    p = zone.get('properties', {})
    coords = zone.get('geometry', {}).get('coordinates', [[]])[0]
    if not coords:
        return p
    lats = [c[1] for c in coords]
    lons = [c[0] for c in coords]
    return {
        **p,
        'lat': sum(lats) / len(lats),
        'lon': sum(lons) / len(lons),
        'name': p.get('village_name', 'Unknown'),
    }
