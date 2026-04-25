"""
process_pipeline.py  —  H2Oolkit Data Processing Pipeline
==========================================================
Reads all acquired raw data and produces the two files the Leaflet
frontend consumes directly:

    data/springs.json      — attribute table (array of spring objects)
    data/springs.geojson   — GeoJSON with spring points + village zones

Run order (once per target area):
    1. py extraction/download_hydrolakes.py
    2. py extraction/fetch_villages.py
    3. py extraction/fetch_springs.py "Vrancea, Romania" --radius 100
    4. py extraction/extract_satellite.py          (optional, enriches SAR/NDWI)
    5. py extraction/process_pipeline.py

Usage:
    py extraction/process_pipeline.py
    py extraction/process_pipeline.py --max-springs 40
    py extraction/process_pipeline.py --springs-file data/springs_results.geojson
"""

import os, sys, json, csv, math, argparse
from collections import defaultdict
from datetime import datetime, timedelta, timezone

_ROOT = os.path.join(os.path.dirname(__file__), '..')

# ── INPUT PATHS ───────────────────────────────────────────────────────────────
IN_SPRINGS   = os.path.normpath(os.path.join(_ROOT, 'data', 'springs_results.geojson'))
IN_SAT_GRID  = os.path.normpath(os.path.join(_ROOT, 'data', 'satellite_grid.csv'))
IN_VILLAGES  = os.path.normpath(os.path.join(_ROOT, 'data', 'villages_romania.json'))

# ── OUTPUT PATHS ──────────────────────────────────────────────────────────────
OUT_JSON     = os.path.normpath(os.path.join(_ROOT, 'data', 'springs.json'))
OUT_GEOJSON  = os.path.normpath(os.path.join(_ROOT, 'data', 'springs.geojson'))

MAX_RESERVE      = 700      # m³/day cap — must match frontend MAX_RESERVE
VILLAGE_LINK_KM  = 30.0    # max km to link a village to a spring


# ── GEOMETRY ──────────────────────────────────────────────────────────────────

def haversine_km(lat1, lon1, lat2, lon2) -> float:
    R = 6_371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return R * 2 * math.asin(math.sqrt(max(0.0, a)))


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


# ── WATER RESERVE ESTIMATION ──────────────────────────────────────────────────

def estimate_reserve(area_km2, elevation_m: float, sat_row: dict) -> int:
    """
    Estimate daily spring/water-body yield (m³/day).

    Base formula  — Rational Method adapted for Carpathian springs:
        Q = area_km2 × 1 000 000 m²/km² × 0.00178 m/day × C
    where 0.00178 m/day = 650 mm/year mean Romanian rainfall,
    and C = 0.45 runoff coefficient for mixed-forest mountain terrain.
    That gives Q ≈ 800 × area_km2 m³/day.

    Corrections applied on top:
      - Elevation bonus  (higher → more reliable recharge)
      - NDWI multiplier  (wetter spectral signal → higher yield)
    """
    if not area_km2 or area_km2 <= 0:
        area_km2 = 0.18     # conservative default for small springs

    base = area_km2 * 800.0

    # Elevation correction
    if elevation_m > 900:
        terrain = 1.30
    elif elevation_m > 500:
        terrain = 1.15
    elif elevation_m > 200:
        terrain = 1.00
    else:
        terrain = 0.85      # lowland water bodies recharge more slowly

    # NDWI correction from satellite grid (if available)
    ndwi_mult = 1.0
    if sat_row:
        ndwi = sat_row.get('NDWI')
        if ndwi is not None:
            if ndwi > 0.35:
                ndwi_mult = 1.25
            elif ndwi > 0.15:
                ndwi_mult = 1.10
            elif ndwi < 0.0:
                ndwi_mult = 0.85

    return int(clamp(base * terrain * ndwi_mult, 30, MAX_RESERVE))


# ── SATELLITE TELEMETRY ───────────────────────────────────────────────────────

def sar_anomaly(vv_db) -> float:
    """Normalise Sentinel-1 VV dB to [0, 1] water-anomaly score.
    Open water: VV < −18 dB.  Dry land: VV ≈ −10 to −18 dB."""
    if vv_db is None:
        return None
    return round(clamp((-18.0 - float(vv_db)) / 12.0, 0.0, 1.0), 3)


