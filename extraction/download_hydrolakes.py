"""
download_hydrolakes.py  —  H2Oolkit Lake Data Downloader
=========================================================
Fetches European lake and reservoir geometries from OpenStreetMap via the
Overpass API and writes them to the CSV format expected by fetch_springs.py.

Running the full Europe bbox in one shot would time out, so the script
splits the work into a row of latitude strips and merges the results.

Output: data/hydrolakes_europe.csv
Columns: Hylak_id, Lake_name, Pour_lat, Pour_long, Lake_area

Usage:
    py extraction/download_hydrolakes.py
    py extraction/download_hydrolakes.py --min-area 0.05   # include smaller lakes
    py extraction/download_hydrolakes.py --region romania  # Romania only (faster)
"""

import os, sys, csv, json, math, time, argparse, requests
from datetime import datetime, timezone

OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
HEADERS      = {'User-Agent': 'H2Oolkit/1.0 (CASSINI Hackathon 2026)'}

_ROOT   = os.path.join(os.path.dirname(__file__), '..')
OUT_CSV = os.path.normpath(os.path.join(_ROOT, 'data', 'hydrolakes_europe.csv'))

# Latitude bands to chunk the Europe query (avoids Overpass timeout)
EUROPE_LON_W, EUROPE_LON_E = -11.0, 40.0
EUROPE_STRIPS = [          # (lat_south, lat_north)
    (35.0, 42.0),          # South Europe
    (42.0, 48.0),          # Central Europe
    (48.0, 58.0),          # North-Central Europe
    (58.0, 72.0),          # Scandinavia
]

ROMANIA_BBOX = (43.5, 20.0, 48.5, 31.0)   # south, west, north, east

WATER_TYPES = 'lake|reservoir|lagoon|pond'


# ── HELPERS ───────────────────────────────────────────────────────────────────

def _approx_area_km2(el: dict) -> float:
    """Best-effort area estimate from OSM tags (m² tag or bounding box)."""
    tags = el.get('tags', {})
    for key in ('area', 'way_area'):
        raw = tags.get(key)
        if raw:
            try:
                return float(raw) / 1e6
            except (ValueError, TypeError):
                pass
    # Derive from bounding box if present
    bb = el.get('bounds')
    if bb:
        dlat = bb['maxlat'] - bb['minlat']
        dlon = bb['maxlon'] - bb['minlon']
        lat_mid = (bb['maxlat'] + bb['minlat']) / 2
        area = dlat * 111.0 * dlon * 111.0 * math.cos(math.radians(lat_mid))
        return abs(area)
    return None


def _center(el: dict):
    """Return (lat, lon) for a node or way-with-center."""
    if el['type'] == 'node':
        return el.get('lat'), el.get('lon')
    c = el.get('center', {})
    return c.get('lat'), c.get('lon')


# ── OVERPASS FETCH ────────────────────────────────────────────────────────────

def fetch_strip(south: float, west: float, north: float, east: float,
                min_area: float, retries: int = 3) -> list:
    query = f"""
[out:json][timeout:120];
(
  way["natural"="water"]["water"~"^({WATER_TYPES})$"]["name"]
      ({south},{west},{north},{east});
  relation["natural"="water"]["water"~"^({WATER_TYPES})$"]["name"]
      ({south},{west},{north},{east});
  way["landuse"="reservoir"]["name"]
      ({south},{west},{north},{east});
);
out center bounds tags;
"""
    for attempt in range(1, retries + 1):
        try:
            r = requests.post(OVERPASS_URL, data={'data': query},
                              headers=HEADERS, timeout=150)
            r.raise_for_status()
            return r.json().get('elements', [])
        except requests.exceptions.Timeout:
            print(f'    [WARN] Timeout on strip ({south:.0f}–{north:.0f}), '
                  f'attempt {attempt}/{retries}')
            time.sleep(10 * attempt)
        except Exception as e:
            print(f'    [WARN] Overpass error: {e}')
            return []
    return []


def elements_to_rows(elements: list, min_area: float, id_offset: int = 0) -> list:
    rows = []
    seen = set()
    for el in elements:
        osm_id = el.get('id', 0)
        if osm_id in seen:
            continue
        seen.add(osm_id)

        lat, lon = _center(el)
        if lat is None or lon is None:
            continue

        area = _approx_area_km2(el)
        if area is not None and area < min_area:
            continue
        if area is None:
            area = 0.2          # conservative fallback

        name = el.get('tags', {}).get('name', '').strip() or f'Lake-OSM-{osm_id}'

        rows.append({
            'Hylak_id':  f'OSM-{osm_id}',
            'Lake_name': name,
            'Pour_lat':  round(float(lat), 6),
            'Pour_long': round(float(lon), 6),
            'Lake_area': round(area, 5),
        })
    return rows


# ── MAIN ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='H2Oolkit lake data downloader')
    parser.add_argument('--min-area', type=float, default=0.1,
                        help='Minimum lake area in km² (default: 0.1)')
    parser.add_argument('--region', choices=['romania', 'europe'], default='romania',
                        help='Target region (default: romania — much faster)')
    args = parser.parse_args()

    print()
    print('=' * 56)
    print('  H2Oolkit  |  Lake Data Downloader  (OSM Overpass)')
    print('=' * 56)

    all_rows = []

    if args.region == 'romania':
        south, west, north, east = ROMANIA_BBOX
        print(f'\n[OVERPASS] Romania bbox ({south},{west} → {north},{east}) ...')
        els = fetch_strip(south, west, north, east, args.min_area)
        print(f'  → {len(els)} raw features')
        all_rows = elements_to_rows(els, args.min_area)

    else:  # europe — split into latitude strips
        for i, (lat_s, lat_n) in enumerate(EUROPE_STRIPS, start=1):
            print(f'\n[STRIP {i}/{len(EUROPE_STRIPS)}] lat {lat_s}–{lat_n} ...')
            els = fetch_strip(lat_s, EUROPE_LON_W, lat_n, EUROPE_LON_E, args.min_area)
            strip_rows = elements_to_rows(els, args.min_area, id_offset=len(all_rows))
            all_rows.extend(strip_rows)
            print(f'  → {len(strip_rows)} lakes  (total so far: {len(all_rows)})')
            if i < len(EUROPE_STRIPS):
                time.sleep(3)   # be polite to Overpass

    # Deduplicate by Hylak_id
    seen_ids = set()
    deduped = []
    for row in all_rows:
        if row['Hylak_id'] not in seen_ids:
            seen_ids.add(row['Hylak_id'])
            deduped.append(row)

    if not deduped:
        print('\n[ERROR] No lake data retrieved. Check network / Overpass status.')
        sys.exit(1)

    os.makedirs(os.path.dirname(OUT_CSV), exist_ok=True)
    fieldnames = ['Hylak_id', 'Lake_name', 'Pour_lat', 'Pour_long', 'Lake_area']
    with open(OUT_CSV, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(deduped)

    total_area = sum(r['Lake_area'] for r in deduped)
    print()
    print('=' * 56)
    print('  SUMMARY')
    print('=' * 56)
    print(f'  Lakes written : {len(deduped):>6}')
    print(f'  Total area    : {total_area:>10,.1f} km²')
    print(f'  Output        : {OUT_CSV}')
    print()


if __name__ == '__main__':
    main()
