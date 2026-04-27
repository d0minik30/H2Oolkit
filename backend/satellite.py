"""
Google Earth Engine — satellite data layer.

Fetches per-location satellite signals used by spring_detector.py
to calculate spring probability scores:

    NDVI dry/wet   — Sentinel-2 vegetation index (dry Sep vs wet Jun)
    Soil moisture  — NASA GLDAS summer average
    JRC occurrence — JRC Global Surface Water long-term persistence
    Elevation      — USGS SRTM 30 m
    Slope          — derived from SRTM

Distance to nearest river is intentionally NOT fetched here — it is
computed from the local EU-Hydro GPKG via copernicus_hydro.py, which
is more accurate and works without a GEE account.

Authentication
--------------
Run once in a terminal before starting the server:
    earthengine authenticate
Credentials are stored at ~/.config/earthengine/credentials (never in
this repository).  Set the optional GEE_PROJECT env var to scope the
session to a specific Google Cloud project.
"""

import logging
import os

log = logging.getLogger("h2oolkit.satellite")

_ee = None   # cached GEE module; False = tried and failed


def _get_ee():
    global _ee
    if _ee is not None:
        return _ee
    try:
        import ee
        project = os.environ.get("GEE_PROJECT") or None
        if project:
            ee.Initialize(project=project)
        else:
            ee.Initialize()
        _ee = ee
        log.info("Google Earth Engine initialised")
    except Exception as exc:
        log.warning("GEE unavailable — satellite data will use regional defaults: %s", exc)
        _ee = False
    return _ee


def get_gee_satellite_data(lat: float, lon: float) -> dict:
    """
    Fetch satellite signals for a single coordinate from GEE.

    Returns a dict with keys:
        ndvi_dry, ndvi_wet, soil_moisture_summer, jrc_occurrence,
        slope_degrees, elevation, distance_to_river_m,
        catchment_area_km2, available (bool)

    Falls back to realistic Carpathian defaults when GEE is unavailable.
    distance_to_river_m is always the fallback default (500 m) — the
    caller in analyzer.py overrides it with the accurate local GPKG value.
    """
    ee = _get_ee()
    if not ee:
        return _carpathian_defaults()

    try:
        point = ee.Geometry.Point([lon, lat])

        # NDVI — Sentinel-2 dry season (Sep) vs wet season (Jun), 2023
        ndvi_dry_img = (
            ee.ImageCollection("COPERNICUS/S2_HARMONIZED")
            .filterBounds(point)
            .filterDate("2023-09-01", "2023-09-30")
            .filterMetadata("CLOUDY_PIXEL_PERCENTAGE", "less_than", 20)
            .select(["B4", "B8"])
            .map(lambda img: img.normalizedDifference(["B8", "B4"]).rename("NDVI"))
            .mean()
        )
        ndvi_wet_img = (
            ee.ImageCollection("COPERNICUS/S2_HARMONIZED")
            .filterBounds(point)
            .filterDate("2023-06-01", "2023-06-30")
            .filterMetadata("CLOUDY_PIXEL_PERCENTAGE", "less_than", 20)
            .select(["B4", "B8"])
            .map(lambda img: img.normalizedDifference(["B8", "B4"]).rename("NDVI"))
            .mean()
        )
        ndvi_dry = ndvi_dry_img.sample(point, 30).first().get("NDVI").getInfo()
        ndvi_wet = ndvi_wet_img.sample(point, 30).first().get("NDVI").getInfo()
        ndvi_dry = float(ndvi_dry) if ndvi_dry is not None else 0.35
        ndvi_wet = float(ndvi_wet) if ndvi_wet is not None else 0.50

        # Soil moisture — NASA GLDAS, Jun–Aug 2023 average
        soil_img = (
            ee.ImageCollection("NASA/GLDAS/V021/NOAH/G025/T3H")
            .filterBounds(point)
            .filterDate("2023-06-01", "2023-08-31")
            .select("SoilMoist_s")
            .mean()
        )
        soil = soil_img.sample(point, 1000).first().get("SoilMoist_s").getInfo()
        soil_moisture = float(soil) if soil is not None else 0.40

        # JRC Global Surface Water — long-term occurrence (0–100 %)
        jrc_img = ee.Image("JRC/GSW1_4/GlobalSurfaceWater").select("occurrence")
        jrc_occ = jrc_img.sample(point, 30).first().get("occurrence").getInfo()
        jrc_occurrence = float(jrc_occ) if jrc_occ is not None else 35.0

        # Elevation + slope — USGS SRTM 30 m
        elev_img  = ee.Image("USGS/SRTMGL1_Ellip/SRTMGL1_Ellip_srtm")
        slope_img = ee.Terrain.slope(elev_img)
        elevation    = elev_img.sample(point, 30).first().get("elevation").getInfo()
        slope        = slope_img.sample(point, 30).first().get("slope").getInfo()
        elevation    = float(elevation) if elevation is not None else 500.0
        slope_degrees = float(slope)   if slope     is not None else 8.0

        return {
            "ndvi_dry":              round(max(-1.0, min(1.0, ndvi_dry)),      3),
            "ndvi_wet":              round(max(-1.0, min(1.0, ndvi_wet)),      3),
            "soil_moisture_summer":  round(max(0.0,  min(1.0, soil_moisture)), 3),
            "jrc_occurrence":        round(max(0.0,  min(100.0, jrc_occurrence)), 1),
            "slope_degrees":         round(max(0.0, slope_degrees), 1),
            "elevation":             round(elevation, 1),
            "distance_to_river_m":   500.0,   # overridden by copernicus_hydro in analyzer.py
            "catchment_area_km2":    5.0,
            "available":             True,
        }

    except Exception as exc:
        log.warning("GEE satellite fetch failed for %.4f,%.4f: %s", lat, lon, exc)
        return _carpathian_defaults()


def _carpathian_defaults() -> dict:
    """
    Regional defaults used when GEE is unavailable.
    jrc_occurrence=35 (not 20) keeps it above the 30 % threshold in
    spring_detector so the JRC signal contributes rather than zeroing out.
    """
    return {
        "ndvi_dry":             0.35,
        "ndvi_wet":             0.50,
        "soil_moisture_summer": 0.40,
        "jrc_occurrence":       35.0,
        "slope_degrees":        8.0,
        "elevation":            500.0,
        "distance_to_river_m":  500.0,
        "catchment_area_km2":   5.0,
        "available":            False,
    }
