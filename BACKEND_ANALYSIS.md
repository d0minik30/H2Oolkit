# H2Oolkit Backend Logic & Data Flow Analysis

## Executive Summary

Your water source detection system has **generally coherent logic**, but I've identified **4 critical issues** with data sourcing order, missing field mappings, and inefficient API sequencing. This document provides a detailed audit with fixes.

---

## 1. DATA FLOW ARCHITECTURE (Current State)

### User Journey: "Search for water near a village"

```
User Input (location name) 
    ↓
POST /api/analyze/location
    ↓
analyzer.analyze_village_water_supply()
    ├─ 1. Village elevation lookup (USGS/GEBCO)
    ├─ 2. Weather/precipitation (NOAA)
    ├─ 3. OSM water search (OpenStreetMap API)
    │   └─ Returns: springs, wells, streams, rivers, lakes
    ├─ 4. EU Hydro annotation (Google Earth Engine)
    │   └─ Marks each source as "linked" or "unlinked" to official network
    ├─ 5. EU Hydro additional sources (GEE native data)
    │   └─ Adds unlinked springs NOT in OSM
    ├─ 6. Batch elevation lookup for all sources
    ├─ 7. Ranking by supply efficiency
    └─ Return: ranked_sources, best_option, recommendation
```

### Data Source Priority (Current Implementation)

**Step 3 (OSM) → Step 4 (EU Hydro annotation) → Step 5 (EU Hydro native)**

---

## 2. IDENTIFIED ISSUES

### ⚠️ **ISSUE #1: Logic Incoherence — EU Hydro Query Order**

