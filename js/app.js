/* app.js — H2Oolkit */

const MAX_RESERVE = 900;

const STATUS_LABEL = { verified: 'Verified', high_priority: 'High Priority', pending: 'Pending Review' };
const STATUS_COLOR = { verified: '#2563eb', high_priority: '#dc2626', pending: '#b45309' };

const TYPE_ICON = {
  spring:    `<svg viewBox="0 0 24 24"><path d="M12 2c-5.33 4.55-8 8.48-8 11.8 0 4.98 3.8 8.2 8 8.2s8-3.22 8-8.2C20 10.48 17.33 6.55 12 2z"/></svg>`,
  stream:    `<svg viewBox="0 0 24 24"><path d="M1.5 12c0-1 .8-1.8 1.8-1.8C5.1 10.2 5 12 7 12s2-1.8 3.8-1.8S13 12 15 12s2-1.8 3.8-1.8c1 0 1.8.8 1.8 1.8s-.8 1.8-1.8 1.8C17 13.8 17 16 15 16s-2-1.8-3.8-1.8S9 16 7 16s-2-1.8-3.8-1.8c-.9 0-1.7-.8-1.7-1.8z"/></svg>`,
  lake:      `<svg viewBox="0 0 24 24"><ellipse cx="12" cy="14" rx="9" ry="5"/><path d="M12 2C9 2 6 5 6 9c0 3 3 5 6 5s6-2 6-5c0-4-3-7-6-7z"/></svg>`,
  reservoir: `<svg viewBox="0 0 24 24"><path d="M4 4h16v4H4zm0 6h16v10H4z"/></svg>`
};
const TYPE_COLOR = { spring: '#2563eb', stream: '#0284c7', lake: '#0891b2', reservoir: '#059669' };

const GEOLOGY_LABEL = {
  limestone_karst: 'Limestone Karst', alluvial_gravel: 'Alluvial Gravel',
  crystalline_schist: 'Crystalline Schist', volcanic_tuff: 'Volcanic Tuff',
  flysch_sandstone: 'Flysch Sandstone', granite_gneiss: 'Granite Gneiss'
};

function fmtCost(n) { return '€' + n.toLocaleString('de-DE'); }
function confColor(c) {
  if (c >= 90) return '#059669';
  if (c >= 80) return '#2563eb';
  if (c >= 70) return '#b45309';
  return '#dc2626';
}
function breakdown(total) {
  const pipeline = Math.round(total * 0.668), pump = Math.round(total * 0.197);
  return { pipeline, pump, treatment: total - pipeline - pump };
}
function fmtPassDate(utc) { return new Date(utc).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; }

/* ── STATE ───────────────────────────────────────── */
let appState = 'village-select'; // 'village-select' | 'point-select' | 'sources-visible'
let selectedVillage = null;
let collectionPoint = null;
let collectionMarker = null;
let _allVillages = [];

/* ── MAP ─────────────────────────────────────────── */
let leafletMap;
const markerRefs = {};
const villageMarkerRefs = {};
let _villageHighlight = null;
let _villageRadiusRing = null;

const ROMANIA_BOUNDS = L.latLngBounds([43.6, 20.2], [48.3, 30.0]);

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function initMap() {
  leafletMap = L.map('map', {
    center: [46.0, 25.0], zoom: 7, zoomControl: true,
    maxBounds: ROMANIA_BOUNDS, maxBoundsViscosity: 1.0, minZoom: 6
  });

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Imagery &copy; Esri', maxZoom: 19
  }).addTo(leafletMap);

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
    attribution: '', maxZoom: 19, opacity: 0.85
  }).addTo(leafletMap);

  const legend = L.control({ position: 'bottomleft' });
  legend.onAdd = () => {
    const d = L.DomUtil.create('div', 'map-legend');
    d.innerHTML = `
      <div class="legend-title">Legend</div>
      <div class="legend-item"><div class="legend-village-dot"></div>Village</div>
      <div class="legend-item"><div class="legend-source" style="background:#2563eb"></div>Spring</div>
      <div class="legend-item"><div class="legend-source" style="background:#0284c7"></div>Stream</div>
      <div class="legend-item"><div class="legend-source" style="background:#0891b2"></div>Lake / Reservoir</div>`;
    return d;
  };
  legend.addTo(leafletMap);
}

