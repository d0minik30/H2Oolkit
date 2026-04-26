# Backend

Flask API and analysis engine for H2Oolkit. Runs on port `5000` by default and is consumed by the static frontend in the project root.

## Run

From the project root, with the virtual environment activated:

```bash
python -m backend.server
```

Then `GET http://localhost:5000/api/health` should return a healthy status.

## Modules

| File | Responsibility |
| --- | --- |
| `server.py` | Flask app, CORS, route definitions, request validation. |
| `analyzer.py` | Top-level analysis pipeline: gathers sources, ranks them, builds the response. |
| `osm.py` | Queries OpenStreetMap (Overpass) for water bodies and springs. |
| `eu_hydro.py` | Loads and queries the EU-Hydro hydrography dataset. |
| `spring_detector.py` | Satellite-based candidate spring detection (Sentinel-1 / Sentinel-2 via Earth Engine). |
| `elevation.py` | Elevation lookups along candidate routes. |
| `route_calculator.py` | Computes plausible piping routes between source and collection point. |
| `cost_estimator.py` | Estimates infrastructure cost for a given route and flow. |
| `water_reserve.py` | Reservoir / storage sizing helpers. |
| `weather.py` | Climatic / precipitation context for seasonal flow estimation. |
| `source_ranker.py` | Combines distance, elevation, demand and quality signals into a feasibility score. |

## Endpoints

- `GET /api/health` — service health check.
- `GET /api/water-sources?lat=&lon=&radius_m=` — every water body (OSM + EU-Hydro) within the radius.
- `POST /api/analyze/site` — full feasibility analysis for a collection point.
- `GET /api/eu-hydro/unlinked-springs?lat=&lon=&radius_m=` — EU-Hydro springs not yet linked to OSM.

See `server.py` for the authoritative list and request/response shapes.

## Dependencies

Listed in [requirements.txt](requirements.txt):

- `flask`, `flask-cors` — web framework and CORS support.
- `requests` — HTTP client for external services.
- `numpy` — numerical helpers.
- `earthengine-api` — Sentinel-1 / Sentinel-2 access (optional; only required for satellite spring detection).

Some features (e.g. PDF export) may pull in additional packages such as `reportlab`; install on demand if needed.

## External services

The backend talks to several external endpoints. Network access is required at runtime:

- OpenStreetMap Overpass API
- EU-Hydro / Copernicus hydrography data
- Elevation provider
- Google Earth Engine (optional; needs an authenticated account)
