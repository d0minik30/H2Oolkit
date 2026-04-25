/* app.js — H2Oolkit (real-time, backend-driven)
 *
 * Workflow:
 *   1. User types a location → Nominatim geocoding → flyToLocation()
 *   2. Draw 10 km dashed circle at the search centre
 *   3. GET /api/water-sources → blue dots for every OSM + EU-Hydro source
 *   4. Cursor switches to crosshair INSIDE the circle, not-allowed outside
 *      (clicks outside the circle are ignored)
 *   5. User clicks inside the circle → POST /api/analyze/site
 *      with both the search centre and the collection point
 *   6. Backend returns ranked sources sorted by feasibility_score (0–100)
 *   7. Frontend renders:
 *        - detail panel (selected source)
 *        - sources list below the map (sorted top-down by feasibility)
 *        - overview stats
 *        - pipeline polyline from best source to collection point
 */

const SCAN_RADIUS_KM = 10;

const TYPE_LABEL = {
  spring: 'Spring', stream: 'Stream', river: 'River',
  lake: 'Lake', well: 'Well', reservoir: 'Reservoir',
};

const TYPE_ICON = {
  spring:    `<svg viewBox="0 0 24 24"><path d="M12 2c-5.33 4.55-8 8.48-8 11.8 0 4.98 3.8 8.2 8 8.2s8-3.22 8-8.2C20 10.48 17.33 6.55 12 2z"/></svg>`,
  stream:    `<svg viewBox="0 0 24 24"><path d="M1.5 12c0-1 .8-1.8 1.8-1.8C5.1 10.2 5 12 7 12s2-1.8 3.8-1.8S13 12 15 12s2-1.8 3.8-1.8c1 0 1.8.8 1.8 1.8s-.8 1.8-1.8 1.8C17 13.8 17 16 15 16s-2-1.8-3.8-1.8S9 16 7 16s-2-1.8-3.8-1.8c-.9 0-1.7-.8-1.7-1.8z"/></svg>`,
  river:     `<svg viewBox="0 0 24 24"><path d="M1.5 12c0-1 .8-1.8 1.8-1.8C5.1 10.2 5 12 7 12s2-1.8 3.8-1.8S13 12 15 12s2-1.8 3.8-1.8c1 0 1.8.8 1.8 1.8s-.8 1.8-1.8 1.8C17 13.8 17 16 15 16s-2-1.8-3.8-1.8S9 16 7 16s-2-1.8-3.8-1.8c-.9 0-1.7-.8-1.7-1.8z"/></svg>`,
  lake:      `<svg viewBox="0 0 24 24"><ellipse cx="12" cy="14" rx="9" ry="5"/><path d="M12 2C9 2 6 5 6 9c0 3 3 5 6 5s6-2 6-5c0-4-3-7-6-7z"/></svg>`,
  well:      `<svg viewBox="0 0 24 24"><rect x="6" y="10" width="12" height="11" rx="1"/><path d="M4 10h16M9 10V7a3 3 0 0 1 6 0v3"/><line x1="12" y1="14" x2="12" y2="17"/></svg>`,
  reservoir: `<svg viewBox="0 0 24 24"><path d="M4 4h16v4H4zm0 6h16v10H4z"/></svg>`,
};

const TYPE_COLOR = {
  spring: '#2563eb', stream: '#0284c7', river: '#0ea5e9',
  lake: '#0891b2', well: '#6366f1', reservoir: '#059669',
};

function feasColor(score) {
  if (score >= 80) return '#16a34a';
  if (score >= 60) return '#65a30d';
  if (score >= 40) return '#d97706';
  if (score >= 20) return '#ea580c';
  return '#dc2626';
}

function feasLabel(score) {
  if (score >= 80) return 'Excellent';
  if (score >= 60) return 'Good';
  if (score >= 40) return 'Moderate';
  if (score >= 20) return 'Low';
  return 'Very Low';
}

function fmtCost(n) { return '€' + Math.round(n).toLocaleString('de-DE'); }
function fmtNum(n)  { return Math.round(n).toLocaleString('de-DE'); }

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ── STATE ─────────────────────────────────────── */
const ROMANIA_BOUNDS = L.latLngBounds([43.6, 20.2], [48.3, 30.0]);

let leafletMap;
let appState = 'idle';   // idle | scanning | point-select | analyzing | analyzed
let _scanCenter = null;  // { lat, lon }
let _scanCircle = null;
let _scanCenterMarker = null;
let _sourceMarkers = {};   // id → L.marker
let _sources = [];         // raw backend sources for current scan
let _rankedSources = [];   // backend analysis result (with feasibility_score)
let _selectedSourceId = null;
let _collectionMarker = null;
let _pipelineLayer = null;
let _currentLocationName = '';

