# H2Oolkit Backend System - Complete Implementation Guide

## System Overview

Your H2Oolkit backend now works seamlessly end-to-end with the following flow:

```
User Input (location name or coordinates)
    ↓
Geocode location → lat/lon (if name provided)
    ↓
10 KM RADIUS ANALYSIS
    ├─ Weather: Get 10-year precipitation/ET data (Open-Meteo)
    │
    ├─ STEP 1: EU Hydro Database Query (Google Earth Engine)
    │  └─ Query official rivers, lakes, documented springs
    │
    ├─ STEP 2: OpenStreetMap Search
    │  └─ Find all mapped water sources (springs, wells, rivers, streams, lakes)
    │
    ├─ STEP 3: EU Hydro Cross-Reference
    │  └─ Annotate OSM sources with EU Hydro linkage status
    │  └─ Add EU Hydro sources not in OSM (undocumented/unlinked springs)
    │
    ├─ STEP 4: GEE Satellite Data Analysis (for each source)
    │  ├─ NDVI dry season (September)
    │  ├─ NDVI wet season (June)
    │  ├─ Soil moisture (summer average)
    │  ├─ JRC water occurrence (long-term water surface)
    │  ├─ Topography (slope degrees)
    │  ├─ Elevation (SRTM 30m)
    │  └─ Distance to nearest river
    │
    ├─ STEP 5: Spring Probability Calculation
    │  └─ Multi-criteria scoring using satellite data
    │  └─ Weights: NDVI 35%, soil moisture 30%, JRC 20%, topography 15%
    │
    └─ STEP 6: Source Ranking
       ├─ Calculate pipeline routes and costs
       ├─ Rank by efficiency: spring probability (20%), topography (30%), 
       │  distance (20%), reliability (15%), cost efficiency (15%)
       └─ Return ranked sources with all analysis data
    ↓
RETURN DATA TO FRONTEND
    ├─ Village info (location, elevation, population)
    ├─ Ranked water sources (best option + alternatives)
    ├─ Satellite data per source
    ├─ Spring probability and confidence
    ├─ Cost analysis and supply method
    ├─ EU Hydro linkage status
    ├─ Weather data (precipitation trends)
    └─ Overall recommendation and confidence score
```

---

## Key Configuration Changes

### ✅ CHANGE 1: Default Radius → 10 km (10,000 m)

**File:** `backend/server.py`

**Before:**
```python
radius_m = int(body.get('radius_m', 5_000))  # 5 km
```

**After:**
```python
radius_m = int(body.get('radius_m', 10_000))  # 10 km ✓
```

---

## New Features Added

### ✅ FEATURE 1: GEE Satellite Data Fetching

**File:** `backend/eu_hydro.py` (NEW FUNCTION)

```python
def get_gee_satellite_data(lat: float, lon: float) -> dict
```

Fetches from Google Earth Engine:
- **NDVI Dry (September):** Vegetation index dry season
- **NDVI Wet (June):** Vegetation index wet season
- **Soil Moisture:** Summer average (NASA GLDAS)
- **JRC Water Occurrence:** Long-term water surface (0-100%)
- **Slope:** Degrees derived from SRTM DEM
- **Elevation:** SRTM 30m resolution
- **Distance to River:** Nearest EU-Hydro river

Returns realistic **Carpathian defaults** if GEE unavailable:
```python
{
    "ndvi_dry": 0.35,
    "ndvi_wet": 0.50,
    "soil_moisture_summer": 0.40,
    "jrc_occurrence": 20.0,
    "slope_degrees": 8.0,
    "elevation": 500.0,
    "distance_to_river_m": 500.0,
    "available": True/False  # GEE status
}
```

### ✅ FEATURE 2: Per-Source Spring Probability Calculation

**File:** `backend/analyzer.py` (NEW CODE IN `analyze_village_water_supply`)

For each discovered water source:

1. **Fetch satellite data** via `get_gee_satellite_data()`
2. **Calculate spring probability** via `calculate_spring_probability()`
3. **Store results** in source object:
   ```python
   source["satellite_data"]      # Raw GEE data
   source["spring_analysis"]     # Full probability analysis
   source["spring_probability"]  # 0-1 score
   source["gee_available"]       # GEE availability flag
   ```

### ✅ FEATURE 3: Updated Ranking Scores

**File:** `backend/source_ranker.py`

**New scoring weights:**
```python
_WEIGHTS = {
    "spring_probability": 0.20,  # NEW! Satellite-derived discovery confidence
    "topography":         0.30,  # Gravity vs pumping
    "distance":           0.20,  # Pipeline length
    "reliability":        0.15,  # Perennial vs seasonal
    "cost_efficiency":    0.15,  # Infrastructure cost
}
```

**Score components included:**
```python
"scores": {
    "spring_probability": 0.45,  # From satellite analysis
    "topography": 0.72,
    "distance": 0.68,
    "reliability": 0.60,
    "cost_efficiency": 0.55,
}
"efficiency_score": 0.58  # Weighted average
```

---

## Data Sent to Frontend

### Complete Response Structure

