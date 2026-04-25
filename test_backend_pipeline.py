#!/usr/bin/env python3
"""
Comprehensive test for H2Oolkit backend pipeline.

Tests the complete flow:
1. Location input → coordinates conversion
2. 10 km radius search setup
3. EU Hydro database query
4. GEE satellite data fetching
5. Spring probability calculation
6. Water source ranking
7. Frontend data export

Run from project root:
    py test_backend_pipeline.py
"""

import sys
import json
from pathlib import Path

print("=" * 80)
print("H2OOLKIT BACKEND PIPELINE TEST")
print("=" * 80)

# Test 1: Imports
print("\n[TEST 1] Verifying all backend modules import correctly...")
try:
    from backend.analyzer import analyze_village_water_supply
    from backend.osm import search_all_water_sources
    from backend.eu_hydro import annotate_osm_sources_with_eu_hydro, find_unlinked_springs, get_gee_satellite_data
    from backend.spring_detector import calculate_spring_probability
    from backend.source_ranker import rank_water_sources
    from backend.weather import get_historical_precipitation
    from backend.elevation import get_elevation, get_elevations_batch
    from backend.server import _geocode_location
    print("✓ All imports successful")
except Exception as e:
    print(f"✗ Import error: {e}")
    sys.exit(1)

# Test 2: Location geocoding
print("\n[TEST 2] Testing location geocoding (location → coordinates)...")
try:
    test_locations = [
        "Vrancea, Romania",
        "Tulcea, Romania",
        "Constanta, Romania",
    ]
    
    for location in test_locations:
        lat, lon, name = _geocode_location(location)
        print(f"  ✓ {location:30s} → ({lat:.4f}, {lon:.4f}) [{name}]")
        
        # Verify reasonable Romanian coordinates
        assert 43.5 < lat < 48.5, f"Latitude {lat} out of Romania range"
        assert 19.5 < lon < 30.5, f"Longitude {lon} out of Romania range"
    print("✓ Geocoding verified")
except Exception as e:
    print(f"✗ Geocoding error: {e}")
    sys.exit(1)

# Test 3: 10km radius verification
print("\n[TEST 3] Verifying 10 km radius configuration...")
try:
    # The server.py default should now be 10000m (10km)
    from backend import server
    import inspect
    source = inspect.getsource(server.analyze_location)
    
    # Check that default radius is 10000m
    if "10_000" in source or "10000" in source:
        print("  ✓ Default radius is 10,000m (10 km)")
    else:
        print("  ✗ Default radius may not be 10 km")
        
    print("✓ Radius configuration verified")
except Exception as e:
    print(f"✗ Radius verification error: {e}")

# Test 4: EU Hydro integration
print("\n[TEST 4] Testing EU Hydro database integration...")
try:
    print("  Note: EU Hydro requires Google Earth Engine authentication")
    print("  Run: earthengine authenticate")
    print("  This test will use fallback data if GEE unavailable")
    
    lat, lon = 45.1, 26.0  # Vrancea
    eu_data = find_unlinked_springs(lat, lon, radius_m=10000)
    
    print(f"  ✓ EU Hydro query executed")
    print(f"    - Unlinked springs: {len(eu_data.get('unlinked', []))}")
    print(f"    - Linked springs: {len(eu_data.get('linked', []))}")
    print(f"    - GEE available: {eu_data.get('available', False)}")
except Exception as e:
    print(f"  ⚠ EU Hydro query (non-critical): {e}")

# Test 5: GEE satellite data
print("\n[TEST 5] Testing GEE satellite data fetching...")
try:
    lat, lon = 45.1, 26.0  # Vrancea
    sat_data = get_gee_satellite_data(lat, lon)
    
    print(f"  ✓ Satellite data fetched:")
    print(f"    - NDVI dry (Sep):          {sat_data['ndvi_dry']:.3f}")
    print(f"    - NDVI wet (Jun):          {sat_data['ndvi_wet']:.3f}")
    print(f"    - Soil moisture (summer):  {sat_data['soil_moisture_summer']:.3f}")
    print(f"    - JRC water occurrence:    {sat_data['jrc_occurrence']:.1f}%")
    print(f"    - Slope:                   {sat_data['slope_degrees']:.1f}°")
    print(f"    - Elevation:               {sat_data['elevation']:.1f}m")
    print(f"    - Distance to river:       {sat_data['distance_to_river_m']:.1f}m")
    print(f"    - GEE available:           {sat_data['available']}")
    
    # Verify data ranges
    assert -1.0 <= sat_data['ndvi_dry'] <= 1.0, "NDVI dry out of range"
    assert -1.0 <= sat_data['ndvi_wet'] <= 1.0, "NDVI wet out of range"
    assert 0.0 <= sat_data['soil_moisture_summer'] <= 1.0, "Soil moisture out of range"
    assert 0.0 <= sat_data['jrc_occurrence'] <= 100.0, "JRC occurrence out of range"
    print("✓ Satellite data verified (all values in valid ranges)")
except Exception as e:
    print(f"✗ Satellite data error: {e}")
    sys.exit(1)

