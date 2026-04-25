"""
fetch_springs.py  —  H2Oolkit Multi-Source Water Body Detector v2
==================================================================
Queries THREE public databases and ONE Copernicus satellite pipeline
concurrently, then merges + deduplicates results into a single GeoJSON
file ready for the Leaflet frontend.

Data sources (run in parallel):
  DB-1  Wikidata SPARQL   — named springs, lakes, rivers, wells
  DB-2  EEA WFD REST      — EU Water Framework Directive water bodies
  DB-3  HydroLAKES CSV    — pre-downloaded European lake dataset
  SAT   Google Earth Engine — Sentinel-1 SAR + Sentinel-2 MNDWI fusion

Output: data/springs_results.geojson  (same path as v1, frontend unchanged)

Usage:
    py extraction/fetch_springs.py "Vrancea, Romania"
    py extraction/fetch_springs.py "Harghita" --radius 30 --sources database
    py extraction/fetch_springs.py "Bacau" --no-elevation
    py extraction/fetch_springs.py "Cluj" --sources satellite --period 6m
    py extraction/fetch_springs.py "Prahova" --hydrolakes-csv data/hl.csv
"""

import ee
import os, sys, json, math, csv, time, re, argparse
import concurrent.futures
import requests
from datetime import datetime, timezone

# ── CONFIG ────────────────────────────────────────────────────────────────────
PROJECT_ID    = 'h2oolkit-hackathon'
NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
WIKIDATA_URL  = 'https://query.wikidata.org/sparql'
EEA_URL       = ('https://discomap.eea.europa.eu/arcgis/rest/services/'
                 'Waterbase/WFD_SurfaceWaterBodies/MapServer/0/query')
ELEVATION_URL = 'https://api.opentopodata.org/v1/srtm30m'

ELEV_BATCH    = 80    # max coords per OpenTopoData request
ELEV_DELAY    = 0.6   # seconds between batches
DEDUP_M       = 100   # metres — collapse same-source duplicates
MERGE_M       = 500   # metres — satellite ↔ database cross-confirmation window

HEADERS = {
    'User-Agent': 'H2Oolkit/1.0 (CASSINI Hackathon 2026)',
    'Accept':     'application/json',
}

_ROOT    = os.path.join(os.path.dirname(__file__), '..')
OUT_FILE = os.path.normpath(os.path.join(_ROOT, 'data', 'springs_results.geojson'))
HL_CSV_DEFAULT = os.path.normpath(os.path.join(_ROOT, 'data', 'hydrolakes_europe.csv'))

DETECTION_DISCLAIMER = (
    "H2Oolkit currently detects water bodies above approximately 1.35 hectares "
    "(limited by Sentinel-2’s 30m resolution). With commercial high-resolution "
    "satellites (Planet Labs 3m, Maxar 30cm), this threshold drops to individual "
    "springs of any size. The current version is optimized for municipal-scale "
    "water infrastructure planning."
)

# ── COST MODEL ────────────────────────────────────────────────────────────────
def terrain_factor(elev_m: float) -> tuple:
    if elev_m < 200:  return 1.0, 'flat'
    if elev_m < 600:  return 1.4, 'hilly'
    return 1.9, 'mountain'

def calc_cost(distance_km: float, spring_elev: float, center_elev: float) -> dict:
    factor, terrain = terrain_factor(spring_elev)
    elev_diff  = max(0.0, spring_elev - center_elev)
    pipeline   = distance_km * factor * 85_000
    pump       = elev_diff * 120
    treatment  = 15_000.0
    subtotal   = pipeline + pump + treatment
    labor      = subtotal * 0.35
    total      = subtotal + labor
    return {
        'pipeline':    round(pipeline),
        'pump':        round(pump),
        'treatment':   15_000,
        'labor':       round(labor),
        'total':       round(total),
        'terrain':     terrain,
        'elev_diff_m': round(elev_diff),
    }

# ── UTILS ─────────────────────────────────────────────────────────────────────
def haversine_km(lat1, lon1, lat2, lon2) -> float:
    R = 6_371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return R * 2 * math.asin(math.sqrt(max(0.0, a)))