/* ── VILLAGE MARKERS ─────────────────────────────── */
function addVillageMarkers(villages) {
  villages.forEach(v => {
    const icon = L.divIcon({
      html: `<div class="vm-marker"><svg viewBox="0 0 24 24"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg></div>`,
      className: '', iconSize: [34, 34], iconAnchor: [17, 17]
    });
    const m = L.marker([v.lat, v.lon], { icon, zIndexOffset: 500 }).addTo(leafletMap)
      .bindTooltip(`<b>${v.name}</b><br>${v.county} — ${v.population.toLocaleString()} res.`, { sticky: true, className: 'line-tooltip' });
    m.on('click', () => enterPointSelect(v));
    villageMarkerRefs[v.id] = m;

    const latlngs = v.polygon.map(([lon, lat]) => [lat, lon]);
    L.polygon(latlngs, {
      color: '#f59e0b', weight: 1.8, dashArray: '5 4',
      fillColor: '#f59e0b', fillOpacity: 0.07, interactive: false
    }).addTo(leafletMap);
  });
}

/* ── WATER SOURCE MARKERS ────────────────────────── */
function addSourceMarkers(springs) {
  springs.forEach(sp => {
    const col = TYPE_COLOR[sp.type] ?? '#2563eb';
    const icon = L.divIcon({
      html: `<div class="src-marker" style="background:${col}"><svg viewBox="0 0 24 24" style="width:9px;height:9px;fill:#fff"><path d="M12 2c-1 2-5 6.5-5 9.5a5 5 0 0010 0C17 8.5 13 4 12 2z"/></svg></div>`,
      className: '', iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -14]
    });

    const distKm = () => collectionPoint
      ? haversineKm(collectionPoint.lat, collectionPoint.lon, sp.lat, sp.lon).toFixed(1)
      : sp.distance_km;

    const m = L.marker([sp.lat, sp.lon], { icon }).addTo(leafletMap);
    m.setOpacity(0);
    m.on('click', () => {
      if (appState !== 'sources-visible') return;
      selectSource(sp);
      const z = Math.min(leafletMap.getZoom() + 1, 13);
      leafletMap.setView([sp.lat, sp.lon], z, { animate: true, duration: 0.4 });
    });
    markerRefs[sp.id] = m;
  });
}

/* ── STATE: VILLAGE SELECT ───────────────────────── */
function enterVillageSelect() {
  appState = 'village-select';
  selectedVillage = null;
  collectionPoint = null;

  if (collectionMarker) { leafletMap.removeLayer(collectionMarker); collectionMarker = null; }
  if (_villageHighlight) { leafletMap.removeLayer(_villageHighlight); _villageHighlight = null; }
  if (_villageRadiusRing) { leafletMap.removeLayer(_villageRadiusRing); _villageRadiusRing = null; }

  leafletMap.off('click', onMapClickForPoint);
  document.getElementById('map').style.cursor = '';
  hideMapInstruction();

  _allSprings.forEach(sp => markerRefs[sp.id]?.setOpacity(0));
  renderVillageSelectPanel();
}

/* ── STATE: POINT SELECT ─────────────────────────── */
function enterPointSelect(village) {
  appState = 'point-select';
  selectedVillage = village;
  collectionPoint = null;

  if (collectionMarker) { leafletMap.removeLayer(collectionMarker); collectionMarker = null; }
  if (_villageRadiusRing) { leafletMap.removeLayer(_villageRadiusRing); _villageRadiusRing = null; }
  _allSprings.forEach(sp => markerRefs[sp.id]?.setOpacity(0));

  if (_villageHighlight) { leafletMap.removeLayer(_villageHighlight); }
  const latlngs = village.polygon.map(([lon, lat]) => [lat, lon]);
  _villageHighlight = L.polygon(latlngs, {
    color: '#dc2626', weight: 2.5,
    fillColor: '#dc2626', fillOpacity: 0.18
  }).addTo(leafletMap);

  leafletMap.flyTo([village.lat, village.lon], 13, { duration: 1.0 });
  leafletMap.on('click', onMapClickForPoint);
  document.getElementById('map').style.cursor = 'crosshair';
  showMapInstruction('Click on the map to set your water collection point');

  renderPointSelectPanel(village);
}

function onMapClickForPoint(e) {
  if (appState !== 'point-select') return;
  setCollectionPoint(e.latlng.lat, e.latlng.lng);
}

