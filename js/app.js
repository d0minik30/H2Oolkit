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

const SCAN_RADIUS_KM = 7;

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
let _lastAnalysisResult = null; // full result from analyzeSite, for PDF export
let _selectedSourceId = null;
let _collectionMarker = null;
let _pipelineLayer = null;
let _currentLocationName = '';

/* ── MAP ───────────────────────────────────────── */
function initMap() {
  // Esri's World_Imagery tile pyramid stops having usable imagery for rural
  // Romania around z=17 — anything past that returns the placeholder
  // "Map data not yet available." Cap the map there.
  const MAP_MAX_ZOOM = 17;

  leafletMap = L.map('map', {
    center: [46.0, 25.0], zoom: 7, zoomControl: true,
    maxBounds: ROMANIA_BOUNDS, maxBoundsViscosity: 1.0,
    // Allow half-step zoom so the dynamic minZoom can sit a bit looser than
    // the exact "country fits viewport" zoom level (see updateRomaniaMinZoom).
    zoomSnap: 0.5,
    maxZoom: MAP_MAX_ZOOM,
  });

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Imagery &copy; Esri', maxZoom: MAP_MAX_ZOOM,
  }).addTo(leafletMap);

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
    attribution: '', maxZoom: MAP_MAX_ZOOM, opacity: 0.85,
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

  // Compute the smallest zoom level where the entire Romania bounding box
  // still fits inside the visible map viewport, then use that as minZoom
  // so the user can't zoom out further. Recompute whenever the viewport
  // size changes (window resize, fullscreen toggle, layout change).
  updateRomaniaMinZoom();
  window.addEventListener('resize', () => {
    leafletMap.invalidateSize();
    updateRomaniaMinZoom();
  });
}

function updateRomaniaMinZoom() {
  if (!leafletMap) return;
  // getBoundsZoom returns the tightest zoom where Romania still fits. Subtract
  // half a level so the user can pull back a bit further than the strict fit
  // — the country stays visible with some breathing room around it.
  const fitZoom   = leafletMap.getBoundsZoom(ROMANIA_BOUNDS, false);
  const minAllowed = Math.max(2, fitZoom - 0.5);
  leafletMap.setMinZoom(minAllowed);
  if (leafletMap.getZoom() < minAllowed) leafletMap.setZoom(minAllowed);
}