def bbox(lat, lon, radius_km) -> tuple:
    """Return (south, west, north, east) bounding box."""
    d_lat = radius_km / 111.0
    d_lon = radius_km / max(111.0 * math.cos(math.radians(lat)), 0.001)
    return lat - d_lat, lon - d_lon, lat + d_lat, lon + d_lon

def _f(v, digits=5):
    """Safely round a float; return None on failure."""
    try:
        return round(float(v), digits) if v not in (None, '', 'None', 'nan') else None
    except (TypeError, ValueError):
        return None

def _poly_centroid(coords) -> tuple:
    """Return (lon, lat) centroid of a polygon ring."""
    if not coords:
        return None, None
    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]
    return sum(lons) / len(lons), sum(lats) / len(lats)

def dedup_proximity(items: list, threshold_m: float) -> list:
    """Remove near-duplicate entries, keeping the highest-confidence one."""
    kept = []
    for item in sorted(items, key=lambda x: -x.get('confidence', 0)):
        lat, lon = item['lat'], item['lon']
        if any(haversine_km(lat, lon, k['lat'], k['lon']) * 1000 < threshold_m for k in kept):
            continue
        kept.append(item)
    return kept

# ── STATUS RULES ──────────────────────────────────────────────────────────────
def derive_status(conf: int, satellite_confirmed: bool, is_sat_only: bool) -> str:
    if is_sat_only:
        return 'pending'
    if satellite_confirmed and conf >= 85:
        return 'verified'
    if conf >= 70:
        return 'high_priority'
    return 'pending'

# ── GEOCODING ─────────────────────────────────────────────────────────────────
def geocode(name: str) -> tuple:
    """Returns (lat, lon, country_code_upper, region_label)."""
    print(f"\n[GEOCODE] '{name}' ...")
    for cc_filter in (['ro'], []):
        params = {'q': name, 'format': 'json', 'limit': 1, 'addressdetails': 1}
        if cc_filter:
            params['countrycodes'] = 'ro'
        try:
            r = requests.get(NOMINATIM_URL, params=params, headers=HEADERS, timeout=15)
            r.raise_for_status()
            results = r.json()
        except requests.RequestException as exc:
            raise RuntimeError(f"Nominatim failed: {exc}") from exc

        if results:
            hit  = results[0]
            lat  = float(hit['lat'])
            lon  = float(hit['lon'])
            addr = hit.get('address', {})
            cc   = addr.get('country_code', 'ro').upper()
            region = (addr.get('county')
                      or addr.get('state')
                      or addr.get('country', 'Romania'))
            print(f"         → {hit['display_name'][:90]}")
            print(f"         → ({lat:.5f}, {lon:.5f})  [{cc}]")
            return lat, lon, cc, region

    raise ValueError(f"Could not geocode '{name}'. "
                     "Try adding ', Romania' or the county name.")

# ── ELEVATION ─────────────────────────────────────────────────────────────────
def get_elevation_single(lat, lon) -> float:
    try:
        r = requests.get(ELEVATION_URL,
                         params={'locations': f'{lat},{lon}'},
                         headers=HEADERS, timeout=15)
        r.raise_for_status()
        return float(r.json()['results'][0]['elevation'] or 300.0)
    except Exception:
        return 300.0

def get_elevations_batch(coords: list, skip: bool = False) -> list:
    if skip or not coords:
        return [300.0] * len(coords)
    results = []
    n = len(coords)
    for i in range(0, n, ELEV_BATCH):
        batch   = coords[i: i + ELEV_BATCH]
        loc_str = '|'.join(f'{lat},{lon}' for lat, lon in batch)
        print(f"  [ELEV] {i+1}–{min(i+ELEV_BATCH, n)}/{n} ...", end='\r', flush=True)
        try:
            r = requests.get(ELEVATION_URL,
                             params={'locations': loc_str},
                             headers=HEADERS, timeout=30)
            r.raise_for_status()
            results.extend(float(x['elevation'] or 300.0)
                           for x in r.json()['results'])
        except Exception as e:
            print(f"\n  [WARN] Elevation batch {i}–{i+ELEV_BATCH}: {e}")
            results.extend([300.0] * len(batch))
        if i + ELEV_BATCH < n:
            time.sleep(ELEV_DELAY)
    print()
    return results