/* ── MAP ───────────────────────────────────────── */
function initMap() {
  leafletMap = L.map('map', {
    center: [46.0, 25.0], zoom: 7, zoomControl: true,
    maxBounds: ROMANIA_BOUNDS, maxBoundsViscosity: 1.0, minZoom: 6,
  });

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Imagery &copy; Esri', maxZoom: 19,
  }).addTo(leafletMap);

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
    attribution: '', maxZoom: 19, opacity: 0.85,
  }).addTo(leafletMap);

  const legend = L.control({ position: 'bottomleft' });
  legend.onAdd = () => {
    const d = L.DomUtil.create('div', 'map-legend');
    d.innerHTML = `
      <div class="legend-title">Feasibility Score</div>
      <div class="legend-item"><div class="legend-source" style="background:#16a34a"></div>80 – 100 (excellent)</div>
      <div class="legend-item"><div class="legend-source" style="background:#65a30d"></div>60 – 79 (good)</div>
      <div class="legend-item"><div class="legend-source" style="background:#d97706"></div>40 – 59 (moderate)</div>
      <div class="legend-item"><div class="legend-source" style="background:#ea580c"></div>20 – 39 (low)</div>
      <div class="legend-item"><div class="legend-source" style="background:#dc2626"></div>Below 20</div>`;
    return d;
  };
  legend.addTo(leafletMap);

  /* Locked until user searches */
  leafletMap.dragging.disable();
  leafletMap.touchZoom.disable();
  leafletMap.doubleClickZoom.disable();
  leafletMap.scrollWheelZoom.disable();
  leafletMap.boxZoom.disable();
  leafletMap.keyboard.disable();
  leafletMap.zoomControl.getContainer().style.display = 'none';

  leafletMap.on('click', onMapClick);
  leafletMap.on('mousemove', onMapMouseMove);
}

function exitLandingMode() {
  if (!document.body.classList.contains('landing')) return;
  document.body.classList.remove('landing');
  leafletMap.dragging.enable();
  leafletMap.touchZoom.enable();
  leafletMap.doubleClickZoom.enable();
  leafletMap.scrollWheelZoom.enable();
  leafletMap.boxZoom.enable();
  leafletMap.keyboard.enable();
  leafletMap.zoomControl.getContainer().style.display = '';
  setTimeout(() => leafletMap.invalidateSize(), 50);
}

function setMapInstruction(show, text = '') {
  const el = document.getElementById('map-instruction');
  if (!el) return;
  el.textContent = text;
  el.style.display = show ? 'block' : 'none';
}

/* ── RESET ─────────────────────────────────────── */
function clearMapLayers() {
  if (_scanCircle)        { leafletMap.removeLayer(_scanCircle);        _scanCircle = null; }
  if (_scanCenterMarker)  { leafletMap.removeLayer(_scanCenterMarker);  _scanCenterMarker = null; }
  if (_collectionMarker)  { leafletMap.removeLayer(_collectionMarker);  _collectionMarker = null; }
  if (_pipelineLayer)     { leafletMap.removeLayer(_pipelineLayer);     _pipelineLayer = null; }
  Object.values(_sourceMarkers).forEach(m => leafletMap.removeLayer(m));
  _sourceMarkers = {};
}

function resetAll() {
  clearMapLayers();
  _sources = [];
  _rankedSources = [];
  _selectedSourceId = null;
  _scanCenter = null;
  appState = 'idle';
  document.getElementById('map').style.cursor = '';
  setMapInstruction(false);
}

/* ── 1. LOCATION SEARCH → fetch sources ────────── */
async function flyToLocation(lat, lon, name) {
  resetAll();
  _currentLocationName = name;
  _scanCenter = { lat: parseFloat(lat), lon: parseFloat(lon) };

  exitLandingMode();
  leafletMap.flyTo([_scanCenter.lat, _scanCenter.lon], 12, { duration: 1.0 });

  drawScanCircle();
  drawScanCenterMarker();

  appState = 'scanning';
  renderLoadingPanel(`Scanning water sources within ${SCAN_RADIUS_KM} km of ${name}…`);
  document.getElementById('sources-count').textContent = 'scanning…';
  document.getElementById('sources-list').innerHTML =
    `<div class="bm-empty">Searching OpenStreetMap and EU-Hydro databases…</div>`;
  document.getElementById('overview-stats').innerHTML = '';

  try {
    const data = await H2O.fetchWaterSources(_scanCenter.lat, _scanCenter.lon, SCAN_RADIUS_KM * 1000);
    _sources = data.sources || [];
    addSourceMarkers(_sources);
    enterPointSelectMode(name, _sources.length, data.eu_hydro_available);
    renderSourcesPanelRaw(_sources);
  } catch (err) {
    renderErrorPanel(`Could not reach the backend at ${H2O.base}.`,
      `Start it from the project root with:\n    py -m backend.server\n\nDetails: ${err.message}`);
    document.getElementById('sources-count').textContent = 'unavailable';
    document.getElementById('sources-list').innerHTML =
      `<div class="bm-empty bm-empty-error">Backend offline. Start it with <code>py -m backend.server</code>.</div>`;
  }
}