function setCollectionPoint(lat, lon) {
  leafletMap.off('click', onMapClickForPoint);
  document.getElementById('map').style.cursor = '';
  hideMapInstruction();

  collectionPoint = { lat, lon };

  if (collectionMarker) leafletMap.removeLayer(collectionMarker);
  const icon = L.divIcon({
    html: `<div class="cp-marker"><svg viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5S10.62 6.5 12 6.5s2.5 1.12 2.5 2.5S13.38 11.5 12 11.5z"/></svg></div>`,
    className: '', iconSize: [32, 32], iconAnchor: [16, 32]
  });
  collectionMarker = L.marker([lat, lon], { icon, zIndexOffset: 2000 }).addTo(leafletMap)
    .bindTooltip('Collection point', { permanent: false, className: 'line-tooltip' });

  enterSourcesVisible(lat, lon);
}

/* ── STATE: SOURCES VISIBLE ──────────────────────── */
function enterSourcesVisible(lat, lon) {
  appState = 'sources-visible';

  let nearby = _allSprings.filter(sp => haversineKm(lat, lon, sp.lat, sp.lon) <= 10);
  let fallback = false;

  if (nearby.length === 0) {
    fallback = true;
    nearby = [..._allSprings]
      .sort((a, b) => haversineKm(lat, lon, a.lat, a.lon) - haversineKm(lat, lon, b.lat, b.lon))
      .slice(0, 3);
  }

  _allSprings.forEach(sp => {
    const show = nearby.find(n => n.id === sp.id);
    markerRefs[sp.id]?.setOpacity(show ? 1 : 0);
  });

  if (_villageRadiusRing) leafletMap.removeLayer(_villageRadiusRing);
  _villageRadiusRing = L.circle([lat, lon], {
    radius: 10000, color: '#2563eb', weight: 1.5, dashArray: '7 5',
    fillOpacity: 0, interactive: false
  }).addTo(leafletMap);

  renderSourceListPanel(nearby, lat, lon, fallback);
}

/* ── MAP INSTRUCTION OVERLAY ─────────────────────── */
function showMapInstruction(text) {
  let el = document.getElementById('map-instruction');
  if (!el) {
    el = document.createElement('div');
    el.id = 'map-instruction';
    document.getElementById('map').appendChild(el);
  }
  el.textContent = text;
  el.style.display = 'block';
}
function hideMapInstruction() {
  const el = document.getElementById('map-instruction');
  if (el) el.style.display = 'none';
}

/* ── LOCATION SEARCH (map geocoding) ─────────────── */
function initLocationSearch() {
  const input   = document.getElementById('location-search');
  const results = document.getElementById('location-results');
  let timer;

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      results.style.display = 'none';
      results.innerHTML = '';
      if (q.length === 0) {
        if (_villageHighlight) { leafletMap.removeLayer(_villageHighlight); _villageHighlight = null; }
      }
      return;
    }
    timer = setTimeout(() => geocodeSearch(q, results), 340);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      results.style.display = 'none';
      input.value = '';
      input.blur();
    }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#map-overlay-search')) results.style.display = 'none';
  });

  const overlay = document.getElementById('map-overlay-search');
  if (overlay) {
    ['click', 'mousedown', 'dblclick', 'wheel'].forEach(ev =>
      overlay.addEventListener(ev, e => e.stopPropagation()));
  }
}