# ── SOURCE 1a: WIKIDATA ───────────────────────────────────────────────────────
def fetch_wikidata(lat: float, lon: float, radius_km: float) -> list:
    print('[WIKIDATA] Querying SPARQL ...')
    sparql = f"""
SELECT DISTINCT ?item ?itemLabel ?coord ?typeLabel WHERE {{
  VALUES ?type {{ wd:Q32489 wd:Q23397 wd:Q4022 wd:Q355304 }}
  ?item wdt:P31 ?type .
  SERVICE wikibase:around {{
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point({lon} {lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "{radius_km}" .
  }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,ro,fr,de" . }}
}}
LIMIT 100"""

    try:
        r = requests.get(
            WIKIDATA_URL,
            params={'query': sparql, 'format': 'json'},
            headers={**HEADERS, 'Accept': 'application/sparql-results+json'},
            timeout=60,
        )
        r.raise_for_status()
        bindings = r.json()['results']['bindings']
    except Exception as e:
        print(f'  [WARN] Wikidata: {e}')
        return []

    items = []
    for b in bindings:
        raw = b.get('coord', {}).get('value', '')
        m   = re.match(r'Point\(([+-]?\d+\.?\d*)\s+([+-]?\d+\.?\d*)\)', raw)
        if not m:
            continue
        c_lon, c_lat = float(m.group(1)), float(m.group(2))
        qid   = b.get('item',      {}).get('value', '').split('/')[-1]
        name  = b.get('itemLabel', {}).get('value') or f'WD-{qid}'
        wtype = b.get('typeLabel', {}).get('value', 'water body')
        items.append({
            'id':           f'WD-{qid}',
            'name':         name,
            'lat':          c_lat,
            'lon':          c_lon,
            'area_km2':     None,
            'water_type':   wtype,
            'confidence':   80,
            'data_sources': ['wikidata'],
            'satellite_confirmed': False,
            'is_satellite_only':   False,
        })

    print(f'  [WIKIDATA] → {len(items)} items')
    return items

# ── SOURCE 1b: EEA WFD ───────────────────────────────────────────────────────
def fetch_eea(lat: float, lon: float, radius_km: float, country_code: str = 'RO') -> list:
    print('[EEA WFD] Querying REST API ...')
    south, west, north, east = bbox(lat, lon, radius_km)

    # Try country-filtered query first, fall back to spatial-only
    for where in [f"COUNTRY_CODE='{country_code}'", f"MS='{country_code}'", '1=1']:
        try:
            params = {
                'f':                 'geojson',
                'where':             where,
                'geometry':          f'{west},{south},{east},{north}',
                'geometryType':      'esriGeometryEnvelope',
                'inSR':              '4326',
                'outSR':             '4326',
                'outFields':         'WB_NAME,COUNTRY_CODE,MS,OBJECTID',
                'resultRecordCount': '200',
                'spatialRel':        'esriSpatialRelIntersects',
            }
            r = requests.get(EEA_URL, params=params, headers=HEADERS, timeout=60)
            r.raise_for_status()
            feats = r.json().get('features', [])
            if feats:
                break
        except Exception as e:
            print(f'  [WARN] EEA ({where[:30]}): {e}')
            feats = []

    items = []
    for f in feats:
        geom  = f.get('geometry', {})
        props = f.get('properties', {})
        gtype = geom.get('type', '')

        if gtype == 'Point':
            c_lon, c_lat = geom['coordinates']
        elif gtype == 'Polygon':
            c_lon, c_lat = _poly_centroid(geom['coordinates'][0])
        elif gtype == 'MultiPolygon':
            c_lon, c_lat = _poly_centroid(geom['coordinates'][0][0])
        else:
            continue

        if c_lon is None:
            continue

        name = (props.get('WB_NAME') or props.get('NAME')
                or f"EEA-{props.get('OBJECTID', '?')}")
        items.append({
            'id':           f"EEA-{props.get('OBJECTID', name)}",
            'name':         name,
            'lat':          float(c_lat),
            'lon':          float(c_lon),
            'area_km2':     None,
            'water_type':   'WFD water body',
            'confidence':   80,
            'data_sources': ['eea-wfd'],
            'satellite_confirmed': False,
            'is_satellite_only':   False,
        })

    print(f'  [EEA WFD] → {len(items)} items')
    return items