def ndwi_clamp(raw) -> float:
    if raw is None:
        return None
    return round(clamp(float(raw), -1.0, 1.0), 3)


def slope_from_elevation(elev: float) -> float:
    """Rough DEM slope proxy from elevation (Carpathian heuristic)."""
    if elev < 200:
        return round(2.5 + elev / 200 * 3.5, 1)
    if elev < 600:
        return round(6.0 + (elev - 200) / 400 * 9.0, 1)
    return round(15.0 + (elev - 600) / 500 * 15.0, 1)


def sentinel_last_pass(lon: float) -> str:
    """Estimate most recent Sentinel-1 pass (6-day repeat, deterministic)."""
    now = datetime.now(timezone.utc)
    # Sentinel-1 repeats every 6 days; offset by fractional longitude
    days_back = (lon % 6) * (6.0 / 360.0)
    lp = now - timedelta(days=days_back)
    lp = lp.replace(
        hour=int((abs(lon) * 3 + 1) % 24),
        minute=int((abs(lon) * 37) % 60),
        second=0, microsecond=0,
    )
    return lp.isoformat()


def orbit_direction(lat: float, lon: float) -> str:
    return 'ascending' if (int(lat * 10) + int(lon * 10)) % 2 == 0 else 'descending'


# ── GEOLOGY & HYDROLOGY INFERENCE ────────────────────────────────────────────

_GEOLOGY_MAP = {
    'vrancea': 'flysch_sandstone',   'buzău':    'flysch_sandstone',
    'bacău':   'flysch_sandstone',   'suceava':  'flysch_sandstone',
    'neamț':   'limestone_karst',    'prahova':  'crystalline_schist',
    'covasna': 'volcanic_tuff',      'harghita': 'volcanic_tuff',
    'mureș':   'limestone_karst',    'cluj':     'limestone_karst',
    'bihor':   'limestone_karst',    'sibiu':    'granite_gneiss',
    'brașov':  'crystalline_schist', 'argeș':    'granite_gneiss',
    'dâmbovița': 'crystalline_schist',
}

def infer_geology(region: str, elevation_m: float) -> str:
    key = region.strip().lower()
    if key in _GEOLOGY_MAP:
        return _GEOLOGY_MAP[key]
    if elevation_m > 1000:
        return 'granite_gneiss'
    if elevation_m > 600:
        return 'crystalline_schist'
    if elevation_m > 300:
        return 'limestone_karst'
    return 'alluvial_gravel'


def infer_drainage_basin(lat: float, lon: float) -> str:
    if lon > 28.0:                          return 'Prut'
    if lon > 26.5 and lat < 46.5:          return 'Siret'
    if lon > 26.0 and lat < 45.5:          return 'Buzău'
    if lon > 25.0 and lat > 46.5:          return 'Moldova'
    if lon > 25.0 and lat > 45.5:          return 'Olt'
    if lon > 24.5 and lat > 46.0:          return 'Mureș'
    if lon > 24.0 and lat < 45.5:          return 'Dâmbovița'
    if lon > 23.0 and lat > 47.0:          return 'Someș'
    if lon > 23.0:                          return 'Mureș'
    return 'Crișuri'


# ── SATELLITE GRID LOADER ─────────────────────────────────────────────────────

