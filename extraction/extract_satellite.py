"""
extract_satellite.py  —  H2Oolkit GEE Extraction
=================================================
Authenticates with Google Earth Engine (project: h2oolkit-hackathon),
builds a grid of points across Romania, then extracts Sentinel-1 and
Sentinel-2 derived values for three time windows.

Output: data/satellite_grid.csv
Columns: lat, lon, period, VV, VH, NDVI, NDWI, NDRE

Usage (from project root, venv active):
    py extraction/extract_satellite.py
    py extraction/extract_satellite.py --res 0.25   # finer grid
"""

import ee
import os
import sys
import argparse
import csv
from datetime import datetime, timedelta, timezone

# ── CONFIG ────────────────────────────────────────────────────────────────────
PROJECT_ID   = 'h2oolkit-hackathon'
GRID_RES     = 0.5          # degrees between grid points (0.25 for finer)
LAT_MIN, LAT_MAX = 43.5, 48.5
LON_MIN, LON_MAX = 22.0, 30.0
SAMPLE_SCALE = 1000         # metres — GEE extraction scale
CLOUD_PCT    = 30           # max cloud cover % for Sentinel-2 scenes

_ROOT = os.path.join(os.path.dirname(__file__), '..')
OUT_CSV = os.path.normpath(os.path.join(_ROOT, 'data', 'satellite_grid.csv'))

TODAY = datetime.now(timezone.utc)

PERIODS = {
    '6m':  (TODAY - timedelta(days=183),  TODAY),
    '1y':  (TODAY - timedelta(days=365),  TODAY),
    '10y': (TODAY - timedelta(days=3650), TODAY),
}

# ── AUTH ──────────────────────────────────────────────────────────────────────
def init_gee():
    try:
        ee.Initialize(project=PROJECT_ID)
        print(f"[GEE] Initialized — project: {PROJECT_ID}")
    except ee.EEException:
        print("[GEE] Not authenticated. Starting authentication flow ...")
        ee.Authenticate()
        ee.Initialize(project=PROJECT_ID)
        print("[GEE] Authenticated and initialized.")

# ── GRID ──────────────────────────────────────────────────────────────────────
def make_grid(res):
    """Return an ee.FeatureCollection of uniformly spaced points over Romania."""
    lat = LAT_MIN
    features = []
    while lat <= LAT_MAX + 1e-9:
        lon = LON_MIN
        while lon <= LON_MAX + 1e-9:
            features.append(
                ee.Feature(
                    ee.Geometry.Point([round(lon, 4), round(lat, 4)]),
                    {'lat': round(lat, 4), 'lon': round(lon, 4)}
                )
            )
            lon = round(lon + res, 4)
        lat = round(lat + res, 4)

    fc = ee.FeatureCollection(features)
    n  = len(features)
    print(f"[GRID] {n} points  (lat {LAT_MIN}–{LAT_MAX}, lon {LON_MIN}–{LON_MAX}, res={res}°)")
    return fc, n

# ── SENTINEL-1 ────────────────────────────────────────────────────────────────
def s1_composite(start_dt, end_dt):
    """Mean VV/VH backscatter over the date range (IW mode, dB)."""
    start = start_dt.strftime('%Y-%m-%d')
    end   = end_dt.strftime('%Y-%m-%d')
    col = (
        ee.ImageCollection('COPERNICUS/S1_GRD')
        .filterDate(start, end)
        .filter(ee.Filter.eq('instrumentMode', 'IW'))
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
        .select(['VV', 'VH'])
    )
    return col.mean()

# ── SENTINEL-2 ────────────────────────────────────────────────────────────────
def _mask_s2_clouds(image):
    qa          = image.select('QA60')
    cloud_mask  = qa.bitwiseAnd(1 << 10).eq(0)
    cirrus_mask = qa.bitwiseAnd(1 << 11).eq(0)
    return image.updateMask(cloud_mask.And(cirrus_mask))

def _add_indices(image):
    """Add NDVI, NDWI, NDRE bands (S2 SR reflectance ÷ 10000 → [0,1])."""
    scaled = image.divide(10000)
    B3 = scaled.select('B3')   # Green
    B4 = scaled.select('B4')   # Red
    B5 = scaled.select('B5')   # Red Edge
    B8 = scaled.select('B8')   # NIR

    ndvi = B8.subtract(B4).divide(B8.add(B4)).rename('NDVI')
    ndwi = B3.subtract(B8).divide(B3.add(B8)).rename('NDWI')
    ndre = B8.subtract(B5).divide(B8.add(B5)).rename('NDRE')

    return image.addBands([ndvi, ndwi, ndre])