# ── SOURCE 1c: HYDROLAKES ─────────────────────────────────────────────────────
def fetch_hydrolakes(lat: float, lon: float, radius_km: float, csv_path: str) -> list:
    print('[HYDROLAKES] Scanning CSV ...')
    if not os.path.exists(csv_path):
        print(f'  [INFO] Not found: {csv_path}  (skip with --hydrolakes-csv /dev/null)')
        return []
    items = []
    try:
        with open(csv_path, newline='', encoding='utf-8-sig') as f:
            for row in csv.DictReader(f):
                try:
                    r_lat  = float(row['Pour_lat'])
                    r_lon  = float(row['Pour_long'])
                    area   = float(row.get('Lake_area') or 0)
                except (ValueError, KeyError):
                    continue
                if area < 0.1:
                    continue
                if haversine_km(lat, lon, r_lat, r_lon) > radius_km:
                    continue
                hid  = row.get('Hylak_id', '')
                name = row.get('Lake_name', '').strip() or f'Lake HL-{hid}'
                items.append({
                    'id':           f'HL-{hid}',
                    'name':         name,
                    'lat':          r_lat,
                    'lon':          r_lon,
                    'area_km2':     round(area, 4),
                    'water_type':   'lake',
                    'confidence':   80,
                    'data_sources': ['hydrolakes'],
                    'satellite_confirmed': False,
                    'is_satellite_only':   False,
                })
    except Exception as e:
        print(f'  [WARN] HydroLAKES: {e}')
        return []

    print(f'  [HYDROLAKES] → {len(items)} lakes ≥0.1 km² within {radius_km} km')
    return items