function exitLandingMode() {
  if (!document.body.classList.contains('landing')) return;
  document.body.classList.remove('landing');
  document.body.classList.add('page-enter');
  setTimeout(() => document.body.classList.remove('page-enter'), 1200);
  leafletMap.dragging.enable();
  leafletMap.touchZoom.enable();
  leafletMap.doubleClickZoom.enable();
  leafletMap.scrollWheelZoom.enable();
  leafletMap.boxZoom.enable();
  leafletMap.keyboard.enable();
  leafletMap.zoomControl.getContainer().style.display = '';
  // Don't invalidate here — the caller does it after the layout transition
  // settles so flyTo() centers on the post-transition viewport, not the
  // stale full-screen landing dimensions.
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

/* ── 1. LOCATION SEARCH → ask for pin drop ─────── */
async function flyToLocation(lat, lon, name) {
  const wasLanding = document.body.classList.contains('landing');
  resetAll();
  _currentLocationName = name;
  _scanCenter = { lat: parseFloat(lat), lon: parseFloat(lon) };

  exitLandingMode();

  const flyDelay = wasLanding ? 480 : 0;
  setTimeout(() => {
    leafletMap.invalidateSize();
    leafletMap.flyTo([_scanCenter.lat, _scanCenter.lon], 14, { duration: 0.9 });
  }, flyDelay);

  appState = 'awaiting-pin';
  drawScanCircle();
  document.getElementById('map').style.cursor = 'crosshair';
  setMapInstruction(true, `📍 Click inside the blue circle — within ${SCAN_RADIUS_KM} km of ${name} — to set your collection point`);
  renderPinDropPanel(name);
  document.getElementById('sources-count').textContent = '—';
  document.getElementById('sources-list').innerHTML =
    `<div class="bm-empty">Place a collection point on the map to discover water sources.</div>`;
  document.getElementById('overview-stats').innerHTML = '';
}

/* ── 1b. PIN DROPPED → draw circle + fetch + analyse ─ */
async function startAnalysisFromPin(lat, lon) {
  appState = 'scanning';
  document.getElementById('map').style.cursor = '';
  setMapInstruction(false);

  if (!_scanCircle) drawScanCircle();
  setTimeout(() => setCollectionMarker(lat, lon), 400);

  renderLoadingPanel(`Scanning water sources within ${SCAN_RADIUS_KM} km of ${_currentLocationName}…`);
  document.getElementById('sources-count').textContent = 'scanning…';
  document.getElementById('sources-list').innerHTML =
    `<div class="bm-empty">Searching OpenStreetMap and EU-Hydro databases…</div>`;
  document.getElementById('overview-stats').innerHTML = '';

  try {
    const data = await H2O.fetchWaterSources(_scanCenter.lat, _scanCenter.lon, SCAN_RADIUS_KM * 1000);
    _sources = data.sources || [];
    await runFeasibilityAnalysis(lat, lon);
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
      html: `<div class="src-marker-hit"><div class="src-marker src-marker-blue"></div></div>`,
      className: '', iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -10],
    });
    const m = L.marker([src.lat, src.lon], { icon, zIndexOffset: 400 }).addTo(leafletMap);
    m.bindTooltip(
      `<b>${escapeHtml(src.name)}</b><br>${TYPE_LABEL[src.source_type] ?? src.source_type}`,
      { direction: 'top', offset: [0, -6] }
    );
    m.on('click', e => {
      L.DomEvent.stopPropagation(e);
      if (appState === 'analyzed') {
        selectSourceById(String(src.id), { pan: true });
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

// Drop sources outside the scan circle, then drop low-feasibility ones unless
// keeping them is needed to clear a minimum-result floor (≥ 20 inside).
function filterVisibleSources(ranked) {
  const inside = ranked.filter(s => isInsideScanCircle(s.lat, s.lon));
  if (inside.length >= 20) {
    return inside.filter(s => (s.feasibility_score ?? 0) > 50);
  }
  return inside;
}

function onMapMouseMove(e) {
  if (appState !== 'awaiting-pin' && appState !== 'point-select') return;
  const inside = isInsideScanCircle(e.latlng.lat, e.latlng.lng);
  document.getElementById('map').style.cursor = inside ? 'crosshair' : 'not-allowed';
}

async function onMapClick(e) {
  if (appState === 'awaiting-pin') {
    if (!isInsideScanCircle(e.latlng.lat, e.latlng.lng)) return;
    await startAnalysisFromPin(e.latlng.lat, e.latlng.lng);
    return;
  }
  if (appState !== 'point-select') return;
  if (!isInsideScanCircle(e.latlng.lat, e.latlng.lng)) return;
  await runFeasibilityAnalysis(e.latlng.lat, e.latlng.lng);
}

/* ── 3. FEASIBILITY ANALYSIS ───────────────────── */
async function runFeasibilityAnalysis(lat, lon) {
  appState = 'analyzing';
  document.getElementById('map').style.cursor = '';
  setMapInstruction(false);

  renderLoadingPanel('Calculating feasibility for every source…\n(may take 10–30 s — fetching satellite & EU-Hydro data)');
  document.getElementById('sources-count').textContent = 'analysing…';

  try {
    const result = await H2O.analyzeSite({
      collection_point: { lat, lon },
      search_center:    { lat: _scanCenter.lat, lon: _scanCenter.lon },
      radius_m:         SCAN_RADIUS_KM * 1000,
      name:             _currentLocationName,
    });

    _rankedSources = filterVisibleSources(result.ranked_sources || []);
    _lastAnalysisResult = result;
    appState = 'analyzed';

    if (_rankedSources.length === 0) {
      renderEmptyResultsPanel(result);
      return;
    }

    // Place markers only for ranked sources, already colored by feasibility
    addSourceMarkers(_rankedSources);
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
    const html = `<div class="src-marker-hit"><div class="src-marker" style="background:${col}"></div></div>`;
    m.setIcon(L.divIcon({ html, className: '', iconSize: [32, 32], iconAnchor: [16, 16] }));
  });
}

function updateSourceMarkerActiveState() {
  Object.entries(_sourceMarkers).forEach(([id, m]) => {
    const el = m.getElement();
    if (!el) return;
    const hit = el.querySelector('.src-marker-hit');
    if (!hit) return;
    hit.classList.toggle('src-marker-hit-active', id === _selectedSourceId);
  });
}

function selectSourceById(id, { pan = false } = {}) {
  _selectedSourceId = id;
  const src = _rankedSources.find(s => String(s.id) === id);
  if (!src) return;
  drawPipeline(src);
  renderDetailPanel(src);
  updateSourceMarkerActiveState();
  if (pan) leafletMap.panTo([src.lat, src.lon], { animate: true });
}

function navigateSourceByDirection(dx, dy) {
  if (appState !== 'analyzed' || !_rankedSources.length) return;
  const current = _rankedSources.find(s => String(s.id) === _selectedSourceId);
  if (!current) {
    selectSourceById(String(_rankedSources[0].id));
    return;
  }
  const curPt = leafletMap.latLngToContainerPoint([current.lat, current.lon]);
  let best = null, bestScore = -Infinity;
  for (const src of _rankedSources) {
    if (String(src.id) === _selectedSourceId) continue;
    const pt = leafletMap.latLngToContainerPoint([src.lat, src.lon]);
    const px = pt.x - curPt.x, py = pt.y - curPt.y;
    // along: signed distance projected onto the arrow direction (must be positive
    // for the candidate to count as "in that direction"). perp: how far it strays
    // from the axis. Score favours larger along, smaller perp, smaller total.
    const along = px * dx + py * dy;
    if (along <= 0) continue;
    const perp = Math.abs(px * dy - py * dx);
    if (perp > along) continue; // outside ±45° cone
    const dist = Math.hypot(px, py);
    const score = along / (dist + perp * 1.5 + 1);
    if (score > bestScore) { bestScore = score; best = src; }
  }
  if (best) selectSourceById(String(best.id), { pan: true });
}

document.addEventListener('keydown', e => {
  if (appState !== 'analyzed') return;
  if (e.target.matches('input, textarea, [contenteditable="true"]')) return;
  let dx = 0, dy = 0;
  switch (e.key) {
    case 'ArrowLeft':  dx = -1; break;
    case 'ArrowRight': dx =  1; break;
    case 'ArrowUp':    dy = -1; break;
    case 'ArrowDown':  dy =  1; break;
    default: return;
  }
  e.preventDefault();
  e.stopPropagation();
  navigateSourceByDirection(dx, dy);
}, true);

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

function renderPinDropPanel(name) {
  document.getElementById('detail-panel').innerHTML = `
    <div class="dp-header">
      <div>
        <div class="dp-title">${escapeHtml(name)}</div>
        <div class="dp-sub">Ready to scan &middot; ${SCAN_RADIUS_KM} km radius</div>
      </div>
    </div>
    <div class="dp-instruction-box">
      <svg viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5S10.62 6.5 12 6.5s2.5 1.12 2.5 2.5S13.38 11.5 12 11.5z"/></svg>
      <div>
        <div class="dp-instr-title">Drop a Collection Point</div>
        <div class="dp-instr-text">Click inside the blue circle — within ${SCAN_RADIUS_KM} km of your searched location — to place your water collection point. The cursor turns into a crosshair when you're in range; clicks outside the circle are ignored. The system will then discover all nearby water sources and rank the best 15 by feasibility.</div>
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

  const pumping = cost.needs_pumping
    ? `<span class="dp-eu-badge dp-eu-off">Requires pump</span>` : `<span class="dp-eu-badge dp-eu-ok">Gravity-fed</span>`;

  document.getElementById('detail-panel').innerHTML = `
    <div class="dp-header">
      <div>
        <div class="dp-title" style="display:flex;align-items:center;gap:7px">
          <span class="src-icon-sm" style="background:${col}20;color:${col}">${icon}</span>
          ${escapeHtml(src.name)}
        </div>
        <div class="dp-sub">
          ${escapeHtml(_currentLocationName)} &middot; ${TYPE_LABEL[src.source_type] ?? src.source_type}
          ${euBadge} ${pumping}
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
        <text x="${CX}" y="${CY + 13}" text-anchor="middle" fill="currentColor" opacity="0.7" font-size="11" font-family="Outfit,sans-serif">${lbl}</text>
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

    ${cost.pipeline_km != null ? `
    <div class="dp-section">
      <div class="dp-section-label">Pipeline</div>
      <div class="dp-cost-breakdown">
        <div class="dp-cost-row"><span>Pipe run</span><span>${(+cost.pipeline_km).toFixed(2)} km</span></div>
        ${cost.needs_pumping ? `<div class="dp-cost-row"><span>Feed type</span><span>Pumped (${Math.abs(cost.elevation_diff_m ?? 0).toFixed(0)} m lift)</span></div>` : `<div class="dp-cost-row"><span>Feed type</span><span>Gravity-fed</span></div>`}
        <div class="dp-cost-row"><span>Reservoir</span><span>${cost.reservoir_m3 ?? '—'} m³</span></div>
        <div class="dp-cost-row"><span>Supply cover</span><span>${cost.supply_covers_demand_pct ?? '?'}%</span></div>
      </div>
    </div>` : ''}

    <div class="dp-section">
      <div class="dp-section-label">Project Dimensions</div>
      <div class="dp-cost-breakdown">
        <div class="dp-cost-row"><span>Straight-line distance</span><span>${((route.straight_line_distance_m ?? src.distance_m) / 1000).toFixed(2)} km</span></div>
        <div class="dp-cost-row"><span>Terrain-adjusted route</span><span>${distKm.toFixed(2)} km</span></div>
        <div class="dp-cost-row"><span>Terrain factor</span><span>&times;${route.terrain_factor ?? 1.25}</span></div>
        <div class="dp-cost-row"><span>Slope gradient</span><span>${(route.slope_pct ?? 0).toFixed(1)}%</span></div>
        <div class="dp-cost-row"><span>Elevation difference</span><span>${elevDiff > 0 ? '+' : ''}${Math.round(elevDiff)} m</span></div>
        <div class="dp-cost-row"><span>Recommended pipe ⌀</span><span>${route.pipe_diameter_mm ?? '—'} mm</span></div>
        <div class="dp-cost-row"><span>Pressure class</span><span>${route.pressure_class ?? '—'}</span></div>
        <div class="dp-cost-row"><span>Reservoir volume</span><span>${cost.reservoir_m3 ?? '—'} m³</span></div>
      </div>
    </div>

    <div class="dp-section">
      <div class="dp-section-label">Recommendation</div>
      ${renderRecommendationCard(src)}
    </div>

    <div class="dp-pdf-wrap">
      <button class="dp-pdf-btn" onclick="downloadReport()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Download PDF Report
        <span class="dp-pdf-badge">Top 5 sources</span>
      </button>
      <div class="dp-pdf-hint">Includes all ranked sources, route data &amp; recommendations</div>
    </div>
  `;
}

const REC_ICONS = {
  check:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  warn:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  cross:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  leaf:    `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 8C8 10 5.9 16.17 3.82 21.34l1.89.66.95-2.3c.48.17.98.3 1.34.3C19 20 22 3 22 3c-1 2-8 2.25-13 3.25S2 11.5 2 13.5s1.75 3.75 1.75 3.75C7 8 17 8 17 8z"/></svg>`,
  route:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M6.7 17.3 9 12l3 5 3-7 2.5 4"/></svg>`,
  pump:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/></svg>`,
  drop:    `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c-5.33 4.55-8 8.48-8 11.8 0 4.98 3.8 8.2 8 8.2s8-3.22 8-8.2C20 10.48 17.33 6.55 12 2z"/></svg>`,
  link:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
};

function recVerdict(score) {
  if (score >= 80) return { tone: 'good', title: 'Strongly Recommended',  icon: 'check' };
  if (score >= 60) return { tone: 'okay', title: 'Recommended',           icon: 'check' };
  if (score >= 40) return { tone: 'mid',  title: 'Proceed with Caution',  icon: 'warn'  };
  if (score >= 20) return { tone: 'low',  title: 'Not Ideal',             icon: 'warn'  };
  return                  { tone: 'bad',  title: 'Not Recommended',       icon: 'cross' };
}

function buildRecPoints(src) {
  const points = [];
  const cost  = src.cost  || {};
  const route = src.route || {};

  // Gravity vs pumping — biggest cost-of-operation signal
  if (cost.needs_pumping) {
    const lift = Math.abs(cost.elevation_diff_m ?? route.elevation_difference_m ?? 0);
    points.push({
      tone: 'warn', icon: 'pump',
      html: `<strong>Pumping required</strong> &middot; ${Math.round(lift)} m vertical lift`,
    });
  } else {
    points.push({
      tone: 'good', icon: 'leaf',
      html: `<strong>Gravity-fed</strong> &middot; no pumps, low operating cost`,
    });
  }

  // Pipeline distance — short = good, long = a flag
  const distKm = route.terrain_adjusted_distance_km ?? (src.distance_m ? src.distance_m / 1000 : null);
  if (distKm != null) {
    const tone = distKm < 2 ? 'good' : distKm < 5 ? 'neutral' : 'warn';
    points.push({
      tone, icon: 'route',
      html: `<strong>${distKm.toFixed(2)} km</strong> pipeline route`,
    });
  }

  // Demand coverage
  const cov = cost.supply_covers_demand_pct;
  if (cov != null) {
    if (cov >= 100) {
      points.push({
        tone: 'good', icon: 'drop',
        html: `<strong>Fully meets</strong> daily demand`,
      });
    } else {
      points.push({
        tone: 'warn', icon: 'drop',
        html: `Covers <strong>${cov}%</strong> of demand &middot; supplemental source needed`,
      });
    }
  }

  // EU-Hydro verification — confidence signal
  if (src.eu_hydro_linked === true) {
    points.push({
      tone: 'good', icon: 'link',
      html: `Verified in <strong>EU-Hydro</strong> dataset`,
    });
  }

  return points;
}

function renderRecommendationCard(src) {
  const fs = src.feasibility_score ?? 0;
  const v  = recVerdict(fs);
  const points = buildRecPoints(src);

  const pointsHtml = points.map(p => `
    <div class="dp-rec-point dp-rec-point-${p.tone}">
      <div class="dp-rec-point-icon">${REC_ICONS[p.icon] ?? REC_ICONS.check}</div>
      <div class="dp-rec-point-text">${p.html}</div>
    </div>
  `).join('');

  return `
    <div class="dp-rec-card dp-rec-card-${v.tone}">
      <div class="dp-rec-header">
        <div class="dp-rec-icon">${REC_ICONS[v.icon]}</div>
        <div class="dp-rec-verdict">
          <div class="dp-rec-verdict-title">${v.title}</div>
          <div class="dp-rec-verdict-sub">Feasibility ${Math.round(fs)} / 100 &middot; ${feasLabel(fs)}</div>
        </div>
        <div class="dp-rec-score">${Math.round(fs)}</div>
      </div>
      ${points.length ? `<div class="dp-rec-points">${pointsHtml}</div>` : ''}
    </div>`;
}

/* ── PDF REPORT EXPORT ─────────────────────────── */
async function downloadReport() {
  if (!_rankedSources || !_rankedSources.length) return;

  const btn = document.querySelector('.dp-pdf-btn');
  const origHtml = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<span style="opacity:.7">Generating PDF…</span>'; }

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    const PAGE_W = 210, PAGE_H = 297, M = 18;
    const CW = PAGE_W - M * 2;

    const C = {
      blue:   [37, 99, 235],  blueD:  [29, 78, 216],
      green:  [5, 150, 105],  orange: [180, 83, 9],
      red:    [220, 38, 38],  dark:   [15, 23, 42],
      sub:    [51, 65, 85],   muted:  [100, 116, 139],
      border: [226, 232, 240],bg:     [248, 250, 252],
      white:  [255, 255, 255],stripe: [241, 245, 249],
      card:   [255, 255, 255],
    };

    const feasRgb = s => s >= 80 ? C.green : s >= 60 ? C.blue : s >= 40 ? C.orange : C.red;

    // Load logo
    let logoDataUrl = null;
    try {
      const blob = await (await fetch('H2Oolkit.png')).blob();
      logoDataUrl = await new Promise(res => { const r = new FileReader(); r.onload = e => res(e.target.result); r.readAsDataURL(blob); });
    } catch (_) {}

    const top5     = _rankedSources.slice(0, 5);
    const location = _currentLocationName || 'Unknown Location';
    const weather  = _lastAnalysisResult?.weather || {};
    const cp       = _lastAnalysisResult?.collection_point;
    const dateStr  = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });

    // ── helpers ──
    const sectionTitle = (text, yPos) => {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(...C.dark);
      doc.text(text, M, yPos);
      doc.setDrawColor(...C.border);
      doc.setLineWidth(0.35);
      doc.line(M, yPos + 2.5, PAGE_W - M, yPos + 2.5);
      return yPos + 10;
    };

    let y = 0;

    // ════════════════════════════════════════════════
    // HEADER
    // ════════════════════════════════════════════════
    doc.setFillColor(...C.blue);
    doc.rect(0, 0, PAGE_W, 40, 'F');
    // subtle darker triangle accent
    doc.setFillColor(...C.blueD);
    doc.triangle(PAGE_W - 55, 0, PAGE_W, 0, PAGE_W, 40, 'F');

    if (logoDataUrl) {
      doc.addImage(logoDataUrl, 'PNG', M, 8, 22, 22);
      doc.setTextColor(...C.white);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
      doc.text('Water Source Analysis Report', M + 27, 20);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
      doc.setTextColor(200, 220, 255);
      doc.text('H2Oolkit · Spring Source Detection Platform', M + 27, 28);
    } else {
      doc.setTextColor(...C.white);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
      doc.text('H2Oolkit', M, 20);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      doc.text('Water Source Analysis Report', M, 29);
    }

    doc.setTextColor(200, 220, 255);
    doc.setFontSize(7.5); doc.setFont('helvetica', 'normal');
    doc.text(dateStr, PAGE_W - M, 19, { align: 'right' });
    doc.text('CASSINI Hackathon — Space for Water', PAGE_W - M, 27, { align: 'right' });

    y = 48;

    // ── Location / meta strip ──
    doc.setFillColor(...C.bg);
    doc.setDrawColor(...C.border); doc.setLineWidth(0.3);
    doc.roundedRect(M, y, CW, 14, 2, 2, 'FD');

    // pin icon (simple circle + dot)
    doc.setFillColor(...C.blue);
    doc.circle(M + 7, y + 7, 3, 'F');
    doc.setFillColor(...C.white);
    doc.circle(M + 7, y + 7, 1.2, 'F');

    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5);
    doc.setTextColor(...C.dark);
    doc.text(location, M + 13, y + 9);

    if (cp) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
      doc.setTextColor(...C.muted);
      doc.text(`${cp.lat.toFixed(4)}°N  ${cp.lon.toFixed(4)}°E`, PAGE_W - M - 4, y + 9, { align: 'right' });
    }

    y += 22;

    // ════════════════════════════════════════════════
    // SUMMARY TABLE  (no Flow / Feed — only useful cols)
    // ════════════════════════════════════════════════
    y = sectionTitle('Top 5 Ranked Water Sources', y);

    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
    doc.setTextColor(...C.muted);
    doc.text('Composite feasibility score · satellite + terrain + cost analysis', M, y - 3);

    // Decide which optional columns to show
    const anyFlow   = top5.some(s => (s.estimated_daily_flow_liters || 0) > 0);
    const mixedFeed = top5.some(s => s.cost?.needs_pumping) && top5.some(s => !s.cost?.needs_pumping);

    const cols = [
      { header: '#',           width: 9,  align: 'center' },
      { header: 'Source Name', width: 50, align: 'left'   },
      { header: 'Type',        width: 26, align: 'left'   },
      { header: 'Score',       width: 18, align: 'center' },
      { header: 'Route',       width: 22, align: 'center' },
      { header: 'Elevation',   width: 22, align: 'center' },
      { header: 'Supply%',     width: 18, align: 'center' },
      ...(anyFlow   ? [{ header: 'Flow',   width: 16, align: 'center' }] : []),
      ...(mixedFeed ? [{ header: 'Feed',   width: 16, align: 'center' }] : []),
    ];

    const tbody = top5.map(src => {
      const fs        = src.feasibility_score ?? 0;
      const route     = src.route || {};
      const cost      = src.cost  || {};
      const distKm    = (route.terrain_adjusted_distance_km ?? (src.distance_m / 1000)).toFixed(2) + ' km';
      const elevDiff  = Math.round(route.elevation_difference_m ?? 0);
      const flowM3    = Math.round((src.estimated_daily_flow_liters || 0) / 1000);
      const supplyCov = cost.supply_covers_demand_pct != null ? `${cost.supply_covers_demand_pct}%` : '—';
      const row = [
        `#${src.feasibility_rank ?? '?'}`,
        src.name,
        TYPE_LABEL[src.source_type] ?? src.source_type,
        `${Math.round(fs)}`,
        distKm,
        `${elevDiff >= 0 ? '+' : ''}${elevDiff} m`,
        supplyCov,
        ...(anyFlow   ? [`${flowM3} m³/d`]                           : []),
        ...(mixedFeed ? [cost.needs_pumping ? 'Pumped' : 'Gravity']  : []),
      ];
      return row;
    });

    const colStyles = {};
    cols.forEach((col, i) => {
      colStyles[i] = { cellWidth: col.width, halign: col.align };
      if (i === 0) colStyles[i].fontStyle = 'bold';
    });

    doc.autoTable({
      head: [cols.map(c => c.header)],
      body: tbody,
      startY: y,
      margin: { left: M, right: M },
      tableWidth: CW,
      styles: {
        font: 'helvetica', fontSize: 8.5,
        cellPadding: { top: 4.5, bottom: 4.5, left: 3, right: 3 },
        textColor: C.dark, lineColor: C.border, lineWidth: 0.2,
        overflow: 'ellipsize',
      },
      headStyles: {
        fillColor: C.blue, textColor: C.white,
        fontStyle: 'bold', fontSize: 8, halign: 'center',
      },
      columnStyles: colStyles,
      didParseCell: data => {
        if (data.section !== 'body') return;
        // alternating row tint
        if (data.row.index % 2 === 0) data.cell.styles.fillColor = C.stripe;
        // score column — colour-coded + bold
        if (data.column.index === 3) {
          const s = parseInt(data.cell.raw);
          if (!isNaN(s)) { data.cell.styles.textColor = feasRgb(s); data.cell.styles.fontStyle = 'bold'; }
        }
        // feed column (last, if present)
        if (mixedFeed && data.column.index === cols.length - 1) {
          data.cell.styles.textColor = data.cell.raw === 'Gravity' ? C.green : C.orange;
          data.cell.styles.fontStyle = 'bold';
        }
      },
    });

    y = doc.lastAutoTable.finalY + 14;

    // ════════════════════════════════════════════════
    // PER-SOURCE DETAIL CARDS
    // ════════════════════════════════════════════════
    y = sectionTitle('Source Details', y);

    top5.forEach((src, i) => {
      const fs    = src.feasibility_score ?? 0;
      const fc    = feasRgb(fs);
      const route = src.route || {};
      const cost  = src.cost  || {};
      const verd  = recVerdict(fs);
      const distKm = (route.terrain_adjusted_distance_km ?? (src.distance_m / 1000)).toFixed(2);
      const elev   = Math.round(route.elevation_difference_m ?? 0);
      const flowM3 = Math.round((src.estimated_daily_flow_liters || 0) / 1000);

      // Build only metrics that have real values
      const rawMetrics = [
        ['PIPELINE',      `${distKm} km`],
        ['ELEVATION',     `${elev >= 0 ? '+' : ''}${elev} m`],
        ...(flowM3 > 0          ? [['DAILY FLOW', `${flowM3} m³/d`]]                         : []),
        ...(cost.needs_pumping != null ? [['FEED TYPE', cost.needs_pumping ? 'Pumped' : 'Gravity']] : []),
        ...(cost.supply_covers_demand_pct != null ? [['SUPPLY COVER', `${cost.supply_covers_demand_pct}%`]] : []),
        ...(route.pipe_diameter_mm      ? [['PIPE ⌀',   `${route.pipe_diameter_mm} mm`]]     : []),
        ...(cost.reservoir_m3           ? [['RESERVOIR', `${cost.reservoir_m3} m³`]]          : []),
        ...(src.eu_hydro_linked != null ? [['EU-HYDRO', src.eu_hydro_linked ? 'Verified ✓' : 'Not linked']] : []),
      ];

      // Cap at 8 metrics (2 rows × 4 cols)
      const metrics = rawMetrics.slice(0, 8);
      const metricRows = Math.ceil(metrics.length / 4);
      const hasRec  = !!src.recommendation;
      const recH    = hasRec ? 18 : 0;
      const blockH  = 22 + metricRows * 12 + recH + 6;

      if (y + blockH > PAGE_H - 22) {
        addPageFooter(doc, PAGE_W, PAGE_H, M, C, doc.internal.getNumberOfPages());
        doc.addPage();
        y = M;
      }

      // White card with border
      doc.setFillColor(...C.card);
      doc.setDrawColor(...C.border); doc.setLineWidth(0.25);
      doc.roundedRect(M, y, CW, blockH, 2.5, 2.5, 'FD');

      // Left accent bar
      doc.setFillColor(...fc);
      doc.roundedRect(M, y, 3.5, blockH, 2.5, 2.5, 'F');
      doc.rect(M + 1, y, 2.5, blockH, 'F');

      // Rank badge
      doc.setFillColor(...fc);
      doc.roundedRect(M + 7, y + 6, 12, 10, 1.5, 1.5, 'F');
      doc.setTextColor(...C.white);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5);
      doc.text(`#${src.feasibility_rank ?? i + 1}`, M + 13, y + 12.5, { align: 'center' });

      // Name
      doc.setTextColor(...C.dark);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
      doc.text(src.name, M + 23, y + 10);

      // Subtitle: type · verdict
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
      doc.setTextColor(...C.muted);
      doc.text(`${TYPE_LABEL[src.source_type] ?? src.source_type}  ·  ${verd.title}`, M + 23, y + 16.5);

      // Score pill — top right
      const scoreW = 22;
      doc.setFillColor(...fc);
      doc.roundedRect(PAGE_W - M - scoreW - 2, y + 5, scoreW, 11, 2, 2, 'F');
      doc.setTextColor(...C.white);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
      doc.text(`${Math.round(fs)}`, PAGE_W - M - scoreW / 2 - 2 + 3, y + 12.5, { align: 'center' });
      doc.setFontSize(6.5);
      doc.text('/100', PAGE_W - M - 4, y + 12.5, { align: 'right' });

      // Metric grid
      const colW  = CW / 4;
      const gx    = M + 6;
      const gy    = y + 24;
      metrics.forEach((m, mi) => {
        const col = mi % 4;
        const row = Math.floor(mi / 4);
        const mx  = gx + col * colW;
        const my  = gy + row * 12;
        doc.setFont('helvetica', 'bold'); doc.setFontSize(6);
        doc.setTextColor(...C.muted);
        doc.text(m[0], mx, my);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5);
        // colour-code feed type in the card too
        if (m[0] === 'FEED TYPE') {
          doc.setTextColor(...(m[1] === 'Gravity' ? C.green : C.orange));
        } else if (m[0] === 'EU-HYDRO') {
          doc.setTextColor(...(m[1].startsWith('Verified') ? C.green : C.muted));
        } else {
          doc.setTextColor(...C.dark);
        }
        doc.text(m[1], mx, my + 6);
      });

      // Recommendation quote
      if (hasRec) {
        const recY = y + blockH - recH;
        doc.setFillColor(...C.bg);
        const recLines = doc.splitTextToSize(src.recommendation, CW - 14);
        doc.rect(M, recY, CW, recH, 'F');
        doc.setDrawColor(...fc); doc.setLineWidth(0.8);
        doc.line(M + 5, recY + 2, M + 5, recY + recH - 2);
        doc.setLineWidth(0.25);
        doc.setFont('helvetica', 'italic'); doc.setFontSize(7.5);
        doc.setTextColor(...C.sub);
        doc.text(recLines.slice(0, 2), M + 9, recY + 6.5, { lineHeightFactor: 1.55 });
      }

      y += blockH + 7;
    });

    // ════════════════════════════════════════════════
    // CLIMATE SECTION
    // ════════════════════════════════════════════════
    if (weather?.mean_annual_precipitation_mm) {
      if (y + 60 > PAGE_H - 22) {
        addPageFooter(doc, PAGE_W, PAGE_H, M, C, doc.internal.getNumberOfPages());
        doc.addPage();
        y = M;
      }

      y = sectionTitle('Climate & Precipitation', y);

      if (weather.recommendation) {
        const wLines = doc.splitTextToSize(weather.recommendation, CW - 12);
        const bH = wLines.length * 5.5 + 8;
        doc.setFillColor(...C.bg); doc.rect(M, y, CW, bH, 'F');
        doc.setDrawColor(...C.blue); doc.setLineWidth(0.8);
        doc.line(M, y, M, y + bH);
        doc.setLineWidth(0.25);
        doc.setFont('helvetica', 'italic'); doc.setFontSize(8);
        doc.setTextColor(...C.sub);
        doc.text(wLines, M + 6, y + 5.5, { lineHeightFactor: 1.5 });
        y += bH + 8;
      }

      const wRows = [
        ['Annual Precipitation (10-year avg)', `${Math.round(weather.mean_annual_precipitation_mm)} mm`],
        ['Estimated Groundwater Recharge',     `${Math.round(weather.estimated_recharge_mm ?? 0)} mm/yr`],
        ['Precipitation Trend',                `${(weather.trend_mm_per_year ?? 0).toFixed(1)} mm/yr`],
        ['Climate Data Confidence',            `${Math.round((weather.confidence ?? 0) * 100)}%`],
      ];
      wRows.forEach((row, ri) => {
        if (ri % 2 === 0) { doc.setFillColor(...C.stripe); doc.rect(M, y - 1, CW, 8.5, 'F'); }
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...C.sub);
        doc.text(row[0], M + 4, y + 5);
        doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.dark);
        doc.text(row[1], PAGE_W - M - 4, y + 5, { align: 'right' });
        y += 8.5;
      });
    }

    // Footer on last page
    addPageFooter(doc, PAGE_W, PAGE_H, M, C, doc.internal.getNumberOfPages());

    const fname = `H2Oolkit_${location.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`;
    doc.save(fname);

  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = origHtml; }
  }
}