```json
{
  "village": {
    "name": "Test Village",
    "lat": 45.1,
    "lon": 26.0,
    "elevation": 245.5,
    "population": 500
  },
  "sources_found": 8,
  "ranked_sources": [
    {
      "id": "osm_12345",
      "name": "Spring at Vrajei",
      "source_type": "spring",
      "lat": 45.15,
      "lon": 25.98,
      "elevation": 520.3,
      "distance_m": 8234.5,
      
      "satellite_data": {
        "ndvi_dry": 0.42,
        "ndvi_wet": 0.58,
        "soil_moisture_summer": 0.48,
        "jrc_occurrence": 22.5,
        "slope_degrees": 14.2,
        "elevation": 520.3,
        "distance_to_river_m": 280.0,
        "catchment_area_km2": 5.0,
        "available": true
      },
      
      "spring_analysis": {
        "spring_probability": 0.68,
        "confidence": 0.76,
        "signal_scores": {
          "vegetation_anomaly": 0.55,
          "soil_moisture": 0.62,
          "jrc_water_history": 0.48,
          "topography": 0.71
        },
        "dominant_signal": "topography",
        "river_penalty_applied": 0.05,
        "recommendation": "Likely persistent spring source..."
      },
      
      "spring_probability": 0.68,
      "gee_available": true,
      
      "scores": {
        "spring_probability": 0.68,
        "topography": 0.72,
        "distance": 0.65,
        "reliability": 0.75,
        "cost_efficiency": 0.58
      },
      "efficiency_score": 0.67,
      "rank": 1,
      
      "eu_hydro_linked": false,
      "eu_hydro_note": "Not found in EU-Hydro official water network...",
      
      "route": {
        "terrain_adjusted_distance_km": 8.9,
        "elevation_difference_m": 275.2,
        "feed_type": "pumped_medium_lift"
      },
      
      "cost": {
        "total_cost_eur": 125000,
        "pipeline_cost_eur": 83500,
        "pump_cost_eur": 24700,
        "treatment_cost_eur": 16800,
        "pnrr_eligible": true,
        "pnrr_grant_eur": 106250,
        "village_contribution_eur": 18750
      },
      
      "estimated_daily_flow_liters": 4200.5,
      "supply_method": "pumped_medium_lift",
      "discovery_priority": "high",
      
      "recommendation": "Viable undiscovered spring (68% probability)..."
    },
    // ... more sources ...
  ],
  
  "best_option": { /* first ranked source */ },
  "alternatives": [ /* sources 2-4 */ ],
  
  "weather": {
    "mean_annual_precipitation_mm": 680.2,
    "estimated_recharge_mm": 127.5,
    "trend_mm_per_year": -2.3,
    "confidence": 0.92,
    "fallback": false
  },
  
  "overall_confidence": 0.78,
  "recommendation": "Best option: Spring at Vrajei (68% probability)..."
}
```

---

## Testing the System

### Run Comprehensive Test

```bash
cd c:\Users\marcu\Documents\GitHub\H2Oolkit
python test_backend_pipeline.py
```

This test:
1. ✓ Verifies all imports
2. ✓ Tests location geocoding (name → coordinates)
3. ✓ Confirms 10 km radius configuration
4. ✓ Tests EU Hydro integration
5. ✓ Tests GEE satellite data fetching
6. ✓ Tests spring probability calculation
7. ✓ Tests OSM water source discovery
8. ✓ Runs complete village analysis pipeline

---

## API Endpoints

### Main Endpoint: Location Analysis

```bash
POST /api/analyze/location
Content-Type: application/json

{
  "location": "Vrancea, Romania"
  // OR
  "lat": 45.1,
  "lon": 26.0,
  
  // Optional parameters:
  "radius_m": 10000,  // default: 10000 (10 km) ✓
  "population": 500,  // default: 500
  "name": "Village Name"  // default: geocoded name
}
```

**Response:** Complete ranked sources with satellite data and spring probability

### Individual Source Analysis

```bash
POST /api/analyze/spring
Content-Type: application/json

{
  "lat": 45.15,
  "lon": 26.02,
  "satellite_data": { ... }  // optional
}
```

### EU Hydro Query

```bash
GET /api/eu-hydro/unlinked-springs?lat=45.1&lon=26.0&radius_m=10000
```

Returns unlinked springs from EU Hydro database.

---

## Data Processing Flow

