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
function confScoreColor(c) {
  if (c >= 85) return '#16a34a';
  if (c >= 70) return '#65a30d';
  if (c >= 55) return '#d97706';
  if (c >= 40) return '#ea580c';
  return '#dc2626';
}
function breakdown(total) {
  const pipeline = Math.round(total * 0.668), pump = Math.round(total * 0.197);
  return { pipeline, pump, treatment: total - pipeline - pump };
}
function fmtPassDate(utc) { return new Date(utc).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; }

/* ── STATE ───────────────────────────────────────── */
let appState = 'browse'; // 'browse' | 'point-select' | 'sources-visible'

function setMapInstruction(show, text = '') {
  const el = document.getElementById('map-instruction');
  if (!el) return;
  el.textContent = text;
  el.style.display = show ? 'block' : 'none';
}
let selectedVillage = null;
let collectionPoint = null;
let _allVillages = [];

/* ── MAP ─────────────────────────────────────────── */
let leafletMap;
const markerRefs = {};
const villageMarkerRefs = {};
let _villageHighlight = null;
let _villageRadiusRing = null;
let _pipelineLayer = null;
let _collectionMarker = null;

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
      <div class="legend-title">Confidence Score</div>
      <div class="legend-item"><div class="legend-source" style="background:#16a34a"></div>85 – 100%</div>
      <div class="legend-item"><div class="legend-source" style="background:#65a30d"></div>70 – 84%</div>
      <div class="legend-item"><div class="legend-source" style="background:#d97706"></div>55 – 69%</div>
      <div class="legend-item"><div class="legend-source" style="background:#ea580c"></div>40 – 54%</div>
      <div class="legend-item"><div class="legend-source" style="background:#dc2626"></div>Below 40%</div>`;
    return d;
  };
  legend.addTo(leafletMap);

  leafletMap.on('click', e => {
    if (appState !== 'point-select') return;
    enterAreaFocused(e.latlng.lat, e.latlng.lng, 10, selectedVillage);
    setMapInstruction(false);
  });
}

/* ── VILLAGE MARKERS ─────────────────────────────── */
function addVillageMarkers(villages) {
  villages.forEach(v => {
    const latlngs = v.polygon.map(([lon, lat]) => [lat, lon]);
    L.polygon(latlngs, {
      color: '#f59e0b', weight: 1.8, dashArray: '5 4',
      fillColor: '#f59e0b', fillOpacity: 0.07, interactive: false
    }).addTo(leafletMap);
  });
}

/* ── LANDING MODE ────────────────────────────────── */
function exitLandingMode() {
  if (!document.body.classList.contains('landing')) return;
  document.body.classList.remove('landing');
  leafletMap.invalidateSize();
}

/* ── WATER SOURCE MARKERS ────────────────────────── */
function addSourceMarkers(springs) {
  springs.forEach(sp => {
    const col = confScoreColor(sp.confidence);
    const icon = L.divIcon({
      html: `<div class="src-marker" style="background:${col}"></div>`,
      className: '', iconSize: [14, 14], iconAnchor: [7, 7], popupAnchor: [0, -10]
    });

    const distKm = () => collectionPoint
      ? haversineKm(collectionPoint.lat, collectionPoint.lon, sp.lat, sp.lon).toFixed(1)
      : sp.distance_km;

    const m = L.marker([sp.lat, sp.lon], { icon }).addTo(leafletMap);
    m.setOpacity(0.38);
    m.on('click', () => {
      if (appState !== 'sources-visible') return;
      selectSource(sp);
      const z = Math.min(leafletMap.getZoom() + 1, 13);
      leafletMap.setView([sp.lat, sp.lon], z, { animate: true, duration: 0.4 });
    });
    markerRefs[sp.id] = m;
  });
}

/* ── STATE: BROWSE (initial) ─────────────────────── */
function enterBrowseState() {
  appState = 'browse';
  selectedVillage = null;
  collectionPoint = null;
  document.getElementById('map').style.cursor = '';
  setMapInstruction(false);

  if (_villageHighlight) { leafletMap.removeLayer(_villageHighlight); _villageHighlight = null; }
  if (_villageRadiusRing) { leafletMap.removeLayer(_villageRadiusRing); _villageRadiusRing = null; }
  if (_pipelineLayer) { leafletMap.removeLayer(_pipelineLayer); _pipelineLayer = null; }
  if (_collectionMarker) { leafletMap.removeLayer(_collectionMarker); _collectionMarker = null; }

  _allSprings.forEach(sp => markerRefs[sp.id]?.setOpacity(0.38));
  renderBrowsePanel();
}

/* ── STATE: AREA FOCUSED ─────────────────────────── */
function enterAreaFocused(lat, lon, radiusKm = 10, village = null) {
  appState = 'sources-visible';
  document.getElementById('map').style.cursor = '';
  setMapInstruction(false);
  selectedVillage = village;
  collectionPoint = { lat, lon };

  if (_villageHighlight) { leafletMap.removeLayer(_villageHighlight); _villageHighlight = null; }
  if (_villageRadiusRing) { leafletMap.removeLayer(_villageRadiusRing); _villageRadiusRing = null; }
  if (_pipelineLayer) { leafletMap.removeLayer(_pipelineLayer); _pipelineLayer = null; }
  if (_collectionMarker) { leafletMap.removeLayer(_collectionMarker); _collectionMarker = null; }

  const cpIcon = L.divIcon({
    html: `<div class="cp-pin"></div>`,
    className: '', iconSize: [20, 20], iconAnchor: [10, 10]
  });
  _collectionMarker = L.marker([lat, lon], { icon: cpIcon, zIndexOffset: 700, interactive: false }).addTo(leafletMap);

  if (village) {
    const latlngs = village.polygon.map(([lo, la]) => [la, lo]);
    _villageHighlight = L.polygon(latlngs, {
      color: '#2563eb', weight: 2, dashArray: '6 4',
      fillColor: '#2563eb', fillOpacity: 0.07, interactive: false
    }).addTo(leafletMap);
  }

  _villageRadiusRing = L.circle([lat, lon], {
    radius: radiusKm * 1000, color: '#2563eb', weight: 1.5, dashArray: '7 5',
    fillOpacity: 0, interactive: false
  }).addTo(leafletMap);

  let nearby = _allSprings.filter(sp => haversineKm(lat, lon, sp.lat, sp.lon) <= radiusKm);
  let fallback = false;
  if (nearby.length === 0) {
    fallback = true;
    nearby = [..._allSprings]
      .sort((a, b) => haversineKm(lat, lon, a.lat, a.lon) - haversineKm(lat, lon, b.lat, b.lon))
      .slice(0, 5);
  }

  _allSprings.forEach(sp => {
    markerRefs[sp.id]?.setOpacity(nearby.find(n => n.id === sp.id) ? 1 : 0.15);
  });

  renderSourceListPanel(nearby, lat, lon, fallback);
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
      html += `<div class="mos-item" onclick="flyToArea(${r.lat},${r.lon},'${parts[0].replace(/'/g, "\\'")}')">
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
  if (!v) return;
  exitLandingMode();
  leafletMap.flyTo([v.lat, v.lon], 13, { duration: 0.9 });
  document.getElementById('location-results').style.display = 'none';

  appState = 'point-select';
  selectedVillage = v;
  collectionPoint = null;

  if (_villageHighlight) { leafletMap.removeLayer(_villageHighlight); _villageHighlight = null; }
  if (_villageRadiusRing) { leafletMap.removeLayer(_villageRadiusRing); _villageRadiusRing = null; }
  if (_pipelineLayer) { leafletMap.removeLayer(_pipelineLayer); _pipelineLayer = null; }

  const latlngs = v.polygon.map(([lo, la]) => [la, lo]);
  _villageHighlight = L.polygon(latlngs, {
    color: '#2563eb', weight: 2, dashArray: '6 4',
    fillColor: '#2563eb', fillOpacity: 0.07, interactive: false
  }).addTo(leafletMap);

  _allSprings.forEach(sp => markerRefs[sp.id]?.setOpacity(0.18));

  document.getElementById('map').style.cursor = 'crosshair';
  setMapInstruction(true, '📍 Click anywhere on the map to set your collection point');
  renderPointSelectPanel(v);
}

