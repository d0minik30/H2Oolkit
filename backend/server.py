"""
H2Oolkit Flask API (real-time, no mock data)
============================================
Bridges the static-file frontend to the live analysis pipeline.

Endpoints
---------
    GET  /api/health
    GET  /api/water-sources?lat=&lon=&radius_m=
                Returns every water body (OSM + EU-Hydro) within the radius.
                Used by the frontend to draw blue dots immediately after a
                location search.
    POST /api/analyze/site
                Body: {
                    collection_point: { lat, lon },
                    search_center:    { lat, lon },   # optional (defaults to collection_point)
                    radius_m: int,                    # optional (default 10000)
                    population: int,                  # optional (default 500)
                    name: str                         # optional
                }
                Returns ranked sources with feasibility scores.
    GET  /api/eu-hydro/status
                Returns whether the local EU-Hydro GPKG file is loaded.

Run from the project root:
    py -m backend.server
"""

from __future__ import annotations

import os
import logging

from flask import Flask, jsonify, request, abort
from flask_cors import CORS

from .analyzer import analyze_village_water_supply
from .osm import search_all_water_sources, _haversine_m
from .copernicus_hydro import (
    query_eu_hydro_sources,
    annotate_sources_eu_hydro_link,
    is_available as eu_hydro_gpkg_available,
)
from .source_merger import merge_sources

logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(levelname)s %(message)s')
log = logging.getLogger('h2oolkit')

app = Flask(__name__)
CORS(app)


# ── Health ────────────────────────────────────────────────────────────────────

@app.get('/api/health')
def health():
    return jsonify({'status': 'ok', 'service': 'h2oolkit-backend'})


# ── Water sources (OSM + EU-Hydro) ────────────────────────────────────────────

@app.get('/api/water-sources')
def water_sources():
    """
    Discover every water body within radius_m of (lat, lon).

    Combines:
      - OpenStreetMap nodes/ways (springs, wells, streams, rivers, lakes)
      - EU-Hydro spring points not already present in OSM
    Each OSM source is annotated with its EU-Hydro linkage status.

    Query params: lat, lon, radius_m (default 10000)
    """
    try:
        lat = float(request.args['lat'])
        lon = float(request.args['lon'])
    except (KeyError, ValueError):
        abort(400, description='lat and lon query parameters are required')
    radius_m = int(request.args.get('radius_m', 10_000))

    log.info('Sources @ %.4f,%.4f r=%dm', lat, lon, radius_m)

    # OSM sources
    osm_sources = search_all_water_sources(lat, lon, radius_m)

    # EU-Hydro GPKG lake/reservoir sources
    eu_hydro_srcs = query_eu_hydro_sources(lat, lon, radius_m)

    # Merge — deduplicates overlapping OSM and EU-Hydro records
    sources = merge_sources(osm_sources, eu_hydro_srcs)

    # Annotate unmatched OSM sources with official water-body proximity
    sources = annotate_sources_eu_hydro_link(sources)

    _TYPE_PRIORITY = {'spring': 0, 'well': 1, 'lake': 2, 'reservoir': 2, 'river': 3, 'stream': 4}
    sources = [s for s in sources if s.get('source_type') in _TYPE_PRIORITY]
    sources.sort(key=lambda s: (_TYPE_PRIORITY.get(s['source_type'], 99), s['distance_m']))
    sources = sources[:15]

    return jsonify({
        'lat': lat,
        'lon': lon,
        'radius_m': radius_m,
        'sources': sources,
        'count': len(sources),
        'eu_hydro_available': eu_hydro_gpkg_available(),
    })


# ── Site feasibility analysis ─────────────────────────────────────────────────

@app.post('/api/analyze/site')
def analyze_site():
    """
    Run a full feasibility analysis for a collection point.

    Body:
        {
          "collection_point": { "lat": ..., "lon": ... },
          "search_center":    { "lat": ..., "lon": ... },   # optional
          "radius_m":   10000,                              # optional
          "population": 500,                                # optional
          "name":       "Search query"                      # optional
        }

    Response:
        {
          village: { lat, lon, elevation, population, name },
          ranked_sources: [ ... sorted by feasibility_score, includes
                              route, cost, scores, recommendation ... ],
          best_option, alternatives, weather, overall_confidence,
          recommendation, search_center, collection_point
        }
    """
    body = request.get_json(force=True, silent=True) or {}
    cp = body.get('collection_point') or {}
    sc = body.get('search_center') or cp

    if 'lat' not in cp or 'lon' not in cp:
        abort(400, description='collection_point with lat/lon is required')

    radius_m   = int(body.get('radius_m', 10_000))
    population = int(body.get('population', 500))
    name       = body.get('name') or 'Selected site'

    log.info(
        f'Site analysis: cp={cp["lat"]:.4f},{cp["lon"]:.4f} '
        f'sc={sc.get("lat", cp["lat"]):.4f},{sc.get("lon", cp["lon"]):.4f} '
        f'r={radius_m}m'
    )

    result = analyze_village_water_supply(
        village_lat=float(cp['lat']),
        village_lon=float(cp['lon']),
        village_population=population,
        radius_m=radius_m,
        village_name=name,
        include_feasibility=True,
        search_lat=float(sc.get('lat', cp['lat'])),
        search_lon=float(sc.get('lon', cp['lon'])),
        search_radius_m=radius_m,
    )

    # The ranker sorts by efficiency_score. Re-sort by feasibility_score
    # (0–100) so the frontend list matches the user's request: "starting
    # top to down with the one having the highest feasibility value".
    if result.get('ranked_sources'):
        result['ranked_sources'].sort(
            key=lambda s: s.get('feasibility_score', 0),
            reverse=True,
        )
        for new_rank, src in enumerate(result['ranked_sources'], start=1):
            src['feasibility_rank'] = new_rank
        result['best_option']  = result['ranked_sources'][0]
        result['alternatives'] = result['ranked_sources'][1:4]

    result['collection_point'] = {'lat': float(cp['lat']), 'lon': float(cp['lon'])}
    result['search_center']    = {'lat': float(sc.get('lat', cp['lat'])),
                                  'lon': float(sc.get('lon', cp['lon']))}
    return jsonify(result)


# ── EU-Hydro GPKG status (diagnostic) ────────────────────────────────────────

@app.get('/api/eu-hydro/status')
def eu_hydro_status():
    """Returns whether the local EU-Hydro GPKG is loaded and ready."""
    from .copernicus_hydro import _load_lakes, _load_rivers
    lakes  = _load_lakes()
    rivers = _load_rivers()
    return jsonify({
        'gpkg_available': eu_hydro_gpkg_available(),
        'lakes_loaded':   isinstance(lakes,  object) and lakes  is not False,
        'rivers_loaded':  isinstance(rivers, object) and rivers is not False,
    })


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