function drawScanCircle() {
  _scanCircle = L.circle([_scanCenter.lat, _scanCenter.lon], {
    radius: SCAN_RADIUS_KM * 1000,
    color: '#2563eb', weight: 2, dashArray: '7 5',
    fillColor: '#2563eb', fillOpacity: 0.04, interactive: false,
  }).addTo(leafletMap);
}

function drawScanCenterMarker() {
  const icon = L.divIcon({
    html: `<div class="scan-center-pin"></div>`,
    className: '', iconSize: [16, 16], iconAnchor: [8, 8],
  });
  _scanCenterMarker = L.marker([_scanCenter.lat, _scanCenter.lon], {
    icon, zIndexOffset: 600, interactive: false,
  }).addTo(leafletMap);
}

function addSourceMarkers(sources) {
  Object.values(_sourceMarkers).forEach(m => leafletMap.removeLayer(m));
  _sourceMarkers = {};

  sources.forEach(src => {
    const icon = L.divIcon({
      html: `<div class="src-marker src-marker-blue"></div>`,
      className: '', iconSize: [12, 12], iconAnchor: [6, 6], popupAnchor: [0, -6],
    });
    const m = L.marker([src.lat, src.lon], { icon, zIndexOffset: 400 }).addTo(leafletMap);
    m.bindTooltip(
      `<b>${escapeHtml(src.name)}</b><br>${TYPE_LABEL[src.source_type] ?? src.source_type}`,
      { direction: 'top', offset: [0, -6] }
    );
    m.on('click', e => {
      L.DomEvent.stopPropagation(e);
      if (appState === 'analyzed') {
        selectSourceById(String(src.id));
        leafletMap.setView([src.lat, src.lon], Math.min(leafletMap.getZoom() + 1, 14), { animate: true });
      }
    });
    _sourceMarkers[String(src.id)] = m;
  });
}

function enterPointSelectMode(name, count, euHydroAvailable) {
  appState = 'point-select';
  document.getElementById('map').style.cursor = 'crosshair';
  setMapInstruction(true, `📍 Click anywhere INSIDE the blue circle to set your collection point`);
  renderPointSelectPanel(name, count, euHydroAvailable);
}

/* ── 2. CURSOR + CLICK CONSTRAINT ──────────────── */
function isInsideScanCircle(lat, lon) {
  if (!_scanCenter) return false;
  return haversineKm(_scanCenter.lat, _scanCenter.lon, lat, lon) <= SCAN_RADIUS_KM;
}

function onMapMouseMove(e) {
  if (appState !== 'point-select') return;
  const inside = isInsideScanCircle(e.latlng.lat, e.latlng.lng);
  document.getElementById('map').style.cursor = inside ? 'crosshair' : 'not-allowed';
}

async function onMapClick(e) {
  if (appState !== 'point-select') return;
  if (!isInsideScanCircle(e.latlng.lat, e.latlng.lng)) return;   // ignore clicks outside circle
  await runFeasibilityAnalysis(e.latlng.lat, e.latlng.lng);
}

/* ── 3. FEASIBILITY ANALYSIS ───────────────────── */
async function runFeasibilityAnalysis(lat, lon) {
  appState = 'analyzing';
  document.getElementById('map').style.cursor = '';
  setMapInstruction(false);
  setCollectionMarker(lat, lon);

  renderLoadingPanel('Calculating feasibility for every source…\n(may take 10–30 s — fetching satellite & EU-Hydro data)');
  document.getElementById('sources-count').textContent = 'analysing…';

  try {
    const result = await H2O.analyzeSite({
      collection_point: { lat, lon },
      search_center:    { lat: _scanCenter.lat, lon: _scanCenter.lon },
      radius_m:         SCAN_RADIUS_KM * 1000,
      name:             _currentLocationName,
    });

    _rankedSources = result.ranked_sources || [];
    appState = 'analyzed';

    if (_rankedSources.length === 0) {
      renderEmptyResultsPanel(result);
      return;
    }

    // Add markers for any sources returned by analysis that aren't already on the map
    // (analysis may discover slightly different sources around the collection point)
    const alreadyShown = new Set(Object.keys(_sourceMarkers));
    const newSources = _rankedSources.filter(s => !alreadyShown.has(String(s.id)));
    if (newSources.length > 0) addSourceMarkers([..._sources, ...newSources]);

    recolorSourceMarkersByFeasibility(_rankedSources);

    const best = _rankedSources[0];
    selectSourceById(String(best.id));
    renderSourcesPanel(_rankedSources);
    renderOverviewStats(result, _rankedSources);
  } catch (err) {
    renderErrorPanel('Analysis failed', err.message);
    appState = 'point-select';
    document.getElementById('map').style.cursor = 'crosshair';
    setMapInstruction(true, `📍 Click anywhere INSIDE the blue circle to set your collection point`);
  }
}

function setCollectionMarker(lat, lon) {
  if (_collectionMarker) leafletMap.removeLayer(_collectionMarker);
  const icon = L.divIcon({
    html: `<div class="cp-pin"></div>`,
    className: '', iconSize: [20, 20], iconAnchor: [10, 10],
  });
  _collectionMarker = L.marker([lat, lon], {
    icon, zIndexOffset: 700, interactive: false,
  }).addTo(leafletMap);
}