function flyToArea(lat, lon, name) {
  const la = parseFloat(lat), lo = parseFloat(lon);
  exitLandingMode();
  leafletMap.flyTo([la, lo], 11, { duration: 1.2 });
  enterAreaFocused(la, lo, 20, null);
  document.getElementById('location-results').style.display = 'none';
  document.getElementById('location-search').value = name;
}

/* ── DETAIL PANEL RENDERS ────────────────────────── */
function renderBrowsePanel() {
  document.getElementById('detail-panel').innerHTML = `
    <div class="dp-welcome">
      <div class="dp-welcome-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      </div>
      <div class="dp-welcome-title">Search to Explore</div>
      <div class="dp-welcome-text">Use the search bar on the map to find a city or village in Romania. Water sources in that area will appear.</div>
      <div class="dp-welcome-or">— or pick a village below —</div>
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
  const linked      = _allSprings.filter(s => s.linked_village_id === village.id);
  const totalCap    = linked.reduce((s, sp) => s + sp.reserve, 0);
  const perCap      = Math.round(village.water_need_m3_day * 1000 / village.population);
  const coverage    = Math.min(100, Math.round(totalCap / village.water_need_m3_day * 100));
  const covColor    = coverage >= 100 ? '#059669' : coverage >= 60 ? '#b45309' : '#dc2626';
  const best        = linked.length ? linked.reduce((a, b) => b.reserve > a.reserve ? b : a) : null;
  const avgConf     = linked.length ? Math.round(linked.reduce((s, sp) => s + sp.confidence, 0) / linked.length) : 0;
  const accessColor = village.access_status === 'No piped water' ? '#dc2626'
                    : village.access_status === 'Seasonal shortages' ? '#b45309' : '#d97706';

  document.getElementById('detail-panel').innerHTML = `
    <div class="dp-header">
      <div>
        <div class="dp-title">${village.name}</div>
        <div class="dp-sub">${village.county} County</div>
      </div>
      <button class="dp-back-btn" onclick="enterBrowseState()">&#8592; Back</button>
    </div>

    <div class="vp-status-banner" style="border-color:${accessColor}40;background:${accessColor}0d">
      <div class="vp-status-dot" style="background:${accessColor}"></div>
      <div class="vp-status-text" style="color:${accessColor}">${village.access_status}</div>
    </div>

    <div class="vp-stat-grid">
      <div class="vp-stat">
        <div class="vp-stat-icon" style="background:rgba(37,99,235,.1)">
          <svg viewBox="0 0 24 24" fill="#2563eb"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
        </div>
        <div class="vp-stat-val">${village.population.toLocaleString()}</div>
        <div class="vp-stat-lbl">Est. Population</div>
      </div>
      <div class="vp-stat">
        <div class="vp-stat-icon" style="background:rgba(0,212,170,.1)">
          <svg viewBox="0 0 24 24" fill="#00d4aa"><path d="M12 2c-5.33 4.55-8 8.48-8 11.8 0 4.98 3.8 8.2 8 8.2s8-3.22 8-8.2C20 10.48 17.33 6.55 12 2z"/></svg>
        </div>
        <div class="vp-stat-val">${village.water_need_m3_day}</div>
        <div class="vp-stat-lbl">m³/day needed</div>
      </div>
      <div class="vp-stat">
        <div class="vp-stat-icon" style="background:rgba(8,145,178,.1)">
          <svg viewBox="0 0 24 24" fill="#0891b2"><path d="M20 9V7c0-1.1-.9-2-2-2h-3V3H9v2H6c-1.1 0-2 .9-2 2v2c-1.31 0-2 1.07-2 2v4h1.33L5 19h14l1.67-4H22v-4c0-.93-.69-2-2-2zm-2 0H6V7h12v2z"/></svg>
        </div>
        <div class="vp-stat-val">${perCap}</div>
        <div class="vp-stat-lbl">L/person/day</div>
      </div>
    </div>

    <div class="vp-coverage">
      <div class="vp-coverage-header">
        <span class="vp-coverage-lbl">Source capacity vs. daily need</span>
        <span class="vp-coverage-pct" style="color:${covColor}">${coverage}%</span>
      </div>
      <div class="vp-coverage-track">
        <div class="vp-coverage-fill" style="width:${coverage}%;background:${covColor}"></div>
      </div>
      <div class="vp-coverage-sub">${totalCap.toLocaleString()} m³/day available &middot; ${village.water_need_m3_day} m³/day required</div>
    </div>

    <div class="vp-sources-row">
      <div class="vp-src-badge">
        <div class="vp-src-badge-val">${linked.length}</div>
        <div class="vp-src-badge-lbl">nearby sources</div>
      </div>
      <div class="vp-src-badge">
        <div class="vp-src-badge-val">${avgConf}%</div>
        <div class="vp-src-badge-lbl">avg. confidence</div>
      </div>
      ${best ? `<div class="vp-src-badge vp-src-badge-wide">
        <div class="vp-src-badge-val">${best.reserve} m³/d</div>
        <div class="vp-src-badge-lbl">best · ${best.name}</div>
      </div>` : ''}
    </div>

    <div class="dp-instruction-box">
      <svg viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5S10.62 6.5 12 6.5s2.5 1.12 2.5 2.5S13.38 11.5 12 11.5z"/></svg>
      <div>
        <div class="dp-instr-title">Set Collection Point</div>
        <div class="dp-instr-text">Click anywhere on the map to place your collection point. Sources within 10 km will appear.</div>
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
      <button class="dp-back-btn" onclick="enterBrowseState()">&#8592; Back</button>
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
  drawPipeline(sp);
  renderDetail(sp);
}