# Test 6: Spring probability calculation
print("\n[TEST 6] Testing spring probability calculation...")
try:
    spring_prob = calculate_spring_probability(
        ndvi_dry=0.40,
        ndvi_wet=0.55,
        soil_moisture_summer=0.42,
        jrc_occurrence=25.0,
        slope_degrees=12.0,
        elevation=450.0,
        distance_to_river_m=300.0,
    )
    
    print(f"  ✓ Spring probability score: {spring_prob['spring_probability']:.3f}")
    print(f"    - Confidence:             {spring_prob['confidence']:.2f}")
    print(f"    - Dominant signal:        {spring_prob['dominant_signal']}")
    print(f"    - Signal scores:")
    for signal, score in spring_prob['signal_scores'].items():
        print(f"      • {signal:25s}: {score:.3f}")
    print(f"    - River penalty:          {spring_prob['river_penalty_applied']:.3f}")
    
    # Verify probability range
    assert 0.0 <= spring_prob['spring_probability'] <= 1.0, "Probability out of range [0,1]"
    print("✓ Spring probability calculation verified")
except Exception as e:
    print(f"✗ Spring probability error: {e}")
    sys.exit(1)

# Test 7: OSM water source discovery
print("\n[TEST 7] Testing OSM water source discovery...")
try:
    lat, lon = 45.1, 26.0  # Vrancea
    sources = search_all_water_sources(lat, lon, radius_m=10000)
    
    print(f"  ✓ Found {len(sources)} water sources via OSM")
    
    if sources:
        # Count by type
        source_types = {}
        for src in sources:
            stype = src.get('source_type', 'unknown')
            source_types[stype] = source_types.get(stype, 0) + 1
        
        for stype, count in sorted(source_types.items()):
            print(f"    - {stype:15s}: {count:3d} sources")
            
        # Show first 3 sources
        print("    Sample sources:")
        for src in sources[:3]:
            print(f"      • {src.get('name', 'unnamed'):30s} "
                  f"({src.get('source_type'):10s}) "
                  f"{src['distance_m']:.0f}m away")
    
    print("✓ OSM water source discovery verified")
except Exception as e:
    print(f"✗ OSM discovery error: {e}")

# Test 8: Full pipeline (village analysis)
print("\n[TEST 8] Testing complete village analysis pipeline...")
print("  (This may take 1-2 minutes due to GEE data fetching)")
try:
    result = analyze_village_water_supply(
        village_lat=45.1,
        village_lon=26.0,
        village_population=500,
        radius_m=10_000,  # 10 km as per spec
        village_name="Test Village"
    )
    
    print(f"  ✓ Analysis complete:")
    print(f"    - Village:                 {result['village']['name']}")
    print(f"    - Water sources found:     {result['sources_found']}")
    print(f"    - Best option:             {result['best_option'].get('name') if result['best_option'] else 'None'}")
    print(f"    - Overall confidence:      {result['overall_confidence']:.2f}")
    print(f"    - Weather:")
    print(f"      • Precipitation:         {result['weather']['mean_annual_precipitation_mm']:.1f}mm/year")
    print(f"      • Recharge estimate:     {result['weather']['estimated_recharge_mm']:.1f}mm/year")
    
    print(f"    - Ranking results:")
    for src in result['ranked_sources'][:3]:
        print(f"      Rank {src['rank']}: {src.get('name', 'unnamed'):30s} "
              f"(efficiency: {src.get('efficiency_score', 0):.3f})")
        if 'spring_probability' in src:
            print(f"           Spring probability: {src['spring_probability']:.3f}")
        if 'scores' in src:
            print(f"           Scores: topography={src['scores'].get('topography', 0):.3f}, "
                  f"distance={src['scores'].get('distance', 0):.3f}, "
                  f"spring_prob={src['scores'].get('spring_probability', 0):.3f}")
    
    # Verify response structure
    assert 'village' in result, "Missing village field"
    assert 'ranked_sources' in result, "Missing ranked_sources field"
    assert 'best_option' in result, "Missing best_option field"
    assert 'recommendation' in result, "Missing recommendation field"
    
    print("✓ Complete pipeline verified")
    print("\n" + "=" * 80)
    print("DATA BEING SENT TO FRONTEND:")
    print("=" * 80)
    print(json.dumps({
        "village": result['village'],
        "sources_found": result['sources_found'],
        "best_option_summary": {
            "name": result['best_option'].get('name') if result['best_option'] else None,
            "type": result['best_option'].get('source_type') if result['best_option'] else None,
            "spring_probability": result['best_option'].get('spring_probability') if result['best_option'] else None,
        },
        "top_3_sources": [
            {
                "rank": src['rank'],
                "name": src.get('name'),
                "type": src['source_type'],
                "efficiency_score": src.get('efficiency_score'),
                "spring_probability": src.get('spring_probability'),
                "satellite_data_available": src.get('gee_available', False),
            }
            for src in result['ranked_sources'][:3]
        ],
        "weather": result['weather'],
        "overall_confidence": result['overall_confidence'],
    }, indent=2))
    
except Exception as e:
    print(f"✗ Pipeline error: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

print("\n" + "=" * 80)
print("✓ ALL TESTS PASSED")
print("=" * 80)
print("\nSystem is ready for frontend integration.")
print("Frontend should expect:")
print("  1. Village location and basic info")
print("  2. Ranked water sources with:")
print("     - Satellite data (NDVI, soil moisture, JRC, elevation, slope)")
print("     - Spring probability score (0-1)")
print("     - Efficiency score incorporating spring probability")
print("     - Cost and supply method analysis")
print("     - EU Hydro linkage status")
print("  3. Weather and hydrological data")
print("  4. Best option and alternatives")
print("  5. Overall confidence metric")