async function geocodeSearch(q, results) {
  const s = q.toLowerCase();
  const villageHits = _allVillages.filter(v =>
    v.name.toLowerCase().includes(s) || v.county.toLowerCase().includes(s));

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ', Romania')}&format=json&limit=5&countrycodes=ro`;
    const data = await (await fetch(url, { headers: { 'Accept-Language': 'en' } })).json();

    let html = '';
    villageHits.forEach(v => {
      html += `<div class="mos-item mos-village-hit" onclick="selectVillageById('${v.id}');document.getElementById('location-results').style.display='none';document.getElementById('location-search').value='${v.name}';">
        <svg class="mos-pin" viewBox="0 0 24 24" style="fill:#f59e0b"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
        <div><div class="mos-name">${v.name}</div><div class="mos-region">${v.county} County · ${v.population.toLocaleString()} residents</div></div>
      </div>`;
    });

    if (!data.length && !villageHits.length) {
      results.innerHTML = '<div class="mos-no-result">No results in Romania</div>';
      results.style.display = 'block'; return;
    }

    data.slice(0, 4).forEach(r => {
      const parts = r.display_name.split(',');
      html += `<div class="mos-item" onclick="flyToLocation(${r.lat},${r.lon},'${parts[0].replace(/'/g, "\\'")}')">
        <svg class="mos-pin" viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>
        <div><div class="mos-name">${parts[0]}</div><div class="mos-region">${parts.slice(1, 3).join(',').trim()}</div></div>
      </div>`;
    });

    results.innerHTML = html;
    results.style.display = 'block';
  } catch (e) {
    console.warn('[geocode]', e.message);
  }
}

function selectVillageById(id) {
  const v = _allVillages.find(v => v.id === id);
  if (v) enterPointSelect(v);
}

function flyToLocation(lat, lon, name) {
  leafletMap.flyTo([parseFloat(lat), parseFloat(lon)], 12, { duration: 1.2 });
  document.getElementById('location-results').style.display = 'none';
  document.getElementById('location-search').value = name;
}

/* ── DETAIL PANEL RENDERS ────────────────────────── */
function renderVillageSelectPanel() {
  document.getElementById('detail-panel').innerHTML = `
    <div class="dp-welcome">
      <div class="dp-welcome-icon">
        <svg viewBox="0 0 24 24"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
      </div>
      <div class="dp-welcome-title">Select a Village</div>
      <div class="dp-welcome-text">Click an orange marker on the map or search by village name to begin water source analysis.</div>
      <div class="dp-welcome-villages">
        ${_allVillages.map(v => `
          <button class="dp-village-btn" onclick="selectVillageById('${v.id}')">
            <span class="dp-vbtn-name">${v.name}</span>
            <span class="dp-vbtn-county">${v.county}</span>
          </button>`).join('')}
      </div>
    </div>`;
}

function renderPointSelectPanel(village) {
  document.getElementById('detail-panel').innerHTML = `
    <div class="dp-header">
      <div>
        <div class="dp-title">${village.name}</div>
        <div class="dp-sub">${village.county} County &middot; ${village.population.toLocaleString()} residents</div>
      </div>
      <button class="dp-back-btn" onclick="enterVillageSelect()">&#8592; Back</button>
    </div>
    <div class="dp-instruction-box">
      <svg viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5S10.62 6.5 12 6.5s2.5 1.12 2.5 2.5S13.38 11.5 12 11.5z"/></svg>
      <div>
        <div class="dp-instr-title">Set Collection Point</div>
        <div class="dp-instr-text">Click anywhere on the map to set your desired water collection point. All sources within 10 km will appear.</div>
      </div>
    </div>
    <div class="dp-section">
      <div class="dp-section-label">Village Profile</div>
      <div class="sat-grid">
        <div class="sat-cell"><div class="sat-lbl">Population</div><div class="sat-val">${village.population.toLocaleString()}</div></div>
        <div class="sat-cell"><div class="sat-lbl">Daily Need</div><div class="sat-val">${village.water_need_m3_day} m³</div></div>
        <div class="sat-cell sat-cell-full"><div class="sat-lbl">Water Access</div><div class="sat-val" style="color:#dc2626">${village.access_status}</div></div>
      </div>
    </div>`;
}

function renderSourceListPanel(sources, lat, lon, fallback) {
  const sorted = sources.map(sp => ({
    ...sp,
    calcDist: haversineKm(lat, lon, sp.lat, sp.lon)
  })).sort((a, b) => a.calcDist - b.calcDist);

  const villageName = selectedVillage?.name ?? '';

  document.getElementById('detail-panel').innerHTML = `
    <div class="dp-header">
      <div>
        <div class="dp-title">Water Sources</div>
        <div class="dp-sub">${villageName} &middot; ${sorted.length} source${sorted.length !== 1 ? 's' : ''} found${fallback ? ' (nearest — none within 10 km)' : ' within 10 km'}</div>
      </div>
      <button class="dp-back-btn" onclick="enterPointSelect(selectedVillage)">&#8592; Back</button>
    </div>
    <div class="src-list">
      ${sorted.map((sp, i) => {
        const col = TYPE_COLOR[sp.type] ?? '#2563eb';
        const cc  = confColor(sp.confidence);
        return `
        <div class="src-card" id="srcc-${sp.id}" onclick="selectSource(getSpringById('${sp.id}'))">
          <div class="src-card-left">
            <div class="src-icon" style="background:${col}20;color:${col}">${TYPE_ICON[sp.type] ?? TYPE_ICON.spring}</div>
            <div>
              <div class="src-name">${sp.name}</div>
              <div class="src-meta">${sp.type.charAt(0).toUpperCase() + sp.type.slice(1)} &middot; ${sp.calcDist.toFixed(1)} km away</div>
            </div>
          </div>
          <div class="src-card-right">
            <div class="src-reserve">${sp.reserve} <span>m³/d</span></div>
            <div class="src-conf" style="color:${cc}">${sp.confidence}%</div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

function selectSource(sp) {
  if (!sp) return;
  document.querySelectorAll('.src-card').forEach(c => c.classList.remove('src-card-active'));
  const card = document.getElementById(`srcc-${sp.id}`);
  if (card) card.classList.add('src-card-active');
  renderDetail(sp);
}

/* ── DETAIL VIEW ─────────────────────────────────── */
function renderDetail(sp) {
  const bd  = breakdown(sp.cost_eur);
  const cc  = confColor(sp.confidence);
  const sat = sp.satellite ?? {};

  const R = 52, CX = 70, CY = 70;
  const circ = 2 * Math.PI * R;
  const dash = (sp.confidence / 100) * circ;
  const feasLabel = sp.confidence >= 90 ? 'Excellent' : sp.confidence >= 80 ? 'High' : sp.confidence >= 70 ? 'Moderate' : 'Low';

  const distKm = collectionPoint
    ? haversineKm(collectionPoint.lat, collectionPoint.lon, sp.lat, sp.lon).toFixed(1)
    : sp.distance_km;
  const elevStr  = sp.elevation_m != null ? `${sp.elevation_m} m` : '—';
  const slopeStr = sat.dem_slope_deg != null ? `${sat.dem_slope_deg}° slope` : '';
  const col = TYPE_COLOR[sp.type] ?? '#2563eb';

  document.getElementById('detail-panel').innerHTML = `
    <div class="dp-header">
      <div>
        <div class="dp-title" style="display:flex;align-items:center;gap:7px">
          <span class="src-icon-sm" style="background:${col}20;color:${col}">${TYPE_ICON[sp.type] ?? TYPE_ICON.spring}</span>
          ${sp.name}
        </div>
        <div class="dp-sub">${sp.nearest_village} &middot; ${sp.type.charAt(0).toUpperCase() + sp.type.slice(1)}</div>
      </div>
      <button class="dp-back-btn" onclick="enterSourcesVisible(collectionPoint.lat,collectionPoint.lon)">&#8592; List</button>
    </div>

    <div class="dp-feas-wrap">
      <svg class="dp-feas-svg" viewBox="0 0 140 140">
        <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="var(--border)" stroke-width="11"/>
        <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${cc}" stroke-width="11"
          stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}" stroke-linecap="round"
          transform="rotate(-90 ${CX} ${CY})"/>
        <text x="${CX}" y="${CY - 7}" text-anchor="middle" fill="${cc}" font-size="26" font-weight="800" font-family="Outfit,sans-serif">${sp.confidence}%</text>
        <text x="${CX}" y="${CY + 13}" text-anchor="middle" fill="#94a3b8" font-size="11" font-family="Outfit,sans-serif">${feasLabel}</text>
      </svg>
      <div class="dp-feas-label">Feasibility Score</div>
    </div>

    <div class="dp-metric-grid">
      <div class="dp-metric-card">
        <div class="dp-metric-icon" style="background:rgba(37,99,235,.1)">
          <svg viewBox="0 0 24 24" fill="#2563eb"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>
        </div>
        <div class="dp-metric-val">${distKm} <span>km</span></div>
        <div class="dp-metric-lbl">Distance from point</div>
      </div>
      <div class="dp-metric-card">
        <div class="dp-metric-icon" style="background:rgba(5,150,105,.1)">
          <svg viewBox="0 0 24 24" fill="#059669"><path d="M3 17h4v4H3zm7-4h4v8h-4zm7-6h4v14h-4z"/></svg>
        </div>
        <div class="dp-metric-val">${elevStr}</div>
        <div class="dp-metric-lbl">Elevation${slopeStr ? ' · ' + slopeStr : ''}</div>
      </div>
      <div class="dp-metric-card">
        <div class="dp-metric-icon" style="background:rgba(0,212,170,.1)">
          <svg viewBox="0 0 24 24" fill="#00d4aa"><path d="M12 2c-5.33 4.55-8 8.48-8 11.8 0 4.98 3.8 8.2 8 8.2s8-3.22 8-8.2C20 10.48 17.33 6.55 12 2z"/></svg>
        </div>
        <div class="dp-metric-val">${sp.reserve} <span>m³/d</span></div>
        <div class="dp-metric-lbl">Water Output</div>
      </div>
    </div>

    <div class="dp-section">
      <div class="dp-section-label">Cost Estimate</div>
      <table class="cost-tbl">
        <tr><td>Pipeline construction</td><td>${fmtCost(bd.pipeline)}</td></tr>
        <tr><td>Pumping station</td><td>${fmtCost(bd.pump)}</td></tr>
        <tr><td>Water treatment unit</td><td>${fmtCost(bd.treatment)}</td></tr>
        <tr class="total-row"><td>Total Estimate</td><td>${fmtCost(sp.cost_eur)}</td></tr>
      </table>
    </div>

    <div class="dp-section">
      <div class="dp-section-label">EU Funding</div>
      <div class="eu-badge">&#10003; Eligible — POIM 2021–2027</div>
    </div>

    <div class="btn-row">
      <button class="btn btn-primary" onclick="generateReport('${sp.id}','${sp.name.replace(/'/g, "\\'")}')">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
        Report
      </button>
      <button class="btn btn-secondary" onclick="flagReview('${sp.id}','${sp.name.replace(/'/g, "\\'")}')">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z"/></svg>
        Flag
      </button>
    </div>`;
}

/* ── TABLE ───────────────────────────────────────── */
let _allSprings = [];

function filterSprings(q) {
  const s = q.toLowerCase().trim();
  if (!s) return _allSprings;
  return _allSprings.filter(sp =>
    sp.name.toLowerCase().includes(s) || sp.region.toLowerCase().includes(s) ||
    sp.id.toLowerCase().includes(s) || sp.nearest_village?.toLowerCase().includes(s));
}

function updateSearch(query) {
  const filtered = filterSprings(query);
  renderTable(filtered);
  const status = document.getElementById('search-status');
  status.innerHTML = (query.trim() && filtered.length < _allSprings.length)
    ? `<span class="search-count">${filtered.length} of ${_allSprings.length} match</span>` : '';
}

function renderTable(springs) {
  const tbody = document.getElementById('springs-tbody');
  if (springs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="no-results">No springs match your search</td></tr>`;
    document.getElementById('table-count').textContent = '0 sources'; return;
  }
  tbody.innerHTML = springs.map(sp => `
    <tr id="row-${sp.id}" onclick="handleRowClick('${sp.id}')">
      <td class="id-col">${sp.id}</td>
      <td class="name-col">${sp.name} <span>— ${sp.region}</span></td>
      <td>${sp.reserve}</td>
      <td><span style="color:${confColor(sp.confidence)};font-weight:700">${sp.confidence}%</span></td>
      <td>${sp.distance_km} km</td>
      <td>${fmtCost(sp.cost_eur)}</td>
      <td><span class="eu-ok">&#10003; POIM</span></td>
      <td><span class="sbadge sbadge-${sp.status}">${STATUS_LABEL[sp.status]}</span></td>
      <td><button class="btn-view" onclick="event.stopPropagation();viewSpring('${sp.id}')">View →</button></td>
    </tr>`).join('');
  document.getElementById('table-count').textContent = `${springs.length} source${springs.length !== 1 ? 's' : ''}`;
}

