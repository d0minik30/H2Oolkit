let _springs = [];
let _villages = [];

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
    for (const f of geojson.features) {
      geoIndex[f.properties.id] = {
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
        ...f.properties
      };
    }

    _springs = attributes.map(attr => ({ ...attr, ...(geoIndex[attr.id] ?? {}) }));
    return _springs;
  } catch (err) {
    console.warn('[data-bridge] loadSprings failed:', err.message);
    return [];
  }
}

async function loadVillages() {
  try {
    const res = await fetch('data/villages.json');
    if (!res.ok) throw new Error(`villages.json: HTTP ${res.status}`);
    _villages = await res.json();
    return _villages;
  } catch (err) {
    console.warn('[data-bridge] loadVillages failed:', err.message);
    return [];
  }
}

function getSpringById(id) { return _springs.find(s => s.id === id) ?? null; }
function getVillages()     { return _villages; }
