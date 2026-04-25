/**
 * data-bridge.js
 * Loads springs.json (sensor attributes) and springs.geojson (geometry + geology),
 * merges them by matching `id`, and exposes a unified springs array.
 *
 * NOTE: fetch() requires an HTTP server.
 * Run: npx serve . OR python -m http.server 8000
 */

let _springs = [];

async function loadSprings() {
  try {
    const [attrRes, geoRes] = await Promise.all([
      fetch('data/springs.json'),
      fetch('data/springs.geojson')
    ]);

    if (!attrRes.ok) throw new Error(`springs.json: HTTP ${attrRes.status}`);
    if (!geoRes.ok)  throw new Error(`springs.geojson: HTTP ${geoRes.status}`);

    const attributes = await attrRes.json();
    const geojson    = await geoRes.json();

    const geoIndex = {};
    for (const feature of geojson.features) {
      geoIndex[feature.properties.id] = {
        lat: feature.geometry.coordinates[1],
        lon: feature.geometry.coordinates[0],
        ...feature.properties
      };
    }

    _springs = attributes.map(attr => {
      const geo = geoIndex[attr.id] ?? {};
      return { ...attr, ...geo };
    });

    return _springs;

  } catch (err) {
    console.warn('[data-bridge] Failed to load data files:', err.message);
    console.warn('[data-bridge] Make sure the app is served via HTTP, not file://');
    return [];
  }
}

function getSpringById(id) {
  return _springs.find(s => s.id === id) ?? null;
}