function handleRowClick(id) {
  const sp = getSpringById(id);
  if (!sp) return;
  document.querySelectorAll('.dtbl tbody tr').forEach(r => r.classList.remove('active-row'));
  document.getElementById(`row-${id}`)?.classList.add('active-row');
  markerRefs[id]?.openPopup();
  leafletMap.setView([sp.lat, sp.lon], 11, { animate: true });
}
function viewSpring(id) { handleRowClick(id); }

/* ── ANALYSIS ────────────────────────────────────── */
function renderAnalysis(springs, villages) {
  const maxRes = Math.max(...springs.map(s => s.reserve));
  const sorted = [...springs].sort((a, b) => b.reserve - a.reserve);

  document.getElementById('reserve-chart').innerHTML = sorted.map(sp => {
    const w = (sp.reserve / maxRes * 100).toFixed(1);
    const c = STATUS_COLOR[sp.status];
    return `<div class="bar-row">
      <div class="bar-label">${sp.name}<span class="bar-region"> ${sp.region}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${w}%;background:${c}"></div></div>
      <div class="bar-val">${sp.reserve}</div>
    </div>`;
  }).join('');

  document.getElementById('village-coverage').innerHTML = villages.map(v => {
    const col = v.access_status === 'No piped water' ? '#dc2626'
              : v.access_status === 'Seasonal shortages' ? '#b45309' : '#d97706';
    return `<div class="vc-row">
      <div class="vc-dot" style="background:${col}"></div>
      <div class="vc-info">
        <div class="vc-name">${v.name} <span class="vc-county">${v.county}</span></div>
        <div class="vc-status" style="color:${col}">${v.access_status}</div>
      </div>
      <div class="vc-meta">
        <div class="vc-pop">${v.population.toLocaleString()} res.</div>
        <div class="vc-need">${v.water_need_m3_day} m³/day</div>
      </div>
    </div>`;
  }).join('');
}