function drawPipeline(sp) {
  if (_pipelineLayer) { leafletMap.removeLayer(_pipelineLayer); _pipelineLayer = null; }
  if (!collectionPoint) return;

  const src = [sp.lat, sp.lon];
  const cp  = [collectionPoint.lat, collectionPoint.lon];
  _pipelineLayer = L.polyline([src, cp], {
    color: '#2563eb', weight: 3, dashArray: '10 6', opacity: 0.9, interactive: false
  }).addTo(leafletMap);
}

/* ── DETAIL VIEW ─────────────────────────────────── */
function renderDetail(sp) {
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
      <button class="dp-back-btn" onclick="enterAreaFocused(collectionPoint.lat,collectionPoint.lon,selectedVillage?10:20,selectedVillage)">&#8592; List</button>
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

    ${collectionPoint && selectedVillage ? (() => {
      const d1km = parseFloat(distKm);
      const d1m  = Math.round(d1km * 1000);
      const d2km = haversineKm(collectionPoint.lat, collectionPoint.lon, selectedVillage.lat, selectedVillage.lon);
      const d2m  = Math.round(d2km * 1000);
      const totM = d1m + d2m;
      const totKm = (totM / 1000).toFixed(2);
      return `
    <div class="dp-section">
      <div class="dp-section-label">Pipeline Route</div>
      <div class="pipe-segment">
        <div class="pipe-seg-line pipe-seg-blue"></div>
        <div class="pipe-seg-body">
          <div class="pipe-seg-title">Source → Collection Point</div>
          <div class="pipe-seg-vals">
            <span class="pipe-seg-km">${d1km} km</span>
            <span class="pipe-seg-m">${d1m.toLocaleString()} m</span>
          </div>
        </div>
      </div>
      <div class="pipe-segment">
        <div class="pipe-seg-line pipe-seg-green"></div>
        <div class="pipe-seg-body">
          <div class="pipe-seg-title">Collection Point → ${selectedVillage.name}</div>
          <div class="pipe-seg-vals">
            <span class="pipe-seg-km">${d2km.toFixed(1)} km</span>
            <span class="pipe-seg-m">${d2m.toLocaleString()} m</span>
          </div>
        </div>
      </div>
      <div class="pipe-total">
        <div class="pipe-total-label">Total pipeline</div>
        <div class="pipe-total-val">${totKm} km <span>${totM.toLocaleString()} m</span></div>
      </div>
    </div>`;
    })() : ''}`;
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
    <div class="ov-best-card">
      <div class="ov-best-eyebrow">Highest Output Source</div>
      <div class="ov-best-name">${best.name}</div>
      <div class="ov-best-details">
        <span>${best.reserve} m³/day</span>
        <span>${best.nearest_village}</span>
        <span>${best.confidence}% confidence</span>
        <span>${best.elevation_m} m elevation</span>
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
  enterBrowseState();
  renderSourcesPanel(_allSprings);
  renderOverviewStats(_allSprings, _allVillages);
  initLocationSearch();
}

init();