```
Step 1: Location Input
  "Vrancea, Romania"
       ↓
  _geocode_location() → (45.10, 26.01, "Vrancea County")

Step 2: Weather Data (1 call to Open-Meteo)
  get_historical_precipitation(45.10, 26.01, years=10)
       ↓
  {"mean_annual_precipitation_mm": 680, "estimated_recharge_mm": 127, ...}

Step 3: OSM Sources (1 call to Overpass API)
  search_all_water_sources(45.10, 26.01, 10000)
       ↓
  [8 sources: springs, streams, rivers, lakes]

Step 4: EU Hydro Annotation (1 GEE call)
  annotate_osm_sources_with_eu_hydro(sources)
       ↓
  [same 8 sources with "eu_hydro_linked" field added]

Step 5: EU Hydro Native Sources (1 GEE call)
  find_unlinked_springs(45.10, 26.01, 10000)
       ↓
  [2 additional unlinked springs]

Step 6: Elevation Batch (1 call to OpenTopoData)
  get_elevations_batch([10 points])
       ↓
  [10 elevation values]

Step 7: GEE Satellite Data (10 parallel GEE calls OR 1 batch)
  For each of 10 sources:
    get_gee_satellite_data(lat, lon)
       ↓
  [NDVI, soil moisture, JRC, slope, elevation, distance to river]

Step 8: Spring Probability (10 calculations in memory)
  For each source:
    calculate_spring_probability(satellite_data)
       ↓
  [probability 0-1, confidence, signal scores]

Step 9: Ranking
  rank_water_sources(10 sources with satellite data)
       ↓
  [Ranked sources by efficiency score]

Step 10: Return to Frontend
  {village, ranked_sources, best_option, recommendation, ...}
```

---

## How the System Uses Each Data Source

| Data Source | Used For | Source |
|------------|----------|--------|
| NDVI Dry (Sep) | Spring probability | Sentinel-2 / GEE |
| NDVI Wet (Jun) | Spring probability | Sentinel-2 / GEE |
| Soil Moisture | Spring probability | NASA GLDAS / GEE |
| JRC Water Occurrence | Spring probability | JRC Global Surface Water / GEE |
| Topography (slope) | Spring probability + ranking | SRTM / GEE |
| Elevation | Routing + cost + ranking | SRTM 30m / OpenTopoData |
| Distance to River | Spring penalty scoring | EU-Hydro / GEE |
| EU-Hydro Rivers/Lakes | Source annotation | JRC / GEE |
| EU-Hydro Springs | Additional sources | Manual upload to GEE |
| OSM Water Sources | Base source discovery | Overpass API |
| Precipitation | Water reserve estimation | Open-Meteo |
| ET₀ Evapotranspiration | Recharge estimation | Open-Meteo |

---

## How Frontend Should Display Data

### Best Option Card
```
[Spring Icon] Spring at Vrajei
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Location:      8.2 km from village
Elevation:     520 m (275 m above village)
Supply:        Pumped (medium lift, ~20m/s)

Spring Probability:  68% (HIGH CONFIDENCE)
  • Vegetation:     55% (persistent vegetation signal)
  • Soil moisture:  62% (summer dryness weak)
  • Water history:  48% (some surface water detected)
  • Topography:     71% (good slope for flow)

Estimated Flow:    4,200 L/day (sustainable)
Infrastructure:    €125,000 (€24,000 grant available)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Alternatives:
  2. Stream at Corbeni (65% eff, 9.1 km, €98k)
  3. Well at Tulnici (58% eff, 6.3 km, €65k)
```

### Map Display
```
✓ Village center (circle)
  ├─ 10 km radius ring (search area)
  ├─ Blue springs (EU Hydro unlinked - NEW discoveries)
  ├─ Green springs (EU Hydro linked - catalogued)
  ├─ Orange springs (OSM - mapped)
  ├─ ▲ Streams, rivers, lakes
  └─ Red line: Pipeline route to #1 option
```

---

## Verification Checklist

- [x] Location geocoding works (name → coordinates)
- [x] Default radius is 10 km (10,000 m)
- [x] EU Hydro database query (linked + unlinked springs)
- [x] GEE satellite data per source (NDVI, soil, JRC, slope, elev, dist-to-river)
- [x] Spring probability calculation using satellite signals
- [x] Source ranking incorporates satellite data
- [x] Complete data sent to frontend (satellite_data + spring_analysis)
- [x] Weather data (10-year precipitation + trend)
- [x] Cost analysis (pipeline + pump + treatment + PNRR eligibility)
- [x] Route calculation (distance + elevation + method)
- [x] Confidence scoring
- [x] Recommendation generation

---

## Troubleshooting

### Issue: "GEE unavailable"
**Solution:** Run `earthengine authenticate` once to set up Google Earth Engine credentials.

### Issue: "Location not found"
**Solution:** Add country name: "Vrancea, Romania" instead of just "Vrancea"

### Issue: No water sources found
**Solution:** Expand radius_m parameter or check if area has mapped water bodies in OSM

### Issue: API rate limiting
**Solution:** Space out requests or implement caching for repeated queries

---

## Summary

Your H2Oolkit backend now:

1. ✅ **Accepts location input** (text or coordinates)
2. ✅ **Searches 10 km radius** (10,000 m default)
3. ✅ **Queries EU Hydro database** for existing water sources
4. ✅ **Fetches satellite data from GEE** for each source:
   - Vegetation (NDVI June/September)
   - Soil moisture (summer)
   - Water occurrence history (JRC)
   - Topography and elevation
   - Distance to rivers
5. ✅ **Calculates spring probability** using multi-criteria satellite analysis
6. ✅ **Discovers undocumented springs** (EU Hydro + satellite-detected)
7. ✅ **Ranks sources by efficiency** (spring probability + topography + distance + reliability + cost)
8. ✅ **Sends complete data to frontend** with all analysis results

**Status:** Ready for frontend integration ✓
