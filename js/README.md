# Frontend JavaScript

Client-side logic for H2Oolkit. Plain ES modules served as static files alongside `index.html` — no build step.

## Files

| File | Responsibility |
| --- | --- |
| `app.js` | Main application: map setup (Leaflet), UI events, charts (Chart.js), result rendering, PDF export glue. |
| `api-client.js` | Thin wrapper around the backend HTTP API (`/api/health`, `/api/water-sources`, `/api/analyze/site`, …). |

## Conventions

- The frontend assumes the backend is reachable at `http://localhost:5000` during development.
- Map tiles and Leaflet are loaded from CDN in `index.html`.
- Dark mode is toggled by adding/removing the `dark` class on `<html>` and persisted in `localStorage` under the `theme` key.

## Local development

Serve the project root over HTTP (the page must not be opened via `file://` because of CORS):

```bash
python -m http.server 8000
```

Open <http://localhost:8000> and make sure the backend is also running on port `5000`.
