"""
fetch_villages.py  —  H2Oolkit Village Water Needs Extractor
=============================================================
Queries OpenStreetMap Overpass API for Romanian populated places,
estimates daily water demand, classifies each settlement's water
access status, and outputs GeoJSON village-zone polygons that
process_pipeline.py links to the nearest detected spring.

Classification basis:
  - Romanian NIS 2021 census: ~40 % of rural communes lack central
    piped water supply, concentrated in mountain and sub-Carpathian
    zones and in the southern / eastern plains.

Output: data/villages_romania.json  (GeoJSON FeatureCollection)

Usage:
    py extraction/fetch_villages.py
    py extraction/fetch_villages.py --county Vrancea
    py extraction/fetch_villages.py --min-pop 100 --max-pop 3000
"""

import os, sys, json, math, time, argparse, requests
from datetime import datetime, timezone

OVERPASS_URL  = 'https://overpass-api.de/api/interpreter'
HEADERS       = {'User-Agent': 'H2Oolkit/1.0 (CASSINI Hackathon 2026)'}

_ROOT    = os.path.join(os.path.dirname(__file__), '..')
OUT_FILE = os.path.normpath(os.path.join(_ROOT, 'data', 'villages_romania.json'))

# Romania bounding box
RO_SOUTH, RO_WEST, RO_NORTH, RO_EAST = 43.5, 20.0, 48.5, 30.5

WATER_PER_CAPITA_L = 120    # litres / person / day
MIN_POP_DEFAULT    = 50
MAX_POP_DEFAULT    = 8000   # exclude large towns

# Population fallbacks when OSM tag is missing
POP_BY_PLACE_TYPE = {
    'hamlet':       120,
    'village':      380,
    'town':        7000,
    'suburb':      2500,
    'locality':    200,
}

# Counties/regions where rural water coverage is historically poor
# (NIS 2021 + INSSE water infrastructure reports)
LOW_COVERAGE_COUNTIES = {
    'vrancea', 'buzău', 'bacău', 'neamț', 'vaslui', 'iași',
    'olt', 'teleorman', 'giurgiu', 'călărași', 'ialomița',
    'dâmbovița', 'argeș', 'mehedinți', 'gorj', 'tulcea',
}


# ── WATER ACCESS CLASSIFICATION ───────────────────────────────────────────────

def classify_water_access(pop: int, lat: float, lon: float, county: str) -> str:
    """
    Returns one of the three statuses the frontend recognises:
      'No piped water' | 'Seasonal shortages' | 'Insufficient pressure'
    Returns None for well-served settlements (excluded from output).
    """
    county_lc = county.lower().strip()
    is_mountain = lat > 45.2 and (lon < 24.5 or (lon < 26.5 and lat > 46.0))
    is_low_cov  = county_lc in LOW_COVERAGE_COUNTIES

    if is_mountain and pop < 400:
        return 'No piped water'
    if is_low_cov and pop < 250:
        return 'No piped water'
    if pop < 200:
        return 'No piped water'
    if (is_mountain or is_low_cov) and pop < 800:
        return 'Seasonal shortages'
    if pop < 600:
        return 'Seasonal shortages'
    if pop < 1500:
        return 'Insufficient pressure'
    return None     # well served — skip


# ── GEOMETRY HELPERS ──────────────────────────────────────────────────────────

def haversine_km(lat1, lon1, lat2, lon2) -> float:
    R = 6_371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return R * 2 * math.asin(math.sqrt(max(0.0, a)))


def make_circle_polygon(lat: float, lon: float, radius_km: float,
                        n_pts: int = 16) -> list:
    """Return a closed GeoJSON coordinate ring approximating a circle."""
    ring = []
    for i in range(n_pts + 1):
        angle = 2 * math.pi * i / n_pts
        d_lat = (radius_km / 111.0) * math.sin(angle)
        d_lon = (radius_km / (111.0 * math.cos(math.radians(lat)))) * math.cos(angle)
        ring.append([round(lon + d_lon, 6), round(lat + d_lat, 6)])
    return ring


# ── OVERPASS QUERY ────────────────────────────────────────────────────────────