function addPageFooter(doc, PAGE_W, PAGE_H, M, C, pageNum) {
  const fy = PAGE_H - 13;
  doc.setFillColor(...C.blue);
  doc.rect(0, fy, PAGE_W, 13, 'F');
  doc.setTextColor(...C.white);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.text('H2Oolkit', M, fy + 8);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.text('Copernicus Sentinel-1/2  ·  EU-Hydro  ·  OpenStreetMap  ·  CASSINI Hackathon 2026', PAGE_W / 2, fy + 8, { align: 'center' });
  doc.text(`Page ${pageNum}`, PAGE_W - M, fy + 8, { align: 'right' });
}

function returnToPointSelect() {
  if (!_scanCenter) return;
  if (_collectionMarker) { leafletMap.removeLayer(_collectionMarker); _collectionMarker = null; }
  if (_pipelineLayer)    { leafletMap.removeLayer(_pipelineLayer);    _pipelineLayer = null; }
  if (_scanCenterMarker) { leafletMap.removeLayer(_scanCenterMarker); _scanCenterMarker = null; }
  Object.values(_sourceMarkers).forEach(m => leafletMap.removeLayer(m));
  _sourceMarkers = {};
  _sources = [];
  _rankedSources = [];
  _selectedSourceId = null;
  appState = 'awaiting-pin';
  if (!_scanCircle) drawScanCircle();
  document.getElementById('map').style.cursor = 'crosshair';
  setMapInstruction(true, `📍 Click inside the blue circle — within ${SCAN_RADIUS_KM} km of ${_currentLocationName} — to set your collection point`);
  renderPinDropPanel(_currentLocationName);
  document.getElementById('sources-count').textContent = '—';
  document.getElementById('sources-list').innerHTML =
    `<div class="bm-empty">Place a collection point on the map to discover water sources.</div>`;
  document.getElementById('overview-stats').innerHTML = '';
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
    const pipeKm = sp.cost?.pipeline_km != null ? (+sp.cost.pipeline_km).toFixed(1) + ' km pipe' : null;
    return `
    <div class="bm-src-row bm-src-row-clickable" id="srcc-${sp.id}"
         onclick="selectSourceById('${sp.id}', { pan: true })">
      <div class="bm-src-rank" style="background:${fc}20;color:${fc}">#${sp.feasibility_rank ?? sp.rank ?? '?'}</div>
      <div class="bm-src-icon" style="background:${col}18;color:${col}">${TYPE_ICON[sp.source_type] ?? TYPE_ICON.spring}</div>
      <div class="bm-src-info">
        <div class="bm-src-name">${escapeHtml(sp.name)}</div>
        <div class="bm-src-meta">
          ${TYPE_LABEL[sp.source_type] ?? sp.source_type} &middot; ${distKm} km
          ${pipeKm != null ? ' &middot; ' + pipeKm : ''}
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

  // Avg-feasibility donut geometry (matches dp-feas-svg style)
  const R = 52, CX = 70, CY = 70, circ = 2 * Math.PI * R;
  const dash = (avgFs / 100) * circ;

  // Cap visual fill at 1500 mm (Carpathian peaks reach ~1400 mm). Clamp 28–92 %
  // so the "value on water" label always has space to render inside the fill.
  const PRECIP_MAX_MM = 1500;
  const precipMm = Math.round(weather.mean_annual_precipitation_mm ?? 0);
  const precipPct = Math.max(28, Math.min(92, (precipMm / PRECIP_MAX_MM) * 100));

  // SVG viewBox is exactly the visible tap (80×50). The spout opening sits at
  // (40, 46), so .ov-tap-stream / .ov-tap-drop top:48px line up with the hole.
  const tapSvg = `
    <svg class="ov-tap-svg" viewBox="0 0 80 50" aria-hidden="true">
      <rect x="32" y="0"  width="16" height="5"  rx="1.5" fill="#475569"/>
      <rect x="36" y="5"  width="8"  height="5"  fill="#64748b"/>
      <rect x="20" y="10" width="40" height="16" rx="3" fill="#94a3b8"/>
      <rect x="22" y="12" width="36" height="3"  rx="1" fill="rgba(255,255,255,.45)"/>
      <path d="M32 26 L32 42 Q32 46 36 46 L44 46 Q48 46 48 42 L48 26 Z" fill="#94a3b8"/>
      <rect x="33" y="28" width="2"  height="14" fill="rgba(255,255,255,.35)"/>
      <ellipse cx="40" cy="46" rx="6.5" ry="2"   fill="#334155"/>
      <ellipse cx="40" cy="46" rx="4"   ry="1.2" fill="#0f172a"/>
    </svg>`;

  const wavePath = 'M0 4 Q25 0 50 4 T100 4 T150 4 T200 4 V8 H0 Z';

  const tickPositions = [20, 40, 60, 80];

  document.getElementById('overview-stats').innerHTML = `
    <div class="ov-best-card">
      <div class="ov-best-eyebrow">Best Option (rank #1)</div>
      <div class="ov-best-name">${escapeHtml(best.name)}</div>
      <div class="ov-best-details">
        <span style="color:${bestCol};font-weight:800">${Math.round(best.feasibility_score ?? 0)} feasibility</span>
        <span>${(best.route?.terrain_adjusted_distance_km ?? 0).toFixed(2)} km</span>
        <span>${Math.round((best.estimated_daily_flow_liters ?? 0) / 1000)} m³/day</span>
        ${best.cost?.pipeline_km != null ? `<span>${(+best.cost.pipeline_km).toFixed(1)} km pipe</span>` : ''}
      </div>
    </div>

    <div class="ov-metrics-grid">
      <div class="ov-metric-card">
        <div class="ov-metric-label">Average Feasibility</div>
        <div class="ov-metric-stage">
          <svg class="ov-feas-svg" viewBox="0 0 140 140">
            <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="var(--border)" stroke-width="11"/>
            <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${fc}" stroke-width="11"
              stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}" stroke-linecap="round"
              transform="rotate(-90 ${CX} ${CY})"/>
            <text x="${CX}" y="${CY - 2}" text-anchor="middle" fill="${fc}"
              font-size="28" font-weight="800" font-family="Outfit,sans-serif">${avgFs}</text>
            <text x="${CX}" y="${CY + 17}" text-anchor="middle" fill="currentColor" opacity="0.55"
              font-size="10" font-family="Outfit,sans-serif">/ 100</text>
          </svg>
        </div>
      </div>

      <div class="ov-metric-card">
        <div class="ov-metric-label">Total Daily Flow</div>
        <div class="ov-metric-stage">
          <div class="ov-tap-stage">
            ${tapSvg}
            <div class="ov-tap-stream"></div>
            <div class="ov-tap-drop"></div>
            <div class="ov-tap-puddle"></div>
          </div>
          <div class="ov-tap-value">${fmtNum(totalFlowM3)}<span>m³/d</span></div>
        </div>
      </div>

      <div class="ov-metric-card">
        <div class="ov-metric-label">Annual Precipitation (10y avg)</div>
        <div class="ov-metric-stage">
          <div class="ov-gauge-stage">
            <div class="ov-gauge-cylinder">
              <div class="ov-gauge-fill" style="height:${precipPct}%">
                <svg class="ov-gauge-wave ov-gauge-wave-back" viewBox="0 0 200 8" preserveAspectRatio="none" aria-hidden="true">
                  <path d="${wavePath}"/>
                </svg>
                <svg class="ov-gauge-wave ov-gauge-wave-front" viewBox="0 0 200 6" preserveAspectRatio="none" aria-hidden="true">
                  <path d="M0 3 Q25 0 50 3 T100 3 T150 3 T200 3 V6 H0 Z"/>
                </svg>
                <div class="ov-gauge-value">${fmtNum(precipMm)}<span>mm</span></div>
              </div>
              <div class="ov-gauge-marks">
                ${tickPositions.map(p =>
                  `<div class="ov-gauge-tick ${(p === 40 || p === 80) ? 'lg' : ''}" style="bottom:${p}%"></div>`
                ).join('')}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="ov-type-grid">
      ${Object.entries(typeCount).map(([type, count]) => {
        const col = TYPE_COLOR[type] ?? '#2563eb';
        const label = (TYPE_LABEL[type] ?? type) + (count > 1 ? 's' : '');
        return `<div class="ov-type-card" style="border-left-color:${col}">
          <div class="ov-type-card-icon" style="background:${col}18;color:${col}">${TYPE_ICON[type] ?? TYPE_ICON.spring}</div>
          <div class="ov-type-card-body">
            <div class="ov-type-card-num">${count}</div>
            <div class="ov-type-card-label">${label}</div>
          </div>
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

/* ── FULLSCREEN MAP TOGGLE ─────────────────────── */
const _EXPAND_ICON = `<path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/>`;
const _SHRINK_ICON = `<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>`;

function toggleMapExpand() {
  const isFs = document.body.classList.toggle('map-fullscreen');
  const btn  = document.getElementById('map-expand-btn');
  const icon = document.getElementById('map-expand-icon');
  if (icon) icon.innerHTML = isFs ? _SHRINK_ICON : _EXPAND_ICON;
  if (btn) {
    btn.title = isFs ? 'Exit fullscreen (Esc)' : 'Expand map';
    btn.classList.toggle('map-expand-btn-fs', isFs);
    // Show "Exit fullscreen" label next to the icon while in fullscreen
    let label = btn.querySelector('.map-expand-label');
    if (isFs && !label) {
      label = document.createElement('span');
      label.className = 'map-expand-label';
      label.textContent = 'Exit fullscreen';
      btn.appendChild(label);
    } else if (!isFs && label) {
      label.remove();
    }
  }

  // Info-dock collapse toggle (chevron in bottom-right)
  let dockToggle = document.getElementById('fs-info-dock-toggle');
  if (isFs && !dockToggle) {
    dockToggle = document.createElement('button');
    dockToggle.id = 'fs-info-dock-toggle';
    dockToggle.className = 'fs-info-dock-toggle';
    dockToggle.title = 'Hide info';
    dockToggle.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"/>
      </svg>`;
    dockToggle.onclick = () => {
      const hidden = document.body.classList.toggle('fs-info-hidden');
      dockToggle.title = hidden ? 'Show info' : 'Hide info';
    };
    document.body.appendChild(dockToggle);
  } else if (!isFs) {
    dockToggle?.remove();
    document.body.classList.remove('fs-info-hidden');
  }

  setTimeout(() => {
    leafletMap?.invalidateSize();
    updateRomaniaMinZoom();
  }, 380);
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('map-fullscreen')) {
    toggleMapExpand();
  }
});

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

  const scrollObserver = new IntersectionObserver(
    entries => entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('visible');
        scrollObserver.unobserve(e.target);
      }
    }),
    { threshold: 0.07 }
  );
  document.querySelectorAll('.scroll-fade').forEach(el => scrollObserver.observe(el));
}

init();
