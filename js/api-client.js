/**
 * api-client.js
 * Wrapper around the H2Oolkit Flask backend (`backend/server.py`).
 *
 * The backend is REQUIRED — there is no static-data fallback any more.
 * If `/api/health` doesn't respond the frontend shows an explicit error.
 */

const H2O_API = (() => {
  if (window.H2O_API_BASE) return window.H2O_API_BASE.replace(/\/$/, '');
  const host = window.location.hostname || 'localhost';
  return `http://${host}:5000`;
})();

async function checkBackend() {
  try {
    const r = await fetch(`${H2O_API}/api/health`, { method: 'GET' });
    return r.ok;
  } catch (_) {
    return false;
  }
}

async function fetchWaterSources(lat, lon, radius_m = 10000) {
  const r = await fetch(
    `${H2O_API}/api/water-sources?lat=${lat}&lon=${lon}&radius_m=${radius_m}`
  );
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).message || msg; } catch (_) {}
    throw new Error(msg);
  }
  return r.json();
}

async function analyzeSite({ collection_point, search_center, radius_m = 10000, name, population }) {
  const body = { collection_point, search_center, radius_m };
  if (name)       body.name = name;
  if (population) body.population = population;

  const r = await fetch(`${H2O_API}/api/analyze/site`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).message || msg; } catch (_) {}
    throw new Error(msg);
  }
  return r.json();
}

window.H2O = {
  base: H2O_API,
  checkBackend,
  fetchWaterSources,
  analyzeSite,
};