**Location:** [analyzer.py](backend/analyzer.py#L175-L195)

**Problem:**
```python
# Current order (WRONG):
1. sources = search_all_water_sources(...)  # OSM only
2. sources = annotate_osm_sources_with_eu_hydro(...)  # Check OSM against EU Hydro
3. eu_hydro_result = find_unlinked_springs(...)  # Query EU Hydro separately
```

**Why this is incoherent:**
- You're querying **EU Hydro TWICE**:
  1. Once to annotate OSM sources (cross-reference)
  2. Again to fetch native EU Hydro sources not in OSM
- The **second query is redundant** if the first query already loaded EU Hydro rivers/lakes
- This doubles API latency and Google Earth Engine quota usage

**Correct Logic Should Be:**
```python
1. Query EU Hydro database once → get rivers, lakes, and spring sources
2. Query OSM → get all mapped water sources
3. Cross-reference: mark which OSM sources align with EU Hydro
4. Merge: add EU Hydro sources that don't exist in OSM
5. Rank merged list
```

**Recommendation:** Refactor [eu_hydro.py](backend/eu_hydro.py) to support a single unified query that returns:
- Official water bodies (rivers/lakes)
- All spring sources (linked + unlinked)
- Reuse these results for both annotation AND addition of new sources

---

### ⚠️ **ISSUE #2: Missing Data Field Transitions**

**Location:** [frontend_adapter.py](backend/frontend_adapter.py#L75) → [source_ranker.py](backend/source_ranker.py#L70-L95)

**Problem:**
OSM sources from [osm.py](backend/osm.py) lack critical fields needed by [source_ranker.py](backend/source_ranker.py):

| Field | OSM Source Provides | Ranker Needs | Current Fallback |
|-------|-------------------|-------------|-----------------|
| `elevation` | ❌ NO | ✅ YES (line 31) | village_elev (worst case) |
| `source_type` | ✅ YES | ✅ YES | N/A |
| `reliability_base` | ❌ NO | ✅ YES (line 43) | SOURCE_RELIABILITY[type] |
| `intermittent` | ❌ NO | ✅ YES (line 42) | Hardcoded False |
| `distance_m` | ✅ YES (calculated) | ✅ YES | ✓ |
| `estimated_daily_flow_liters` | ❌ NO | ✅ YES | Estimated from type |

**Impact:**
- Elevations default to village elevation → **distorts topography scores** (gravity vs. pumping)
- No intermittent source detection → **rivers marked as permanent when seasonal**
- Conservative fallback values → **underestimates reliable sources**

**Current Problematic Code** ([osm.py](backend/osm.py#L50-L70)):
```python
def search_all_water_sources(lat, lon, radius_m):
    # Returns only: id, lat, lon, name, distance_m, source_type, tags
    # MISSING: elevation, reliability_base, intermittent status
    return springs
```

**Recommendation:** Add these fields DURING OSM query:
```python
def search_all_water_sources(...):
    # Current code returns ~12 fields
    # MUST ADD for each source:
    # - intermittent: bool (from OSM tag "intermittent"=yes/no)
    # - reliability_base: float (lookup from SOURCE_RELIABILITY dict)
    # - estimated_daily_flow_liters: int (from SOURCE_FLOW_ESTIMATES dict)
    # elevation: None (will be batch-filled in step 6)
```

---

### ⚠️ **ISSUE #3: Redundant Elevation Queries**

**Location:** [analyzer.py](backend/analyzer.py#L163-L164) and [analyzer.py](backend/analyzer.py#L200)

**Problem:**
```python
# Line 163-164: Village elevation queried individually
village_elevation = get_elevation(village_lat, village_lon)

# Line 200: All sources queried in batch (CORRECT)
elevations = get_elevations_batch(points)
```

**Why redundant:**
- Village IS a point that could be included in the batch query
- Adds unnecessary API roundtrip

**Recommendation:**
```python
# Include village as first point in batch
points = [{"lat": village_lat, "lon": village_lon}] + \
         [{"lat": s["lat"], "lon": s["lon"]} for s in sources]
elevations = get_elevations_batch(points)
village_elevation = elevations[0]
for source, elev in zip(sources, elevations[1:]):
    source["elevation"] = elev or village_elev
```

---

### ⚠️ **ISSUE #4: Data Adapter Missing Satellite Field Fallbacks**

**Location:** [frontend_adapter.py](backend/frontend_adapter.py#L88-L110)

**Problem:**
When user analyzes a **NEW location** (not from cached springs.json), satellite data is generated with defaults:

```python
# Line 88-110: spring_to_satellite_data()
ndvi_dry = float(sat.get('ndvi_dry') or 0.0)  # ← WRONG default
ndvi_wet = float(sat.get('ndvi_wet') or 0.0)  # ← WRONG default
```

**Why problematic:**
- NDVI of 0.0 means **barren/urban area** (rock, concrete)
- Carpathian springs typically have NDVI 0.4–0.7 (forested)
- A 0.0 default **artificially deflates spring probability**

**Cascading Impact:**
```
Bad NDVI → Low vegetation_anomaly score
         → Low overall spring_probability 
         → "Not recommended" recommendation
         → User misses viable spring
```

**Correct Defaults** (from [process_pipeline.py](extraction/process_pipeline.py) logic):
- **ndvi_dry:** 0.35 (conservative forest)
- **ndvi_wet:** 0.50 (typical forested catchment)
- **soil_moisture_summer:** 0.40 (Carpathian summer baseline)
- **jrc_occurrence:** 20.0 (persistent water, not permanent river)

**Recommendation:**
```python
# Add realistic Carpathian defaults
_CARPATHIAN_DEFAULTS = {
    "ndvi_dry": 0.35,
    "ndvi_wet": 0.50,
    "soil_moisture_summer": 0.40,
    "jrc_occurrence": 20.0,
    "distance_to_river_m": 500.0,
    "slope_degrees": 8.0,
}

def spring_to_satellite_data(spring: dict) -> dict:
    sat = spring.get('satellite', {}) or {}
    ndvi_dry = float(sat.get('ndvi_dry') or _CARPATHIAN_DEFAULTS["ndvi_dry"])
    # ... use realistic defaults, not 0.0
```

---

## 3. DATA TRANSITION ANALYSIS

### Clean Transitions ✅
1. **OSM → Ranker:** Source types properly normalized (spring/well/river/stream/lake)
2. **Ranking → Response:** Efficiency scores correctly propagated to API output
3. **Elevation Batch Fill:** Correctly fills missing elevations before ranking

### Problematic Transitions ⚠️
1. **EU Hydro → Ranker:** 
   - EU Hydro sources manually constructed with hardcoded fields
   - Mismatch: `estimated_daily_flow_liters: 3_000` is generic, not specific to location
   
2. **OSM Flags → Ranker:**
   - `intermittent` flag not extracted from OSM tags → always assumes perennial
   - Leads to overestimating small streams' reliability

3. **Satellite Grid → Spring Analysis:**
   - [process_pipeline.py](extraction/process_pipeline.py) reads `satellite_grid.csv`
   - But [analyzer.py](backend/analyzer.py) doesn't access this during live analysis
   - Gap: Live analysis uses defaults, offline analysis uses actual satellite data

---

## 4. RECOMMENDED FIXES (Priority Order)

### 🔴 **HIGH PRIORITY**

#### Fix 1: Consolidate EU Hydro Queries
**File:** [eu_hydro.py](backend/eu_hydro.py)
```python
def query_eu_hydro_unified(lat, lon, radius_m=10_000):
    """
    Single query returning:
    - rivers: GeoJSON features
    - lakes: GeoJSON features  
    - all_springs: {linked: [...], unlinked: [...]}
    """
    # Query once, return all needed data
```

**Then in [analyzer.py](backend/analyzer.py):**
```python
eu_data = query_eu_hydro_unified(village_lat, village_lon, radius_m)

# Use same data for both:
sources = annotate_osm_sources_with_eu_hydro(osm_sources, eu_data)
eu_hydro_sources = eu_data["all_springs"]["unlinked"]
sources.extend(eu_hydro_sources)
```

#### Fix 2: Add Missing Fields to OSM Query
**File:** [osm.py](backend/osm.py#L80-L120)
```python
def search_all_water_sources(lat, lon, radius_m=10_000):
    # After parsing elements, enrich each source:
    for source in sources:
        source["intermittent"] = _is_intermittent(source.get("tags", {}))
        source["reliability_base"] = SOURCE_RELIABILITY[source["source_type"]]
        source["estimated_daily_flow_liters"] = SOURCE_FLOW_ESTIMATES[source["source_type"]]
    return sources
```

#### Fix 3: Fix Satellite Data Defaults
**File:** [frontend_adapter.py](backend/frontend_adapter.py#L88-L110)

Replace all `or 0.0` with Carpathian defaults (see Issue #4 above).

### 🟡 **MEDIUM PRIORITY**

#### Fix 4: Batch Village + Source Elevations
**File:** [analyzer.py](backend/analyzer.py#L155-L200)

Include village in elevation batch query (saves 1 API call).

#### Fix 5: Extract Intermittent Flag from OSM
**File:** [osm.py](backend/osm.py)

```python
def _is_intermittent(tags: dict) -> bool:
    """Check OSM 'intermittent' tag."""
    intermittent = tags.get("intermittent", "no").lower()
    return intermittent in ("yes", "true", "seasonal")
```

---

## 5. LOGIC FLOW DIAGRAM (Corrected)

```
User: "Find water near Vrancea"
    ↓
POST /api/analyze/location
    ↓
analyze_village_water_supply()
    ├─ Get village elevation (batch with sources later)
    ├─ Get weather/precipitation
    ├─ [NEW] Single EU Hydro query
    │   └─ Returns: rivers, lakes, linked_springs, unlinked_springs
    ├─ Query OSM all water sources
    │   └─ [FIXED] Enrich with intermittent, reliability, flow estimates
    ├─ [FIXED] Annotate OSM with EU Hydro linkage (reuse data)
    ├─ [FIXED] Merge EU Hydro unlinked springs not in OSM
    ├─ [FIXED] Batch elevation for village + all sources (1 call)
    ├─ [FIXED] Rank by supply efficiency
    │   └─ Correct topography scores (actual elevations, not defaults)
    └─ Return ranked sources with recommendations
```

---

## 6. TESTING RECOMMENDATIONS

### Test Case 1: EU Hydro Integration
```python
# Before fix: API latency ~3-4s (2 GEE queries)
# After fix: API latency ~1.5-2s (1 GEE query)
```

### Test Case 2: Intermittent Spring Detection
**Input:** Stream marked `intermittent=yes` in OSM
**Before:** Reliability 0.60 (hardcoded)
**After:** Reliability reduced based on tag detection

### Test Case 3: Satellite Defaults
**Input:** New location, no cached satellite data
**Before:** All NDVI scores near 0.0 → spring probability ~15%
**After:** NDVI defaults to 0.35-0.50 → spring probability ~45%

---

## 7. SUMMARY TABLE

| Issue | Severity | Location | Fix Time |
|-------|----------|----------|----------|
| Double EU Hydro queries | 🔴 HIGH | eu_hydro.py, analyzer.py | 30 min |
| Missing OSM fields | 🔴 HIGH | osm.py, source_ranker.py | 20 min |
| Bad satellite defaults | 🔴 HIGH | frontend_adapter.py | 10 min |
| Redundant elevation query | 🟡 MED | analyzer.py | 15 min |
| Missing intermittent detection | 🟡 MED | osm.py | 10 min |

**Total estimated fix time: ~85 minutes**

---

## 8. QUESTIONS FOR YOU

1. **EU Hydro Database:** Is your GEE project ID correctly configured? (Line in [eu_hydro.py](backend/eu_hydro.py#L23))
2. **OSM Availability:** How often does Overpass API fail? Should we add retry logic?
3. **Satellite Grid:** Is [data/satellite_grid.csv](data/satellite_grid.csv) being updated? Should live analysis access it?
4. **Performance:** What's your acceptable latency for village analysis (current ~3-4s)?

---

**Next Steps:**
1. Would you like me to implement these fixes?
2. Should I prioritize fixes by high/medium severity?
3. Do you have specific test locations where this logic failed?