function recolorSourceMarkersByFeasibility(ranked) {
  ranked.forEach(src => {
    const m = _sourceMarkers[String(src.id)];
    if (!m) return;
    const col = feasColor(src.feasibility_score ?? 0);
    const html = `<div class="src-marker" style="background:${col}"></div>`;
    m.setIcon(L.divIcon({ html, className: '', iconSize: [12, 12], iconAnchor: [6, 6] }));
  });
}

function selectSourceById(id) {
  _selectedSourceId = id;
  const src = _rankedSources.find(s => String(s.id) === id);
  if (!src) return;
  drawPipeline(src);
  renderDetailPanel(src);
}

function drawPipeline(src) {
  if (_pipelineLayer) { leafletMap.removeLayer(_pipelineLayer); _pipelineLayer = null; }
  if (!_collectionMarker) return;
  const cp = _collectionMarker.getLatLng();
  _pipelineLayer = L.polyline(
    [[src.lat, src.lon], [cp.lat, cp.lng]],
    { color: '#2563eb', weight: 3, dashArray: '10 6', opacity: 0.9, interactive: false }
  ).addTo(leafletMap);
}

/* ── PANEL RENDERING ───────────────────────────── */
function renderWelcomePanel() {
  document.getElementById('detail-panel').innerHTML = `
    <div class="dp-welcome">
      <div class="dp-welcome-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      </div>
      <div class="dp-welcome-title">Search to Begin</div>
      <div class="dp-welcome-text">
        Type a location in Romania (city, village, or coordinates). The system will scan a ${SCAN_RADIUS_KM} km
        radius using OpenStreetMap and EU-Hydro, then let you place a collection point inside the circle to
        compute feasibility.
      </div>
    </div>`;
}

function renderLoadingPanel(text) {
  document.getElementById('detail-panel').innerHTML = `
    <div class="dp-welcome">
      <div class="dp-welcome-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      </div>
      <div class="dp-welcome-title">Working…</div>
      <div class="dp-welcome-text" style="white-space:pre-line">${escapeHtml(text)}</div>
    </div>`;
}

function renderErrorPanel(title, detail) {
  document.getElementById('detail-panel').innerHTML = `
    <div class="dp-welcome">
      <div class="dp-welcome-icon" style="color:#dc2626">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      </div>
      <div class="dp-welcome-title" style="color:#dc2626">${escapeHtml(title)}</div>
      <div class="dp-welcome-text" style="white-space:pre-line">${escapeHtml(detail)}</div>
    </div>`;
}

function renderEmptyResultsPanel(result) {
  document.getElementById('detail-panel').innerHTML = `
    <div class="dp-welcome">
      <div class="dp-welcome-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      </div>
      <div class="dp-welcome-title">No sources within range</div>
      <div class="dp-welcome-text">${escapeHtml(result.recommendation || 'Try a different location.')}</div>
    </div>`;
  document.getElementById('sources-count').textContent = '0 detected';
  document.getElementById('sources-list').innerHTML =
    `<div class="bm-empty">No water sources within ${SCAN_RADIUS_KM} km.</div>`;
}

function renderPointSelectPanel(name, count, euHydroAvailable) {
  const euBadge = euHydroAvailable
    ? `<span class="dp-eu-badge dp-eu-ok">EU-Hydro ✓</span>`
    : `<span class="dp-eu-badge dp-eu-off">EU-Hydro offline</span>`;
  document.getElementById('detail-panel').innerHTML = `
    <div class="dp-header">
      <div>
        <div class="dp-title">${escapeHtml(name)}</div>
        <div class="dp-sub">${SCAN_RADIUS_KM} km scan ${euBadge}</div>
      </div>
    </div>

    <div class="vp-stat-grid">
      <div class="vp-stat">
        <div class="vp-stat-icon" style="background:rgba(37,99,235,.1)">
          <svg viewBox="0 0 24 24" fill="#2563eb"><path d="M12 2c-5.33 4.55-8 8.48-8 11.8 0 4.98 3.8 8.2 8 8.2s8-3.22 8-8.2C20 10.48 17.33 6.55 12 2z"/></svg>
        </div>
        <div class="vp-stat-val">${count}</div>
        <div class="vp-stat-lbl">sources detected</div>
      </div>
      <div class="vp-stat">
        <div class="vp-stat-icon" style="background:rgba(5,150,105,.1)">
          <svg viewBox="0 0 24 24" fill="#059669"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2" stroke="#fff" stroke-width="2" fill="none"/></svg>
        </div>
        <div class="vp-stat-val">${SCAN_RADIUS_KM}</div>
        <div class="vp-stat-lbl">km scan radius</div>
      </div>
      <div class="vp-stat">
        <div class="vp-stat-icon" style="background:rgba(180,83,9,.1)">
          <svg viewBox="0 0 24 24" fill="#b45309"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>
        </div>
        <div class="vp-stat-val">live</div>
        <div class="vp-stat-lbl">satellite data</div>
      </div>
    </div>

    <div class="dp-instruction-box">
      <svg viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5S10.62 6.5 12 6.5s2.5 1.12 2.5 2.5S13.38 11.5 12 11.5z"/></svg>
      <div>
        <div class="dp-instr-title">Pick a Collection Point</div>
        <div class="dp-instr-text">Move your cursor inside the blue circle and click once. The cursor turns into a crosshair when you're inside; clicks outside the circle are ignored.</div>
      </div>
    </div>`;
}