# ── SOURCE 2: COPERNICUS GEE ──────────────────────────────────────────────────
def fetch_sentinel_gee(lat: float, lon: float, radius_km: float,
                        period: str = 'all') -> list:
    print('[GEE] Sentinel-1/2 water detection ...')

    # June = peak snowmelt / high water; September = end-of-dry-season permanent water only.
    # Using all three years of each month for a robust multi-year composite.
    _PERIOD_CFG = {
        'jun': ('2023-06-01', '2025-07-01', [6]),
        'sep': ('2023-09-01', '2025-10-01', [9]),
        'all': ('2023-06-01', '2025-10-01', [6, 9]),
    }
    s2_start, _S2_END, _months = _PERIOD_CFG.get(period, _PERIOD_CFG['all'])

    # Restrict composite to the target calendar months only
    if len(_months) == 1:
        _month_filter = ee.Filter.calendarRange(_months[0], _months[0], 'month')
    else:
        _month_filter = ee.Filter.Or(
            *[ee.Filter.calendarRange(m, m, 'month') for m in _months])

    south, west, north, east = bbox(lat, lon, radius_km)
    roi = ee.Geometry.Rectangle([west, south, east, north])

    try:
        # ── Sentinel-2: MNDWI = (B3-B11)/(B3+B11) > 0.2 ─────────────────
        print('  [GEE] S2 MNDWI composite ...')
        s2_col = (
            ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
            .filterDate(s2_start, _S2_END)
            .filterBounds(roi)
            .filter(_month_filter)
            .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
        )
        s2_mndwi = (s2_col
                    .map(lambda img: img.normalizedDifference(['B3', 'B11']).rename('MNDWI'))
                    .mean())
        mndwi_mask = s2_mndwi.select('MNDWI').gt(0.2)

        # ── Sentinel-1: VV backscatter < -18 dB ──────────────────────────
        print('  [GEE] S1 SAR composite ...')
        s1_col = (
            ee.ImageCollection('COPERNICUS/S1_GRD')
            .filterDate(s2_start, _S2_END)
            .filterBounds(roi)
            .filter(_month_filter)
            .filter(ee.Filter.eq('instrumentMode', 'IW'))
            .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
            .select('VV')
        )
        sar_mask = s1_col.mean().select('VV').lt(-18)

        # ── High-confidence: both sensors agree ───────────────────────────
        high_conf = mndwi_mask.And(sar_mask).selfMask()

        # ── Vectorize at 30m, filter polygons > 50 pixels (≈1.35 ha) ─────
        print('  [GEE] Vectorizing (scale=30 m) ...')
        vectors = high_conf.reduceToVectors(
            geometry=roi,
            scale=30,
            geometryType='polygon',
            eightConnected=True,
            reducer=ee.Reducer.countEvery(),
            maxPixels=int(1e9),
            bestEffort=True,
        )
        large = vectors.filter(ee.Filter.gt('count', 50)).limit(60, 'count', False)

        # Add centroid + area server-side to minimize data transfer
        def _add_centroid(feat):
            c      = feat.geometry().centroid(maxError=30)
            coords = c.coordinates()
            count  = ee.Number(feat.get('count'))
            return feat.set({
                'c_lon':    coords.get(0),
                'c_lat':    coords.get(1),
                'area_km2': count.multiply(0.0009),
                'px_count': count,
            }).setGeometry(c)

        print('  [GEE] getInfo() — may take 60–120 s ...')
        info = large.map(_add_centroid).getInfo()

    except Exception as e:
        print(f'  [WARN] GEE detection failed: {e}')
        return []

    items = []
    for i, feat in enumerate(info.get('features', []), start=1):
        p   = feat.get('properties', {})
        c_lat = _f(p.get('c_lat'))
        c_lon = _f(p.get('c_lon'))
        if c_lat is None or c_lon is None:
            continue
        px   = int(p.get('px_count') or 0)
        area = _f(p.get('area_km2'))
        conf = 92 if px > 200 else 75

        items.append({
            'id':               f'SAT-{i:03d}',
            'name':             f'Sentinel water body #{i}',
            'lat':              c_lat,
            'lon':              c_lon,
            'area_km2':         area,
            'pixel_count':      px,
            'water_type':       'open water (satellite)',
            'confidence':       conf,
            'detection_method': 'Sentinel-2 MNDWI>0.2 AND Sentinel-1 VV<−18 dB',
            'data_sources':     ['sentinel-2', 'sentinel-1'],
            'satellite_confirmed': True,
            'is_satellite_only':   True,   # may be cleared during merge
        })

    print(f'  [GEE] → {len(items)} high-confidence water bodies')
    return items

# ── MERGE: DATABASE + SATELLITE ───────────────────────────────────────────────
def merge_sources(db_items: list, sat_items: list) -> list:
    """
    For each satellite detection: if it is within MERGE_M of a database entry,
    boost DB confidence +15 (cap 97) and flag satellite_confirmed=True.
    Unmatched satellite detections are appended as-is (is_satellite_only=True).
    """
    merged = [dict(i) for i in db_items]

    for sat in sat_items:
        s_lat, s_lon = sat['lat'], sat['lon']
        best, best_d = None, float('inf')
        for db in merged:
            d = haversine_km(s_lat, s_lon, db['lat'], db['lon']) * 1000
            if d < best_d:
                best_d, best = d, db

        if best and best_d <= MERGE_M:
            best['confidence']          = min(97, best['confidence'] + 15)
            best['satellite_confirmed'] = True
            best['is_satellite_only']   = False
            for src in sat.get('data_sources', []):
                if src not in best['data_sources']:
                    best['data_sources'].append(src)
            if best.get('area_km2') is None:
                best['area_km2'] = sat.get('area_km2')
        else:
            merged.append(dict(sat))

    return merged

# ── GEOJSON FEATURE BUILDER ───────────────────────────────────────────────────
_seq = 0

