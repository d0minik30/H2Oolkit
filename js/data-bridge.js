/**
 * data-bridge.js
 * Loads springs.json + springs.geojson, merges by id.
 * Separates village_zone polygon features from spring point features.
 *
 * NOTE: fetch() requires HTTP. Run: npx serve . OR python -m http.server 8000
 */

let _springs      = [];
let _villageZones = [];

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

    const springFeatures = geojson.features.filter(f => f.properties.feature_type !== 'village_zone');
    _villageZones        = geojson.features.filter(f => f.properties.feature_type === 'village_zone');

    const geoIndex = {};
    for (const feature of springFeatures) {
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
    console.warn('[data-bridge] Serve via HTTP: npx serve .');
    return [];
  }
}

function getSpringById(id) {
  return _springs.find(s => s.id === id) ?? null;
}

function getVillageZones() {
  return _villageZones;
}