function renderDetailPanel(src) {
  document.querySelectorAll('.src-card').forEach(c => c.classList.remove('src-card-active'));
  document.getElementById(`srcc-${src.id}`)?.classList.add('src-card-active');

  const fs   = src.feasibility_score ?? 0;
  const cc   = feasColor(fs);
  const lbl  = feasLabel(fs);
  const col  = TYPE_COLOR[src.source_type] ?? '#2563eb';
  const icon = TYPE_ICON[src.source_type] ?? TYPE_ICON.spring;

  const R = 52, CX = 70, CY = 70, circ = 2 * Math.PI * R;
  const dash = (fs / 100) * circ;

  const route = src.route || {};
  const cost  = src.cost  || {};
  const reserve = src.water_reserve || {};
  const distKm  = route.terrain_adjusted_distance_km ?? (src.distance_m / 1000);
  const elevDiff = route.elevation_difference_m ?? 0;
  const supplyMethod = (src.supply_method || '').replace(/_/g, ' ');
  const flowM3 = Math.round((src.estimated_daily_flow_liters || 0) / 1000);

  const euBadge = src.eu_hydro_linked === true
    ? `<span class="dp-eu-badge dp-eu-ok">EU-Hydro linked</span>`
    : src.eu_hydro_linked === false
    ? `<span class="dp-eu-badge dp-eu-off">Not in EU-Hydro</span>`
    : '';

  const pnrr = cost.pnrr_eligible
    ? `<span class="dp-eu-badge dp-eu-ok">PNRR eligible</span>` : '';

  document.getElementById('detail-panel').innerHTML = `
    <div class="dp-header">
      <div>
        <div class="dp-title" style="display:flex;align-items:center;gap:7px">
          <span class="src-icon-sm" style="background:${col}20;color:${col}">${icon}</span>
          ${escapeHtml(src.name)}
        </div>
        <div class="dp-sub">
          ${escapeHtml(_currentLocationName)} &middot; ${TYPE_LABEL[src.source_type] ?? src.source_type}
          ${euBadge} ${pnrr}
        </div>
      </div>
      <button class="dp-back-btn" onclick="returnToPointSelect()">&#8592; Re-pick</button>
    </div>

    <div class="dp-feas-wrap">
      <svg class="dp-feas-svg" viewBox="0 0 140 140">
        <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="var(--border)" stroke-width="11"/>
        <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${cc}" stroke-width="11"
          stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}" stroke-linecap="round"
          transform="rotate(-90 ${CX} ${CY})"/>
        <text x="${CX}" y="${CY - 7}" text-anchor="middle" fill="${cc}" font-size="26" font-weight="800" font-family="Outfit,sans-serif">${Math.round(fs)}</text>
        <text x="${CX}" y="${CY + 13}" text-anchor="middle" fill="#94a3b8" font-size="11" font-family="Outfit,sans-serif">${lbl}</text>
      </svg>
      <div class="dp-feas-label">Feasibility Score</div>
    </div>

    <div class="dp-metric-grid">
      <div class="dp-metric-card">
        <div class="dp-metric-icon" style="background:rgba(37,99,235,.1)">
          <svg viewBox="0 0 24 24" fill="#2563eb"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>
        </div>
        <div class="dp-metric-val">${distKm.toFixed(2)} <span>km</span></div>
        <div class="dp-metric-lbl">Pipeline route</div>
      </div>
      <div class="dp-metric-card">
        <div class="dp-metric-icon" style="background:rgba(5,150,105,.1)">
          <svg viewBox="0 0 24 24" fill="#059669"><path d="M3 17h4v4H3zm7-4h4v8h-4zm7-6h4v14h-4z"/></svg>
        </div>
        <div class="dp-metric-val">${elevDiff > 0 ? '+' : ''}${Math.round(elevDiff)} <span>m</span></div>
        <div class="dp-metric-lbl">${elevDiff >= 0 ? 'Above collection pt' : 'Below collection pt'}</div>
      </div>
      <div class="dp-metric-card">
        <div class="dp-metric-icon" style="background:rgba(0,212,170,.1)">
          <svg viewBox="0 0 24 24" fill="#00d4aa"><path d="M12 2c-5.33 4.55-8 8.48-8 11.8 0 4.98 3.8 8.2 8 8.2s8-3.22 8-8.2C20 10.48 17.33 6.55 12 2z"/></svg>
        </div>
        <div class="dp-metric-val">${flowM3} <span>m³/d</span></div>
        <div class="dp-metric-lbl">Estimated flow</div>
      </div>
    </div>

    <div class="dp-section">
      <div class="dp-section-label">Supply Method</div>
      <div class="dp-supply-method">${escapeHtml(supplyMethod || 'unknown')}</div>
    </div>

    ${cost.total_cost_eur != null ? `
    <div class="dp-section">
      <div class="dp-section-label">Infrastructure Cost</div>
      <div class="dp-cost-total">${fmtCost(cost.total_cost_eur)}</div>
      <div class="dp-cost-breakdown">
        <div class="dp-cost-row"><span>Pipeline</span><span>${fmtCost(cost.breakdown_eur?.pipeline_eur ?? 0)}</span></div>
        ${(cost.breakdown_eur?.pumping_eur ?? 0) > 0 ? `<div class="dp-cost-row"><span>Pumping</span><span>${fmtCost(cost.breakdown_eur.pumping_eur)}</span></div>` : ''}
        <div class="dp-cost-row"><span>Treatment</span><span>${fmtCost(cost.breakdown_eur?.treatment_plant_eur ?? 0)}</span></div>
        <div class="dp-cost-row"><span>Reservoir</span><span>${fmtCost(cost.breakdown_eur?.reservoir_eur ?? 0)}</span></div>
        <div class="dp-cost-row"><span>Connections</span><span>${fmtCost(cost.breakdown_eur?.household_connections_eur ?? 0)}</span></div>
        ${cost.pnrr_eligible ? `
          <div class="dp-cost-row dp-cost-grant"><span>PNRR grant (85%)</span><span>− ${fmtCost(cost.pnrr_grant_eur ?? 0)}</span></div>
          <div class="dp-cost-row dp-cost-village"><span>Village contribution</span><span>${fmtCost(cost.village_contribution_eur ?? 0)}</span></div>
        ` : ''}
      </div>
    </div>` : ''}

    ${src.recommendation ? `
    <div class="dp-section">
      <div class="dp-section-label">Recommendation</div>
      <div class="dp-recommendation">${escapeHtml(src.recommendation)}</div>
    </div>` : ''}
  `;
}