/* ── ACTIONS ─────────────────────────────────────── */
async function generateReport(id, name) {
  if (!(await H2O.checkBackend())) {
    alert(`PDF report generation needs the backend service.\n\nStart it with:\n  py -m backend.server`);
    return;
  }
  try {
    await H2O.downloadReport(id, `H2Oolkit_${id}_${name.replace(/[^a-z0-9_-]/gi, '')}.pdf`);
  } catch (err) {
    alert(`PDF generation failed: ${err.message}`);
  }
}

function flagReview(id, name) {
  alert(`${name} (${id}) flagged for field team review.`);
}

/* ── BELOW-MAP PANELS ────────────────────────────── */
function renderSourcesPanel(springs) {
  document.getElementById('sources-count').textContent = `${springs.length} detected`;
  document.getElementById('sources-list').innerHTML = springs.map(sp => {
    const col = TYPE_COLOR[sp.type] ?? '#2563eb';
    const cc  = confColor(sp.confidence);
    const barW = Math.round(sp.reserve / 900 * 100);
    return `
    <div class="bm-src-row">
      <div class="bm-src-icon" style="background:${col}18;color:${col}">${TYPE_ICON[sp.type] ?? TYPE_ICON.spring}</div>
      <div class="bm-src-info">
        <div class="bm-src-name">${sp.name}</div>
        <div class="bm-src-meta">${sp.nearest_village} &middot; ${sp.type.charAt(0).toUpperCase()+sp.type.slice(1)}</div>
        <div class="bm-src-bar-track"><div class="bm-src-bar-fill" style="width:${barW}%;background:${col}"></div></div>
      </div>
      <div class="bm-src-stats">
        <span class="bm-src-reserve">${sp.reserve} <em>m³/d</em></span>
        <span class="bm-src-conf" style="color:${cc}">${sp.confidence}%</span>
      </div>
    </div>`;
  }).join('');
}

