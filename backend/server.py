"""
H2Oolkit Flask API
==================
Bridges the static-file frontend (`index.html` + `js/app.js`) to the
Python analysis modules (weather, spring detection, OSM, EU-Hydro, costing, PDF).

Endpoints
---------
    GET  /api/health
    GET  /api/springs
    GET  /api/springs/<id>
    POST /api/springs/<id>/analyze
    GET  /api/springs/<id>/report               (returns PDF download)
    POST /api/analyze/spring                    (lat/lon + custom satellite_data)
    POST /api/analyze/location                  (place name or lat/lon)
    POST /api/analyze/village                   (lat/lon + population)
    GET  /api/water-sources?lat=&lon=&radius_m=
    GET  /api/eu-hydro/unlinked-springs?lat=&lon=&radius_m=

Run from the project root with the venv active:

    py -m backend.server

Then the frontend (served on http://localhost:8000 by `python -m http.server`)
calls these endpoints at http://localhost:5000.
"""

from __future__ import annotations

import os
import tempfile
import logging
import requests
from pathlib import Path

from flask import Flask, jsonify, request, send_file, abort
from flask_cors import CORS

from .analyzer import analyze_spring_location, analyze_village_water_supply
from .osm import search_all_water_sources
from .pdf_generator import generate_report
from .eu_hydro import find_unlinked_springs
from .frontend_adapter import (
    load_springs,
    get_spring_by_id,
    spring_to_satellite_data,
    village_zone_to_dict,
)

logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(levelname)s %(message)s')
log = logging.getLogger('h2oolkit')

app = Flask(__name__)
CORS(app)   # allow browser at http://localhost:8000 to call us at :5000

_REPORT_DIR = Path(tempfile.gettempdir()) / 'h2oolkit_reports'
_REPORT_DIR.mkdir(exist_ok=True)


# ── Health ────────────────────────────────────────────────────────────────────

@app.get('/api/health')
def health():
    return jsonify({'status': 'ok', 'service': 'h2oolkit-backend'})


# ── Springs registry ──────────────────────────────────────────────────────────

@app.get('/api/springs')
def list_springs():
    springs, zones = load_springs()
    return jsonify({
        'springs': springs,
        'village_zones': [z.get('properties', {}) for z in zones],
        'count': len(springs),
    })


@app.get('/api/springs/<spring_id>')
def get_spring(spring_id: str):
    spring = get_spring_by_id(spring_id)
    if not spring:
        abort(404, description=f'Spring {spring_id} not found')
    return jsonify(spring)


# ── Live analysis ─────────────────────────────────────────────────────────────

@app.post('/api/springs/<spring_id>/analyze')
def analyze_known_spring(spring_id: str):
    """Run full live analysis on a stored spring (no body required)."""
    spring = get_spring_by_id(spring_id)
    if not spring:
        abort(404, description=f'Spring {spring_id} not found')

    nearest_village = _resolve_village_for_spring(spring_id, spring)
    satellite_data = spring_to_satellite_data(spring)

    log.info(f'Analyze {spring_id} @ {spring["lat"]:.4f},{spring["lon"]:.4f}')
    result = analyze_spring_location(
        lat=spring['lat'],
        lon=spring['lon'],
        satellite_data=satellite_data,
        nearest_village=nearest_village,
    )
    result['spring_id'] = spring_id
    result['cached'] = {
        'reserve_m3_day': spring.get('reserve'),
        'confidence_pct': spring.get('confidence'),
        'cost_eur':       spring.get('cost_eur'),
    }
    return jsonify(result)


@app.post('/api/analyze/spring')
def analyze_arbitrary_spring():
    """
    Analyse a candidate spring location.

    Request JSON: { lat, lon, satellite_data?: {...}, nearest_village?: {...} }
    If satellite_data is omitted, sane Carpathian defaults are used.
    """
    body = request.get_json(force=True, silent=True) or {}
    if 'lat' not in body or 'lon' not in body:
        abort(400, description='lat and lon are required')

    satellite_data = body.get('satellite_data') or _default_satellite_data()
    nearest_village = body.get('nearest_village')

    result = analyze_spring_location(
        lat=float(body['lat']),
        lon=float(body['lon']),
        satellite_data=satellite_data,
        nearest_village=nearest_village,
    )
    return jsonify(result)