function returnToPointSelect() {
  if (!_scanCenter) return;
  if (_collectionMarker) { leafletMap.removeLayer(_collectionMarker); _collectionMarker = null; }
  if (_pipelineLayer)    { leafletMap.removeLayer(_pipelineLayer);    _pipelineLayer = null; }
  _rankedSources = [];
  _selectedSourceId = null;
  // Reset markers to plain blue
  Object.values(_sourceMarkers).forEach(m => {
    m.setIcon(L.divIcon({
      html: `<div class="src-marker src-marker-blue"></div>`,
      className: '', iconSize: [12, 12], iconAnchor: [6, 6],
    }));
  });
  enterPointSelectMode(_currentLocationName, _sources.length, true);
}

/* ── BELOW-MAP RENDERING ───────────────────────── */
function renderSourcesPanelRaw(sources) {
  // Pre-analysis listing (no feasibility yet) — sorted by distance
  document.getElementById('sources-count').textContent = `${sources.length} detected`;
  if (sources.length === 0) {
    document.getElementById('sources-list').innerHTML =
      `<div class="bm-empty">No water sources within ${SCAN_RADIUS_KM} km. Try a different location.</div>`;
    return;
  }
  document.getElementById('sources-list').innerHTML = sources.map(sp => {
    const col = TYPE_COLOR[sp.source_type] ?? '#2563eb';
    return `
    <div class="bm-src-row" id="srcc-${sp.id}">
      <div class="bm-src-icon" style="background:${col}18;color:${col}">${TYPE_ICON[sp.source_type] ?? TYPE_ICON.spring}</div>
      <div class="bm-src-info">
        <div class="bm-src-name">${escapeHtml(sp.name)}</div>
        <div class="bm-src-meta">${TYPE_LABEL[sp.source_type] ?? sp.source_type} &middot; ${(sp.distance_m / 1000).toFixed(2)} km from search center</div>
      </div>
      <div class="bm-src-stats">
        <span class="bm-src-meta-pill">click map to analyse</span>
      </div>
    </div>`;
  }).join('');
}