def build_feature(item: dict, c_lat: float, c_lon: float,
                  c_elev: float, s_elev: float, default_region: str) -> dict:
    global _seq
    _seq += 1
    lat, lon = item['lat'], item['lon']
    dist     = haversine_km(c_lat, c_lon, lat, lon)
    cost     = calc_cost(dist, s_elev, c_elev)
    conf     = item['confidence']
    status   = derive_status(conf, item.get('satellite_confirmed', False),
                              item.get('is_satellite_only', False))

    return {
        'type': 'Feature',
        'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
        'properties': {
            # Core identity
            'id':      item.get('id', f'H2O-{_seq:03d}'),
            'name':    item.get('name', 'Unnamed water body'),
            'region':  item.get('region') or default_region,
            'lat':     lat,
            'lon':     lon,
            'area_km2': item.get('area_km2'),

            # Detection
            'reserve':     None,   # requires field measurement
            'confidence':  conf,
            'status':      status,
            'data_sources':         item.get('data_sources', []),
            'satellite_confirmed':  item.get('satellite_confirmed', False),
            'detection_disclaimer': DETECTION_DISCLAIMER,

            # Logistics
            'distance_km':  round(dist, 2),
            'elevation_m':  round(s_elev),
            'eu_eligible':  cost['total'] < 500_000,

            # Cost
            'cost_eur':      cost['total'],
            'cost_breakdown': {
                'pipeline':  cost['pipeline'],
                'pump':      cost['pump'],
                'treatment': cost['treatment'],
                'labor':     cost['labor'],
            },

            # Frontend schema compatibility (springs.json fields)
            'satellite': {
                'sentinel1_sar_anomaly': None,
                'sentinel2_ndwi':        None,
                'dem_slope_deg':         None,
                'last_pass_utc':         None,
                'orbit_direction':       None,
            },
            'geology_type':       None,
            'drainage_basin':     None,
            'catchment_area_km2': None,
            'nearest_village':    None,
            'aquifer_depth_m':    None,
        },
    }