def load_sat_grid(csv_path: str) -> tuple:
    """
    Returns (sep_grid, jun_grid) — one dict per season, each mapping
    (lat_r2, lon_r2) → {VV, VH, NDVI, NDWI, NDRE}.

    Sep grid = dry-season composite (prefer sep_2025 → sep_2024 → sep_2023).
    Jun grid = wet-season composite (prefer jun_2025 → jun_2024 → jun_2023).
    Both are needed so spring_detector gets true ndvi_dry (Sep) and ndvi_wet (Jun).
    """
    if not os.path.exists(csv_path):
        print(f'  [INFO] satellite_grid.csv not found — using confidence proxies')
        return {}, {}

    raw: dict = defaultdict(list)
    with open(csv_path, newline='', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            try:
                lat = round(float(row['lat']), 2)
                lon = round(float(row['lon']), 2)
                raw[(lat, lon)].append(row)
            except (ValueError, KeyError):
                continue

    def _build_season(period_prefs):
        grid = {}
        for key, rows in raw.items():
            chosen = next(
                (r for p in period_prefs for r in rows if r.get('period') == p),
                None,
            )
            if chosen is None:
                continue
            grid[key] = {
                k: (float(v) if v not in ('', 'None', None) else None)
                for k, v in chosen.items()
                if k not in ('lat', 'lon', 'period')
            }
        return grid

    sep_grid = _build_season(['sep_2025', 'sep_2024', 'sep_2023'])
    jun_grid = _build_season(['jun_2025', 'jun_2024', 'jun_2023'])

    print(f'  [SAT GRID] {len(sep_grid)} Sep cells, {len(jun_grid)} Jun cells  ({csv_path})')
    return sep_grid, jun_grid


def nearest_grid_cell(lat: float, lon: float, grid: dict, max_km: float = 45.0):
    """Return the spectral values of the nearest grid cell, or None."""
    if not grid:
        return None
    best_key, best_d = None, float('inf')
    for g_lat, g_lon in grid:
        d = haversine_km(lat, lon, g_lat, g_lon)
        if d < best_d:
            best_d, best_key = d, (g_lat, g_lon)
    return grid[best_key] if best_d <= max_km else None


# ── VILLAGE LOADER & LINKER ───────────────────────────────────────────────────

def load_villages(json_path: str) -> list:
    if not os.path.exists(json_path):
        print(f'  [INFO] villages_romania.json not found — no village zones in output')
        return []
    with open(json_path, encoding='utf-8') as f:
        data = json.load(f)
    feats = data.get('features', [])
    print(f'  [VILLAGES] {len(feats)} village zone features loaded')
    return feats


def link_villages(village_features: list, spring_locs: list) -> tuple:
    """
    Mutates each village feature in-place to set linked_spring_id.
    Returns (linked_features, spring_id → nearest_village_name mapping).
    """
    if not village_features or not spring_locs:
        return village_features, {}

    sp_nearest: dict[str, str] = {}   # spring_id → closest village name

    for vf in village_features:
        p = vf['properties']
        v_lat = p.get('lat') or vf['geometry']['coordinates'][0][0][1]
        v_lon = p.get('lon') or vf['geometry']['coordinates'][0][0][0]
        water_need = p.get('water_need_m3_day', 0)

        best_id, best_d = None, float('inf')
        for sp in spring_locs:
            d = haversine_km(v_lat, v_lon, sp['lat'], sp['lon'])
            if d < best_d:
                best_d, best_id = d, sp['id']

        if best_id and best_d <= VILLAGE_LINK_KM:
            p['linked_spring_id'] = best_id
            # Record nearest village for each spring (prefer highest water need)
            if (best_id not in sp_nearest
                    or water_need > sp_nearest.get(best_id + '_need', 0)):
                sp_nearest[best_id] = p['village_name']
                sp_nearest[best_id + '_need'] = water_need

    return village_features, sp_nearest


# ── CORE BUILD ────────────────────────────────────────────────────────────────

def build_outputs(springs_raw: list, sat_grid_sep: dict, sat_grid_jun: dict,
                  village_feats: list, max_springs: int) -> tuple:
    """
    Returns (springs_json_list, geojson_features_list).
    springs_json_list  → written to data/springs.json
    geojson_features_list → written to data/springs.geojson
    """
    # Sort by confidence descending, then take top N
    pool = sorted(springs_raw, key=lambda x: -x.get('confidence', 0))[:max_springs]

    springs_json   = []
    geo_springs    = []
    spring_locs    = []

    for i, sp in enumerate(pool, start=1):
        sp_id       = f'SP-{i:03d}'
        lat         = float(sp['lat'])
        lon         = float(sp['lon'])
        elevation_m = int(sp.get('elevation_m') or 300)
        region      = sp.get('region') or 'Romania'
        confidence  = int(sp.get('confidence') or 75)
        status      = sp.get('status') or 'pending'
        area_km2    = sp.get('area_km2')
        distance_km = sp.get('distance_km') or round(
            haversine_km(lat, lon, lat + 0.01, lon + 0.01), 2)
        cost_eur    = int(sp.get('cost_eur') or 150_000)

        # ── Satellite enrichment (Sep = dry season, Jun = wet season) ────
        sat_sep = nearest_grid_cell(lat, lon, sat_grid_sep)
        sat_jun = nearest_grid_cell(lat, lon, sat_grid_jun)

        vv       = sat_sep.get('VV')   if sat_sep else None
        ndwi_raw = sat_sep.get('NDWI') if sat_sep else None
        ndvi_sep_raw = sat_sep.get('NDVI') if sat_sep else None  # dry-season NDVI
        ndvi_jun_raw = sat_jun.get('NDVI') if sat_jun else None  # wet-season NDVI

        # Fall back to confidence-derived proxies when no grid data
        sar_val  = (sar_anomaly(vv)
                    if vv is not None
                    else round(clamp((confidence - 55) / 45, 0.05, 0.97), 2))
        ndwi_val = (ndwi_clamp(ndwi_raw)
                    if ndwi_raw is not None
                    else round(clamp((confidence - 60) / 45, 0.05, 0.85), 2))
        # NDVI dry/wet — use actual values when available, else estimate from confidence
        ndvi_dry_val = (ndwi_clamp(ndvi_sep_raw)
                        if ndvi_sep_raw is not None
                        else round(clamp((confidence - 60) / 45, 0.05, 0.85), 2))
        ndvi_wet_val = (ndwi_clamp(ndvi_jun_raw)
                        if ndvi_jun_raw is not None
                        else round(clamp((confidence - 50) / 45, 0.10, 0.90), 2))

        # ── Derived fields ───────────────────────────────────────────────
        reserve  = estimate_reserve(area_km2, elevation_m, sat_row)
        geology  = infer_geology(region, elevation_m)
        basin    = sp.get('drainage_basin') or infer_drainage_basin(lat, lon)
        catchment = sp.get('catchment_area_km2') or round(
            (area_km2 or 0.2) * 14.0, 1)
        aquifer_depth = sp.get('aquifer_depth_m') or max(5, elevation_m // 35)

        # ── springs.json record ──────────────────────────────────────────
        springs_json.append({
            'id':          sp_id,
            'name':        sp.get('name') or f'Water Source {sp_id}',
            'region':      region,
            'reserve':     reserve,
            'confidence':  confidence,
            'distance_km': distance_km,
            'cost_eur':    cost_eur,
            'status':      status,
            'satellite': {
                'sentinel1_sar_anomaly': sar_val,
                'sentinel2_ndwi':        ndwi_val,
                'ndvi_dry':              ndvi_dry_val,
                'ndvi_wet':              ndvi_wet_val,
                'dem_slope_deg':         slope_from_elevation(elevation_m),
                'last_pass_utc':         sentinel_last_pass(lon),
                'orbit_direction':       orbit_direction(lat, lon),
            },
        })

        # ── springs.geojson point feature ────────────────────────────────
        geo_springs.append({
            'type': 'Feature',
            'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
            'properties': {
                'feature_type':       'spring',
                'id':                 sp_id,
                'elevation_m':        elevation_m,
                'geology_type':       geology,
                'drainage_basin':     basin,
                'catchment_area_km2': catchment,
                'nearest_village':    sp.get('nearest_village'),   # patched below
                'aquifer_depth_m':    aquifer_depth,
                'land_cover':         sp.get('land_cover'),
                'area_km2':           area_km2,
                'data_sources':       sp.get('data_sources', []),
                'satellite_confirmed': sp.get('satellite_confirmed', False),
            },
        })

        spring_locs.append({'id': sp_id, 'lat': lat, 'lon': lon})

    # ── Link villages and back-fill nearest_village ───────────────────────────
    linked_feats, sp_village_map = link_villages(village_feats, spring_locs)

    for gf in geo_springs:
        sp_id = gf['properties']['id']
        if not gf['properties']['nearest_village'] and sp_id in sp_village_map:
            gf['properties']['nearest_village'] = sp_village_map[sp_id]

    # Keep only villages that got linked to a spring
    linked_zones = [vf for vf in linked_feats
                    if vf['properties'].get('linked_spring_id')]

    return springs_json, geo_springs + linked_zones


# ── MAIN ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='H2Oolkit data processing pipeline')
    parser.add_argument('--springs-file', default=IN_SPRINGS,
                        help=f'Input springs GeoJSON (default: springs_results.geojson)')
    parser.add_argument('--max-springs', type=int, default=50,
                        help='Max springs to include in output (default: 50)')
    args = parser.parse_args()

    print()
    print('=' * 60)
    print('  H2Oolkit  |  Data Processing Pipeline')
    print('=' * 60)

    # 1 — Load raw springs ────────────────────────────────────────────────────
    print(f'\n[LOAD] {args.springs_file}')
    if not os.path.exists(args.springs_file):
        print(f'  [ERROR] File not found.')
        print(f'  Run first: py extraction/fetch_springs.py "Romania" --radius 300')
        sys.exit(1)

    with open(args.springs_file, encoding='utf-8') as f:
        raw_gj = json.load(f)

    springs_raw = []
    for feat in raw_gj.get('features', []):
        props = feat.get('properties', {})
        coords = feat.get('geometry', {}).get('coordinates', [0.0, 0.0])
        springs_raw.append({**props, 'lat': coords[1], 'lon': coords[0]})
    print(f'  → {len(springs_raw)} raw features')

    # 2 — Load satellite grid ─────────────────────────────────────────────────
    print(f'\n[LOAD] {IN_SAT_GRID}')
    sat_grid_sep, sat_grid_jun = load_sat_grid(IN_SAT_GRID)

    # 3 — Load villages ───────────────────────────────────────────────────────
    print(f'\n[LOAD] {IN_VILLAGES}')
    villages = load_villages(IN_VILLAGES)

    # 4 — Build output ────────────────────────────────────────────────────────
    print(f'\n[PROCESS] Building frontend files (max {args.max_springs} springs) ...')
    springs_json, geo_features = build_outputs(
        springs_raw, sat_grid_sep, sat_grid_jun, villages, args.max_springs)

    n_springs  = sum(1 for f in geo_features
                     if f['properties'].get('feature_type') == 'spring')
    n_villages = sum(1 for f in geo_features
                     if f['properties'].get('feature_type') == 'village_zone')

    # 5 — Write springs.json ──────────────────────────────────────────────────
    with open(OUT_JSON, 'w', encoding='utf-8') as f:
        json.dump(springs_json, f, indent=2, ensure_ascii=False)

    # 6 — Write springs.geojson ───────────────────────────────────────────────
    geojson_out = {
        'type': 'FeatureCollection',
        'name': 'H2Oolkit Spring Sources & Village Zones',
        'crs':  {'type': 'name', 'properties': {
            'name': 'urn:ogc:def:crs:OGC:1.3:CRS84'}},
        'metadata': {
            'source':       'Wikidata + EEA WFD + HydroLAKES + Sentinel-1/2',
            'region':       raw_gj.get('metadata', {}).get('query_location', 'Romania'),
            'springs':      n_springs,
            'villages':     n_villages,
            'generated_at': datetime.now(timezone.utc).isoformat(),
        },
        'features': geo_features,
    }
    with open(OUT_GEOJSON, 'w', encoding='utf-8') as f:
        json.dump(geojson_out, f, indent=2, ensure_ascii=False)

    # 7 — Summary ─────────────────────────────────────────────────────────────
    n_ver = sum(1 for s in springs_json if s['status'] == 'verified')
    n_hip = sum(1 for s in springs_json if s['status'] == 'high_priority')
    n_pen = sum(1 for s in springs_json if s['status'] == 'pending')
    avg_res = (round(sum(s['reserve'] for s in springs_json) / len(springs_json))
               if springs_json else 0)

    print()
    print('=' * 60)
    print('  OUTPUT SUMMARY')
    print('=' * 60)
    print(f'  Springs   : {n_springs:>4}  '
          f'({n_ver} verified / {n_hip} high-priority / {n_pen} pending)')
    print(f'  Villages  : {n_villages:>4}  linked to nearest spring ≤{VILLAGE_LINK_KM} km')
    print(f'  Avg yield : {avg_res:>4} m³/day')
    print(f'  Total est.: €{sum(s["cost_eur"] for s in springs_json):,}')
    print()
    print(f'  → {OUT_JSON}')
    print(f'  → {OUT_GEOJSON}')
    print()


if __name__ == '__main__':
    main()