function renderSourcesPanel(ranked) {
  document.getElementById('sources-count').textContent =
    `${ranked.length} ranked by feasibility`;
  document.getElementById('sources-list').innerHTML = ranked.map(sp => {
    const col  = TYPE_COLOR[sp.source_type] ?? '#2563eb';
    const fs   = sp.feasibility_score ?? 0;
    const fc   = feasColor(fs);
    const distKm = sp.route?.terrain_adjusted_distance_km?.toFixed(2)
                ?? (sp.distance_m / 1000).toFixed(2);
    const flowM3 = Math.round((sp.estimated_daily_flow_liters || 0) / 1000);
    const costEur = sp.cost?.total_cost_eur;
    return `
    <div class="bm-src-row bm-src-row-clickable" id="srcc-${sp.id}"
         onclick="selectSourceById('${sp.id}')">
      <div class="bm-src-rank" style="background:${fc}20;color:${fc}">#${sp.feasibility_rank ?? sp.rank ?? '?'}</div>
      <div class="bm-src-icon" style="background:${col}18;color:${col}">${TYPE_ICON[sp.source_type] ?? TYPE_ICON.spring}</div>
      <div class="bm-src-info">
        <div class="bm-src-name">${escapeHtml(sp.name)}</div>
        <div class="bm-src-meta">
          ${TYPE_LABEL[sp.source_type] ?? sp.source_type} &middot; ${distKm} km
          ${costEur != null ? ' &middot; ' + fmtCost(costEur) : ''}
        </div>
        <div class="bm-src-bar-track"><div class="bm-src-bar-fill" style="width:${fs}%;background:${fc}"></div></div>
      </div>
      <div class="bm-src-stats">
        <span class="bm-src-reserve">${flowM3} <em>m³/d</em></span>
        <span class="bm-src-conf" style="color:${fc}">${Math.round(fs)}</span>
      </div>
    </div>`;
  }).join('');
}

function renderOverviewStats(result, ranked) {
  if (!ranked.length) { document.getElementById('overview-stats').innerHTML = ''; return; }
  const best = ranked[0];
  const avgFs = Math.round(ranked.reduce((s, r) => s + (r.feasibility_score ?? 0), 0) / ranked.length);
  const totalFlowM3 = Math.round(ranked.reduce((s, r) => s + (r.estimated_daily_flow_liters ?? 0), 0) / 1000);
  const typeCount = {};
  ranked.forEach(r => { typeCount[r.source_type] = (typeCount[r.source_type] ?? 0) + 1; });
  const weather = result.weather || {};

  const fc = feasColor(avgFs);
  const bestCol = feasColor(best.feasibility_score ?? 0);

  document.getElementById('overview-stats').innerHTML = `
    <div class="ov-best-card">
      <div class="ov-best-eyebrow">Best Option (rank #1)</div>
      <div class="ov-best-name">${escapeHtml(best.name)}</div>
      <div class="ov-best-details">
        <span style="color:${bestCol};font-weight:800">${Math.round(best.feasibility_score ?? 0)} feasibility</span>
        <span>${(best.route?.terrain_adjusted_distance_km ?? 0).toFixed(2)} km</span>
        <span>${Math.round((best.estimated_daily_flow_liters ?? 0) / 1000)} m³/day</span>
        ${best.cost?.total_cost_eur != null ? `<span>${fmtCost(best.cost.total_cost_eur)}</span>` : ''}
      </div>
    </div>

    <div class="ov-stat-list">
      <div class="ov-stat-row">
        <div class="ov-stat-icon" style="background:rgba(22,163,74,.1)">
          <svg viewBox="0 0 24 24" fill="#16a34a"><path d="M12 2c-5.33 4.55-8 8.48-8 11.8 0 4.98 3.8 8.2 8 8.2s8-3.22 8-8.2C20 10.48 17.33 6.55 12 2z"/></svg>
        </div>
        <div class="ov-stat-body">
          <div class="ov-stat-label">Average Feasibility</div>
          <div class="ov-stat-bar-row">
            <div class="ov-stat-bar-track">
              <div class="ov-stat-bar-fill" style="width:${avgFs}%;background:${fc}"></div>
            </div>
            <div class="ov-stat-val" style="color:${fc}">${avgFs}</div>
          </div>
        </div>
      </div>

      <div class="ov-stat-row">
        <div class="ov-stat-icon" style="background:rgba(8,145,178,.1)">
          <svg viewBox="0 0 24 24" fill="#0891b2"><path d="M12 2c-5.33 4.55-8 8.48-8 11.8 0 4.98 3.8 8.2 8 8.2s8-3.22 8-8.2C20 10.48 17.33 6.55 12 2z"/></svg>
        </div>
        <div class="ov-stat-body">
          <div class="ov-stat-label">Total Estimated Daily Flow</div>
          <div class="ov-stat-number">${fmtNum(totalFlowM3)} <span>m³/day across all sources</span></div>
        </div>
      </div>

      <div class="ov-stat-row">
        <div class="ov-stat-icon" style="background:rgba(180,83,9,.1)">
          <svg viewBox="0 0 24 24" fill="#b45309"><path d="M12 2L2 7l10 5 10-5-10-5z"/></svg>
        </div>
        <div class="ov-stat-body">
          <div class="ov-stat-label">Annual Precipitation (10y avg)</div>
          <div class="ov-stat-number">${fmtNum(weather.mean_annual_precipitation_mm ?? 0)} <span>mm/year</span></div>
        </div>
      </div>
    </div>

    <div class="ov-type-row">
      ${Object.entries(typeCount).map(([type, count]) => {
        const col = TYPE_COLOR[type] ?? '#2563eb';
        return `<div class="ov-type-chip" style="border-color:${col}30;background:${col}10;color:${col}">
          ${TYPE_ICON[type] ?? TYPE_ICON.spring}
          ${count} ${TYPE_LABEL[type] ?? type}${count > 1 ? 's' : ''}
        </div>`;
      }).join('')}
    </div>`;
}