@app.post('/api/analyze/location')
def analyze_location():
    """
    Location-centric analysis: accepts a place name OR lat/lon, geocodes if needed,
    then discovers and ranks water sources within a configurable radius.

    Request JSON: { "location": "Vrancea, Romania" }
                  OR { "lat": 45.7, "lon": 26.7 }
                  Optional: "radius_m" (default 5000), "population" (default 500)
    """
    body = request.get_json(force=True, silent=True) or {}

    if 'location' in body:
        try:
            lat, lon, location_name = _geocode_location(body['location'])
        except (ValueError, RuntimeError) as exc:
            abort(400, description=str(exc))
    elif 'lat' in body and 'lon' in body:
        lat, lon = float(body['lat']), float(body['lon'])
        location_name = body.get('name', f'{lat:.4f}, {lon:.4f}')
    else:
        abort(400, description='Provide "location" name or "lat"/"lon" coordinates')

    radius_m   = int(body.get('radius_m', 10_000))
    population = int(body.get('population', 500))

    log.info(f'Analyze location "{location_name}" @ {lat:.4f},{lon:.4f} r={radius_m}m')
    result = analyze_village_water_supply(
        village_lat=lat,
        village_lon=lon,
        village_population=population,
        radius_m=radius_m,
        village_name=location_name,
        include_feasibility=True,
    )
    result['query_location'] = {
        'lat': lat,
        'lon': lon,
        'name': location_name,
        'radius_m': radius_m,
    }
    return jsonify(result)


@app.post('/api/analyze/village')
def analyze_village():
    """
    Village-centric analysis.

    Request JSON: { lat, lon, population?, radius_m?, name? }
    Returns ranked water sources within the radius.
    """
    body = request.get_json(force=True, silent=True) or {}
    if 'lat' not in body or 'lon' not in body:
        abort(400, description='lat and lon are required')

    result = analyze_village_water_supply(
        village_lat=float(body['lat']),
        village_lon=float(body['lon']),
        village_population=int(body.get('population') or 500),
        radius_m=int(body.get('radius_m') or 10_000),
        village_elevation=body.get('elevation'),
        village_name=body.get('name', 'Village'),
    )
    return jsonify(result)


@app.get('/api/water-sources')
def water_sources():
    """
    Return all OSM water bodies near a point.

    Query params: lat, lon, radius_m (default 10000)
    """
    try:
        lat = float(request.args['lat'])
        lon = float(request.args['lon'])
    except (KeyError, ValueError):
        abort(400, description='lat and lon query parameters are required')
    radius_m = int(request.args.get('radius_m', 10_000))
    return jsonify({
        'lat': lat,
        'lon': lon,
        'radius_m': radius_m,
        'sources': search_all_water_sources(lat, lon, radius_m),
    })


# ── EU-Hydro ──────────────────────────────────────────────────────────────────

@app.get('/api/eu-hydro/unlinked-springs')
def eu_hydro_unlinked_springs():
    """
    Return spring sources from EU-Hydro that are NOT officially connected
    to any river or lake in the EU-Hydro water network.

    Query params: lat, lon, radius_m (default 10000)

    Response:
        {
          lat, lon, radius_m,
          unlinked: [ {eu_hydro_id, lat, lon, name, wbclass, ...} ],
          linked:   [ ... ],
          available: bool   — false if GEE is unreachable
        }
    """
    try:
        lat = float(request.args['lat'])
        lon = float(request.args['lon'])
    except (KeyError, ValueError):
        abort(400, description='lat and lon query parameters are required')

    radius_m = int(request.args.get('radius_m', 10_000))

    log.info(f'EU-Hydro unlinked springs @ {lat:.4f},{lon:.4f} r={radius_m}m')
    result = find_unlinked_springs(lat, lon, radius_m)

    return jsonify({
        'lat': lat,
        'lon': lon,
        'radius_m': radius_m,
        **result,
    })