function renderOverviewStats(springs, villages) {
  const total      = springs.length;
  const totalRes   = springs.reduce((s, sp) => s + sp.reserve, 0);
  const avgConf    = Math.round(springs.reduce((s, sp) => s + sp.confidence, 0) / total);
  const avgElev    = Math.round(springs.reduce((s, sp) => s + sp.elevation_m, 0) / total);
  const avgAquifer = Math.round(springs.reduce((s, sp) => s + sp.aquifer_depth_m, 0) / total);
  const best       = springs.reduce((a, b) => b.reserve > a.reserve ? b : a);
  const totalNeed  = villages.reduce((s, v) => s + v.water_need_m3_day, 0);
  const coverage   = Math.min(100, Math.round(totalRes / totalNeed * 100));
  const typeCount  = {};
  springs.forEach(sp => { typeCount[sp.type] = (typeCount[sp.type] ?? 0) + 1; });

  const coverageColor = coverage >= 80 ? '#059669' : coverage >= 50 ? '#b45309' : '#dc2626';
  const confColor2 = avgConf >= 90 ? '#059669' : avgConf >= 80 ? '#2563eb' : '#b45309';

  document.getElementById('overview-stats').innerHTML = `
    <div class="ov-hero">
      <div class="ov-hero-circle">
        <div class="ov-hero-val">${total}</div>
        <div class="ov-hero-lbl">sources</div>
      </div>
      <div class="ov-hero-side">
        <div class="ov-hero-tag">
          <svg viewBox="0 0 24 24" fill="#059669"><path d="M12 2c-5.33 4.55-8 8.48-8 11.8 0 4.98 3.8 8.2 8 8.2s8-3.22 8-8.2C20 10.48 17.33 6.55 12 2z"/></svg>
          Satellite-detected water sources
        </div>
        <div class="ov-hero-cap">${totalRes.toLocaleString()} <span>m³/day total capacity</span></div>
        <div class="ov-hero-villages">${villages.length} villages &middot; ${Object.keys(typeCount).length} source types</div>
      </div>
    </div>

    <div class="ov-stat-list">
      <div class="ov-stat-row">
        <div class="ov-stat-icon" style="background:rgba(37,99,235,.1)">
          <svg viewBox="0 0 24 24" fill="#2563eb"><path d="M12 2c-5.33 4.55-8 8.48-8 11.8 0 4.98 3.8 8.2 8 8.2s8-3.22 8-8.2C20 10.48 17.33 6.55 12 2z"/></svg>
        </div>
        <div class="ov-stat-body">
          <div class="ov-stat-label">Avg. Detection Confidence</div>
          <div class="ov-stat-bar-row">
            <div class="ov-stat-bar-track">
              <div class="ov-stat-bar-fill" style="width:${avgConf}%;background:${confColor2}"></div>
            </div>
            <div class="ov-stat-val" style="color:${confColor2}">${avgConf}%</div>
          </div>
        </div>
      </div>

      <div class="ov-stat-row">
        <div class="ov-stat-icon" style="background:rgba(5,150,105,.1)">
          <svg viewBox="0 0 24 24" fill="#059669"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
        </div>
        <div class="ov-stat-body">
          <div class="ov-stat-label">Village Water Need Covered</div>
          <div class="ov-stat-bar-row">
            <div class="ov-stat-bar-track">
              <div class="ov-stat-bar-fill" style="width:${coverage}%;background:${coverageColor}"></div>
            </div>
            <div class="ov-stat-val" style="color:${coverageColor}">${coverage}%</div>
          </div>
        </div>
      </div>

      <div class="ov-stat-row">
        <div class="ov-stat-icon" style="background:rgba(180,83,9,.1)">
          <svg viewBox="0 0 24 24" fill="#b45309"><path d="M3 17h4v4H3zm7-4h4v8h-4zm7-6h4v14h-4z"/></svg>
        </div>
        <div class="ov-stat-body">
          <div class="ov-stat-label">Average Source Elevation</div>
          <div class="ov-stat-number">${avgElev.toLocaleString()} <span>m above sea level</span></div>
        </div>
      </div>

      <div class="ov-stat-row">
        <div class="ov-stat-icon" style="background:rgba(8,145,178,.1)">
          <svg viewBox="0 0 24 24" fill="#0891b2"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
        </div>
        <div class="ov-stat-body">
          <div class="ov-stat-label">Avg. Aquifer Depth</div>
          <div class="ov-stat-number">${avgAquifer} <span>m underground</span></div>
        </div>
      </div>
    </div>

    <div class="ov-type-row">
      ${Object.entries(typeCount).map(([type, count]) => {
        const col = TYPE_COLOR[type] ?? '#2563eb';
        return `<div class="ov-type-chip" style="border-color:${col}30;background:${col}10;color:${col}">
          ${TYPE_ICON[type] ?? TYPE_ICON.spring}
          ${count} ${type}${count > 1 ? 's' : ''}
        </div>`;
      }).join('')}
    </div>

    <div class="ov-best-card">
      <div class="ov-best-eyebrow">Highest Output Source</div>
      <div class="ov-best-name">${best.name}</div>
      <div class="ov-best-details">
        <span>${best.reserve} m³/day</span>
        <span>${best.nearest_village}</span>
        <span>${best.confidence}% confidence</span>
        <span>${best.elevation_m} m elevation</span>
      </div>
    </div>`;
}

/* ── INIT ────────────────────────────────────────── */
async function init() {
  initMap();

  [_allVillages, _allSprings] = await Promise.all([loadVillages(), loadSprings()]);

  if (_allSprings.length === 0 || _allVillages.length === 0) {
    document.getElementById('detail-panel').innerHTML =
      `<p style="color:#dc2626;padding:16px;font-size:.82rem">Failed to load data. Serve via <code>npx serve .</code></p>`;
    return;
  }

  addVillageMarkers(_allVillages);
  addSourceMarkers(_allSprings);
  renderVillageSelectPanel();
  renderSourcesPanel(_allSprings);
  renderOverviewStats(_allSprings, _allVillages);
  initLocationSearch();
}

init();
