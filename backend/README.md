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
| `satellite.py` | Google Earth Engine satellite layer — Sentinel-2 NDVI, GLDAS soil moisture, JRC water occurrence, SRTM elevation/slope. |
| `copernicus_hydro.py` | Local EU-Hydro GPKG layer — loads `data/EU-Hydro.gpkg`, queries nearby lakes/reservoirs, annotates sources with official water-body proximity. |
| `source_merger.py` | Deduplication — merges overlapping OSM and EU-Hydro source records using a probabilistic distance + type formula. |
| `spring_detector.py` | Combines satellite signals into a spring probability score (0–1). |
| `source_ranker.py` | Combines distance, elevation, demand and quality signals into a feasibility score. |
| `route_calculator.py` | Computes pipeline routes via OSRM (real walking paths) with straight-line fallback. |
| `cost_estimator.py` | Estimates infrastructure requirements (pipe diameter, pressure class, feasibility). |
| `water_reserve.py` | Estimates sustainable daily water yield from catchment area and recharge. |
| `weather.py` | Fetches 10-year precipitation history and estimates groundwater recharge. |
| `elevation.py` | Batch elevation lookups via Open-Topo-Data SRTM. |

## Endpoints

- `GET /api/health` — service health check.
- `GET /api/water-sources?lat=&lon=&radius_m=` — every water body (OSM + EU-Hydro) within the radius.
- `POST /api/analyze/site` — full feasibility analysis for a collection point.
- `GET /api/eu-hydro/status` — whether the local EU-Hydro GPKG is loaded.

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