# ── Report (PDF) ──────────────────────────────────────────────────────────────

@app.get('/api/springs/<spring_id>/report')
def spring_report(spring_id: str):
    spring = get_spring_by_id(spring_id)
    if not spring:
        abort(404, description=f'Spring {spring_id} not found')

    nearest_village = _resolve_village_for_spring(spring_id, spring)
    satellite_data = spring_to_satellite_data(spring)

    log.info(f'Report  {spring_id} @ {spring["lat"]:.4f},{spring["lon"]:.4f}')
    analysis = analyze_spring_location(
        lat=spring['lat'],
        lon=spring['lon'],
        satellite_data=satellite_data,
        nearest_village=nearest_village,
    )

    safe_name = ''.join(
        c for c in spring.get('name', spring_id) if c.isalnum() or c in '-_'
    )
    out_path = _REPORT_DIR / f'{spring_id}_{safe_name}.pdf'
    generate_report(analysis, str(out_path))

    return send_file(
        str(out_path),
        as_attachment=True,
        download_name=f'H2Oolkit_{spring_id}_{safe_name}.pdf',
        mimetype='application/pdf',
    )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _geocode_location(name: str) -> tuple:
    """Geocode a place name via Nominatim. Returns (lat, lon, display_name)."""
    url = 'https://nominatim.openstreetmap.org/search'
    params = {'q': name, 'format': 'json', 'limit': 1, 'addressdetails': 1}
    headers = {'User-Agent': 'H2Oolkit/1.0 (h2oolkit-hackathon)'}
    try:
        r = requests.get(url, params=params, headers=headers, timeout=15)
        r.raise_for_status()
        results = r.json()
    except requests.RequestException as exc:
        raise RuntimeError(f'Geocoding service unreachable: {exc}') from exc
    if not results:
        raise ValueError(f"Location not found: '{name}'. Try adding the country name.")
    hit = results[0]
    addr = hit.get('address', {})
    label = (
        addr.get('village') or addr.get('town') or addr.get('city')
        or addr.get('county') or addr.get('state') or name
    )
    return float(hit['lat']), float(hit['lon']), label


def _resolve_village_for_spring(spring_id: str, spring: dict) -> dict | None:
    """Find the village_zone polygon linked to this spring; return its centroid."""
    _, zones = load_springs()
    for zone in zones:
        props = zone.get('properties', {})
        if props.get('linked_spring_id') == spring_id:
            return village_zone_to_dict(zone)

    # Fall back to the spring's nearest_village name if known (no coords).
    name = spring.get('nearest_village')
    if name:
        return {
            'name': name,
            'lat': spring['lat'],
            'lon': spring['lon'] + 0.05,
            'population': 500,
        }
    return None


def _default_satellite_data() -> dict:
    """Sane defaults for a candidate spring with no telemetry yet."""
    return {
        'ndvi_dry':             0.45,
        'ndvi_wet':             0.55,
        'soil_moisture_summer': 0.40,
        'jrc_occurrence':       30.0,
        'slope_degrees':        12.0,
        'elevation':            500.0,
        'catchment_area_km2':   8.0,
        'distance_to_river_m':  600.0,
    }


# ── Error handlers ────────────────────────────────────────────────────────────

@app.errorhandler(400)
def _bad_request(e):
    return jsonify({'error': 'bad_request', 'message': str(e.description)}), 400


@app.errorhandler(404)
def _not_found(e):
    return jsonify({'error': 'not_found', 'message': str(e.description)}), 404


@app.errorhandler(500)
def _server_error(e):
    log.exception('Server error')
    return jsonify({'error': 'server_error', 'message': str(e)}), 500


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    host  = os.environ.get('H2O_HOST', '127.0.0.1')
    port  = int(os.environ.get('H2O_PORT', '5000'))
    debug = os.environ.get('H2O_DEBUG', '0') == '1'
    log.info(f'H2Oolkit backend → http://{host}:{port}')
    app.run(host=host, port=port, debug=debug)


if __name__ == '__main__':
    main()