/* ── LOCATION SEARCH (geocoding) ───────────────── */
function getRecentSearches() {
  try { return JSON.parse(localStorage.getItem('h2o_recent') || '[]'); }
  catch { return []; }
}
function addRecentSearch(entry) {
  const recents = getRecentSearches().filter(r => r.name !== entry.name);
  recents.unshift(entry);
  localStorage.setItem('h2o_recent', JSON.stringify(recents.slice(0, 5)));
}

function renderRecentSuggestions(results) {
  const recents = getRecentSearches();
  const clockSvg = `<svg class="mos-pin mos-pin-outline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
  let html = '';
  if (recents.length) {
    html += `<div class="mos-section-label">Recent searches</div>`;
    recents.forEach(r => {
      const safeName = r.name.replace(/'/g, "\\'");
      html += `<div class="mos-item" onclick="flyToLocation(${r.lat},${r.lon},'${safeName}');hideSearchResults();setSearchInputValue('${safeName}');">
        ${clockSvg}<div class="mos-name">${escapeHtml(r.name)}</div>
      </div>`;
    });
  } else {
    html += `<div class="mos-no-result">Type a place name in Romania (e.g. "Brașov" or "Vrancea")</div>`;
  }
  results.innerHTML = html;
  results.style.display = 'block';
}

function hideSearchResults() {
  document.getElementById('location-results').style.display = 'none';
}
function setSearchInputValue(v) {
  document.getElementById('location-search').value = v;
}

async function geocodeSearch(q, results) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ', Romania')}&format=json&limit=6&countrycodes=ro`;
    const data = await (await fetch(url, { headers: { 'Accept-Language': 'en' } })).json();
    if (!data.length) {
      results.innerHTML = '<div class="mos-no-result">No results in Romania</div>';
      results.style.display = 'block';
      return;
    }
    let html = '';
    data.forEach(r => {
      const parts = r.display_name.split(',');
      const name = parts[0].trim();
      const safeName = name.replace(/'/g, "\\'");
      html += `<div class="mos-item" onclick="flyToLocation(${r.lat},${r.lon},'${safeName}');hideSearchResults();setSearchInputValue('${safeName}');addRecentSearch({name:'${safeName}',lat:${r.lat},lon:${r.lon}});">
        <svg class="mos-pin" viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>
        <div><div class="mos-name">${escapeHtml(name)}</div><div class="mos-region">${escapeHtml(parts.slice(1, 3).join(',').trim())}</div></div>
      </div>`;
    });
    results.innerHTML = html;
    results.style.display = 'block';
  } catch (e) {
    console.warn('[geocode]', e.message);
  }
}

function initLocationSearch() {
  const input   = document.getElementById('location-search');
  const results = document.getElementById('location-results');
  let timer;

  input.addEventListener('focus', () => {
    if (!input.value.trim()) renderRecentSuggestions(results);
  });

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      if (q.length === 0) renderRecentSuggestions(results);
      else { results.style.display = 'none'; results.innerHTML = ''; }
      return;
    }
    timer = setTimeout(() => geocodeSearch(q, results), 340);
  });

  input.addEventListener('keydown', async e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value.trim();
      const firstVisible = results.style.display !== 'none' && results.querySelector('.mos-item');
      if (firstVisible) firstVisible.click();
      else if (q.length >= 2) {
        await geocodeSearch(q, results);
        results.querySelector('.mos-item')?.click();
      }
    } else if (e.key === 'Escape') {
      hideSearchResults();
      input.blur();
    }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#map-overlay-search')) {
      if (document.body.classList.contains('landing') && !input.value.trim()) {
        renderRecentSuggestions(results);
      } else {
        hideSearchResults();
      }
    }
  });

  const overlay = document.getElementById('map-overlay-search');
  if (overlay) {
    ['click', 'mousedown', 'dblclick', 'wheel'].forEach(ev =>
      overlay.addEventListener(ev, e => e.stopPropagation()));
  }

  if (document.body.classList.contains('landing')) renderRecentSuggestions(results);
}

/* ── UTILITIES ─────────────────────────────────── */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])
  );
}

/* ── INIT ──────────────────────────────────────── */
async function init() {
  initMap();
  renderWelcomePanel();
  document.getElementById('sources-count').textContent = '—';
  document.getElementById('sources-list').innerHTML =
    `<div class="bm-empty">Search a location to discover water sources.</div>`;
  document.getElementById('overview-stats').innerHTML = '';

  initLocationSearch();

  const online = await H2O.checkBackend();
  if (!online) {
    renderErrorPanel(
      'Backend offline',
      `The Flask backend at ${H2O.base} did not respond.\nStart it from the project root with:\n    py -m backend.server\n\nThen reload this page.`
    );
  }
}

init();