# ── MAIN ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description='H2Oolkit multi-source water body detector v2')
    parser.add_argument('location', nargs='+',
                        help='Location name, e.g. "Vrancea, Romania"')
    parser.add_argument('--radius',   type=int, default=50,
                        help='Search radius in km (default: 50)')
    parser.add_argument('--sources',  choices=['all', 'database', 'satellite'],
                        default='all',
                        help='Which sources to query (default: all)')
    parser.add_argument('--period',   choices=['jun', 'sep', 'all'], default='all',
                        help='Seasonal window: jun=June 2023-25, sep=September 2023-25, all=both (default: all)')
    parser.add_argument('--hydrolakes-csv', dest='hl_csv', default=HL_CSV_DEFAULT,
                        help='Path to HydroLAKES Europe CSV')
    parser.add_argument('--no-elevation', action='store_true',
                        help='Skip elevation API (faster, less accurate costs)')
    args = parser.parse_args()

    location  = ' '.join(args.location)
    radius_km = args.radius
    run_db    = args.sources in ('all', 'database')
    run_sat   = args.sources in ('all', 'satellite')

    print()
    print('=' * 60)
    print('  H2Oolkit  |  Multi-Source Water Detector  v2')
    print('=' * 60)

    # 1 — Geocode ─────────────────────────────────────────────────────────────
    c_lat, c_lon, country_code, default_region = geocode(location)

    # 2 — Center elevation ────────────────────────────────────────────────────
    print('\n[ELEV] Center point elevation ...')
    c_elev = get_elevation_single(c_lat, c_lon) if not args.no_elevation else 300.0
    _, terrain_str = terrain_factor(c_elev)
    print(f'       → {c_elev:.0f} m  ({terrain_str})')

    # 3 — Pre-initialize GEE in main thread (thread-safe) ─────────────────────
    gee_ready = False
    if run_sat:
        try:
            ee.Initialize(project=PROJECT_ID)
            gee_ready = True
            print('[GEE] Initialized.')
        except Exception as e:
            print(f'[WARN] GEE not available — satellite source skipped: {e}')

    # 4 — Parallel fetch ──────────────────────────────────────────────────────
    print(f'\n[FETCH] Launching parallel queries'
          f'  (sources={args.sources}, radius={radius_km} km) ...')

    db_items, sat_items = [], []
    source_counts = {}

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {}
        if run_db:
            futures['wikidata']   = pool.submit(fetch_wikidata,
                                                c_lat, c_lon, radius_km)
            futures['eea-wfd']    = pool.submit(fetch_eea,
                                                c_lat, c_lon, radius_km, country_code)
            futures['hydrolakes'] = pool.submit(fetch_hydrolakes,
                                                c_lat, c_lon, radius_km, args.hl_csv)
        if run_sat and gee_ready:
            futures['sentinel']   = pool.submit(fetch_sentinel_gee,
                                                c_lat, c_lon, radius_km, args.period)

        for name, fut in futures.items():
            try:
                result = fut.result(timeout=300)
            except concurrent.futures.TimeoutError:
                print(f'  [WARN] {name}: timed out after 300 s')
                result = []
            except Exception as e:
                print(f'  [WARN] {name}: {e}')
                result = []
            source_counts[name] = len(result)
            if name == 'sentinel':
                sat_items.extend(result)
            else:
                db_items.extend(result)

    # 5 — Filter to radius, deduplicate within DB sources ─────────────────────
    db_items  = [i for i in db_items
                 if haversine_km(c_lat, c_lon, i['lat'], i['lon']) <= radius_km]
    sat_items = [i for i in sat_items
                 if haversine_km(c_lat, c_lon, i['lat'], i['lon']) <= radius_km]
    db_items  = dedup_proximity(db_items, threshold_m=DEDUP_M)

    # 6 — Merge DB + Satellite ────────────────────────────────────────────────
    print(f'\n[MERGE] {len(db_items)} DB + {len(sat_items)} satellite ...')
    merged = merge_sources(db_items, sat_items)
    n_cross = sum(1 for i in merged
                  if i.get('satellite_confirmed') and not i.get('is_satellite_only'))
    print(f'        → {len(merged)} total  ({n_cross} cross-confirmed)')

    # 7 — Batch elevations ────────────────────────────────────────────────────
    coords = [(i['lat'], i['lon']) for i in merged]
    print(f'\n[ELEV] Fetching {len(coords)} water body elevations ...')
    elevations = get_elevations_batch(coords, skip=args.no_elevation)

    # 8 — Build GeoJSON features ──────────────────────────────────────────────
    features = [
        build_feature(item, c_lat, c_lon, c_elev, elev, default_region)
        for item, elev in zip(merged, elevations)
    ]
    features.sort(key=lambda f: f['properties']['cost_eur'])

    # 9 — Write output ────────────────────────────────────────────────────────
    geojson = {
        'type': 'FeatureCollection',
        'metadata': {
            'source':              'Wikidata + EEA WFD + HydroLAKES + Sentinel-1/2',
            'query_location':      location,
            'center':              {'lat': c_lat, 'lon': c_lon},
            'center_elevation_m':  round(c_elev),
            'radius_km':           radius_km,
            'water_body_count':    len(features),
            'cross_confirmed':     n_cross,
            'satellite_period':    args.period,
            'source_counts':       source_counts,
            'generated_at':        datetime.now(timezone.utc).isoformat(),
        },
        'features': features,
    }

    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    with open(OUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(geojson, f, indent=2, ensure_ascii=False)

    # 10 — Summary ────────────────────────────────────────────────────────────
    n_ver = sum(1 for f in features if f['properties']['status'] == 'verified')
    n_hip = sum(1 for f in features if f['properties']['status'] == 'high_priority')
    n_pen = sum(1 for f in features if f['properties']['status'] == 'pending')

    print()
    print('=' * 60)
    print('  SUMMARY')
    print('=' * 60)
    for src, cnt in source_counts.items():
        tag = '(satellite)' if src == 'sentinel' else '(database) '
        print(f'  {tag}  {src:<14}: {cnt:>4} raw features')
    print(f'  ─────────────────────────────────────')
    print(f'  Cross-confirmed     : {n_cross:>4}')
    print(f'  Total output        : {len(features):>4}  '
          f'({n_ver} verified / {n_hip} high-priority / {n_pen} pending)')
    print(f'  Output → {OUT_FILE}')
    print()

    if features:
        top = features[0]['properties']
        print(f'  Cheapest candidate: {top["name"]}')
        print(f'    Distance : {top["distance_km"]} km')
        print(f'    Elevation: {top["elevation_m"]} m')
        print(f'    Cost     : €{top["cost_eur"]:,}')
        print(f'    Status   : {top["status"]}')
    print()


if __name__ == '__main__':
    main()