def s2_composite(start_dt, end_dt):
    """Median cloud-masked Sentinel-2 composite with NDVI, NDWI, NDRE."""
    start = start_dt.strftime('%Y-%m-%d')
    end   = end_dt.strftime('%Y-%m-%d')

    col = (
        ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterDate(start, end)
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', CLOUD_PCT))
        .map(_mask_s2_clouds)
        .map(_add_indices)
        .select(['NDVI', 'NDWI', 'NDRE'])
    )
    return col.median()

# ── EXTRACT ONE PERIOD ────────────────────────────────────────────────────────
def extract_period(grid_fc, period_name, start_dt, end_dt):
    start_s = start_dt.strftime('%Y-%m-%d')
    end_s   = end_dt.strftime('%Y-%m-%d')
    print(f"\n[EXTRACT] {period_name}  ({start_s} → {end_s})")

    s1 = s1_composite(start_dt, end_dt)
    s2 = s2_composite(start_dt, end_dt)

    # Single combined image: VV, VH, NDVI, NDWI, NDRE
    combined = s1.addBands(s2)

    print(f"  Sampling {SAMPLE_SCALE}m scale at grid points ...")
    sampled = combined.reduceRegions(
        collection=grid_fc,
        reducer=ee.Reducer.mean(),
        scale=SAMPLE_SCALE,
    )

    print(f"  Calling getInfo() (may take 30–90 s) ...")
    try:
        info = sampled.getInfo()
    except ee.EEException as exc:
        print(f"  [WARN] GEE error for period {period_name}: {exc}")
        return []

    rows = []
    for feat in info['features']:
        p = feat['properties']
        rows.append({
            'lat':    p.get('lat'),
            'lon':    p.get('lon'),
            'period': period_name,
            'VV':     _fmt(p.get('VV')),
            'VH':     _fmt(p.get('VH')),
            'NDVI':   _fmt(p.get('NDVI')),
            'NDWI':   _fmt(p.get('NDWI')),
            'NDRE':   _fmt(p.get('NDRE')),
        })

    present = sum(1 for r in rows if r['VV'] is not None)
    print(f"  → {len(rows)} points sampled, {present} with S1 data")
    return rows

def _fmt(v, digits=5):
    """Round float, return None if missing."""
    if v is None:
        return None
    try:
        return round(float(v), digits)
    except (TypeError, ValueError):
        return None

# ── MAIN ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description='H2Oolkit GEE satellite extraction')
    parser.add_argument('--res', type=float, default=GRID_RES,
                        help=f'Grid resolution in degrees (default: {GRID_RES})')
    parser.add_argument('--periods', nargs='+', choices=list(PERIODS.keys()),
                        default=list(PERIODS.keys()),
                        help='Which time periods to extract (default: all)')
    args = parser.parse_args()

    print()
    print('=' * 56)
    print('  H2Oolkit  |  Satellite Grid Extraction')
    print('=' * 56)

    init_gee()
    grid_fc, n_points = make_grid(args.res)

    all_rows = []
    for period_name in args.periods:
        start_dt, end_dt = PERIODS[period_name]
        rows = extract_period(grid_fc, period_name, start_dt, end_dt)
        all_rows.extend(rows)

    if not all_rows:
        print('\n[ERROR] No data extracted. Check GEE credentials and project ID.')
        sys.exit(1)

    # Write CSV
    os.makedirs(os.path.dirname(OUT_CSV), exist_ok=True)
    fieldnames = ['lat', 'lon', 'period', 'VV', 'VH', 'NDVI', 'NDWI', 'NDRE']
    with open(OUT_CSV, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(all_rows)

    total_rows = len(all_rows)
    filled     = sum(1 for r in all_rows if r['NDVI'] is not None)
    print(f'\n[DONE] {total_rows} rows written → {OUT_CSV}')
    print(f'       {filled}/{total_rows} rows have S2 index data')

    # Quick summary
    import collections
    by_period = collections.Counter(r['period'] for r in all_rows)
    for p, c in sorted(by_period.items()):
        print(f'       {p}: {c} rows')

    print()

if __name__ == '__main__':
    main()