def fetch_overpass(south: float, west: float, north: float, east: float,
                   county_filter: str = None) -> list:
    print(f'[OVERPASS] Querying villages in ({south:.1f},{west:.1f} → {north:.1f},{east:.1f}) ...')

    query = f"""
[out:json][timeout:120];
(
  node["place"~"^(village|hamlet|town|locality)$"]["name"]
      ({south},{west},{north},{east});
  way["place"~"^(village|hamlet|town)$"]["name"]
      ({south},{west},{north},{east});
);
out center tags;
"""
    try:
        r = requests.post(OVERPASS_URL, data={'data': query},
                          headers=HEADERS, timeout=150)
        r.raise_for_status()
        elements = r.json().get('elements', [])
    except Exception as e:
        print(f'  [WARN] Overpass: {e}')
        return []

    villages = []
    for el in elements:
        tags = el.get('tags', {})
        name = tags.get('name', '').strip()
        if not name:
            continue

        # Coordinates
        if el['type'] == 'node':
            lat, lon = el.get('lat'), el.get('lon')
        else:
            c = el.get('center', {})
            lat, lon = c.get('lat'), c.get('lon')
        if lat is None or lon is None:
            continue

        # Skip non-Romanian entries that slipped through the bbox
        cc = tags.get('addr:country', tags.get('is_in:country_code', 'RO'))
        if cc.upper() not in ('RO', 'ROMANIA', ''):
            continue

        # Parse population
        pop = None
        raw_pop = tags.get('population', '')
        try:
            pop = int(float(raw_pop)) if raw_pop else None
        except (ValueError, TypeError):
            pass

        county = (tags.get('addr:county')
                  or tags.get('is_in:county')
                  or tags.get('addr:state', ''))

        if county_filter and county_filter.lower() not in county.lower():
            continue

        villages.append({
            'osm_id':     el['id'],
            'name':       name,
            'lat':        float(lat),
            'lon':        float(lon),
            'population': pop,
            'county':     county,
            'place_type': tags.get('place', 'village'),
        })

    print(f'  [OVERPASS] → {len(villages)} places returned')
    return villages


# ── FEATURE BUILDER ───────────────────────────────────────────────────────────

def build_feature(v: dict) -> dict:
    pop    = v['population']
    lat, lon = v['lat'], v['lon']
    need   = round(pop * WATER_PER_CAPITA_L / 1000)   # m³/day
    access = classify_water_access(pop, lat, lon, v.get('county', ''))
    radius = max(0.25, math.sqrt(pop / math.pi) * 0.018)   # km, scales with population

    return {
        'type': 'Feature',
        'geometry': {
            'type': 'Polygon',
            'coordinates': [make_circle_polygon(lat, lon, radius)],
        },
        'properties': {
            'feature_type':      'village_zone',
            'village_name':      v['name'],
            'county':            v.get('county') or 'Romania',
            'population':        pop,
            'water_need_m3_day': need,
            'access_status':     access,
            'linked_spring_id':  None,   # filled by process_pipeline.py
            'lat':               round(lat, 6),
            'lon':               round(lon, 6),
        },
    }


# ── MAIN ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='H2Oolkit village water needs extractor')
    parser.add_argument('--min-pop', type=int, default=MIN_POP_DEFAULT,
                        help=f'Min population (default: {MIN_POP_DEFAULT})')
    parser.add_argument('--max-pop', type=int, default=MAX_POP_DEFAULT,
                        help=f'Max population (default: {MAX_POP_DEFAULT})')
    parser.add_argument('--county', default=None,
                        help='Filter by county name (e.g. Vrancea)')
    args = parser.parse_args()

    print()
    print('=' * 60)
    print('  H2Oolkit  |  Village Water Needs Extractor')
    print('=' * 60)

    raw = fetch_overpass(RO_SOUTH, RO_WEST, RO_NORTH, RO_EAST, args.county)

    if not raw:
        print('[ERROR] No data from Overpass. Check network or retry.')
        sys.exit(1)

    # Fill missing populations from place-type defaults
    for v in raw:
        if not v['population']:
            v['population'] = POP_BY_PLACE_TYPE.get(v['place_type'], 300)

    # Population range filter
    in_range = [v for v in raw if args.min_pop <= v['population'] <= args.max_pop]

    # Keep only underserved settlements
    underserved = [
        v for v in in_range
        if classify_water_access(v['population'], v['lat'], v['lon'],
                                 v.get('county', '')) is not None
    ]

    print(f'\n[FILTER] {len(raw)} total'
          f' → {len(in_range)} in pop range'
          f' → {len(underserved)} underserved')

    features = [build_feature(v) for v in underserved]

    # Stats
    by_status: dict[str, int] = {}
    for f in features:
        s = f['properties']['access_status']
        by_status[s] = by_status.get(s, 0) + 1
    total_need = sum(f['properties']['water_need_m3_day'] for f in features)

    output = {
        'type': 'FeatureCollection',
        'metadata': {
            'source':          'OpenStreetMap Overpass API',
            'region':          'Romania',
            'total_villages':  len(features),
            'total_need_m3_day': total_need,
            'generated_at':    datetime.now(timezone.utc).isoformat(),
        },
        'features': features,
    }

    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    with open(OUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print()
    print('=' * 60)
    print('  SUMMARY')
    print('=' * 60)
    for status, cnt in sorted(by_status.items()):
        print(f'  {status:<30}: {cnt:>5}')
    print(f'  {"Total water need":<30}: {total_need:>5,} m³/day')
    print(f'  Output → {OUT_FILE}')
    print()


if __name__ == '__main__':
    main()
