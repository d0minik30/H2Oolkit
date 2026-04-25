"""Elevation lookup via Open-Topo-Data (SRTM 30m resolution, free, no API key)."""

import requests

TOPO_URL = "https://api.opentopodata.org/v1/srtm30m"
_TIMEOUT = 15
_BATCH_SIZE = 100  # API limit per request


def get_elevation(lat: float, lon: float) -> float:
    """Return elevation in metres for a single point. Returns 0.0 on failure."""
    results = get_elevations_batch([{"lat": lat, "lon": lon}])
    return results[0] if results else 0.0


def get_elevations_batch(points: list[dict]) -> list[float]:
    """
    Return elevations in metres for a list of {"lat": ..., "lon": ...} dicts.

    Splits into batches of 100 (API limit). Returns 0.0 for any failed point.
    Order is preserved.
    """
    if not points:
        return []

    results: list[float] = []
    for i in range(0, len(points), _BATCH_SIZE):
        batch = points[i : i + _BATCH_SIZE]
        results.extend(_fetch_batch(batch))
    return results


def _fetch_batch(points: list[dict]) -> list[float]:
    locations = "|".join(f"{p['lat']},{p['lon']}" for p in points)
    try:
        resp = requests.get(TOPO_URL, params={"locations": locations}, timeout=_TIMEOUT)
        resp.raise_for_status()
        return [
            float(r.get("elevation") or 0.0)
            for r in resp.json().get("results", [])
        ]
    except Exception:
        return [0.0] * len(points)
