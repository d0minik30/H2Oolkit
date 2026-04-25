/* app.js — H2Oolkit */

const MAX_RESERVE = 700;

const STATUS_LABEL = { verified: 'Verified', high_priority: 'High Priority', pending: 'Pending Review' };
const STATUS_COLOR = { verified: '#2563eb', high_priority: '#dc2626', pending: '#b45309' };

const GEOLOGY_LABEL = {
  limestone_karst: 'Limestone Karst', alluvial_gravel: 'Alluvial Gravel',
  crystalline_schist: 'Crystalline Schist', volcanic_tuff: 'Volcanic Tuff',
  flysch_sandstone: 'Flysch Sandstone', granite_gneiss: 'Granite Gneiss'
};

const ACCESS_COLOR = {
  'No piped water':       '#dc2626',
  'Seasonal shortages':   '#b45309',
  'Insufficient pressure':'#d97706'
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
function fmtPassDate(utc) { return new Date(utc).toISOString().replace('T',' ').slice(0,16) + ' UTC'; }

/* ── SEARCH (springs filter) ─────────────────────── */
let _allSprings = [];

function filterSprings(q) {
  const s = q.toLowerCase().trim();
  if (!s) return _allSprings;
  return _allSprings.filter(sp =>
    sp.name.toLowerCase().includes(s) || sp.region.toLowerCase().includes(s) ||
    sp.id.toLowerCase().includes(s) || sp.status.replace('_',' ').toLowerCase().includes(s) ||
    (sp.nearest_village && sp.nearest_village.toLowerCase().includes(s))
  );
}

function updateSearch(query) {
  const filtered = filterSprings(query);
  renderTable(filtered);
  _allSprings.forEach(sp => {
    markerRefs[sp.id]?.setOpacity(filtered.find(f => f.id === sp.id) ? 1 : 0.18);
  });
  const status = document.getElementById('search-status');
  status.innerHTML = (query.trim() && filtered.length < _allSprings.length)
    ? `<span class="search-count">${filtered.length} of ${_allSprings.length} match</span>` : '';
  const lbl = document.getElementById('map-filter-label');
  if (lbl) lbl.textContent = query.trim() ? `${filtered.length} result${filtered.length !== 1 ? 's' : ''} shown` : '';
}

/* ── MAP ─────────────────────────────────────────── */
let leafletMap;
const markerRefs = {};

function initMap() {
  leafletMap = L.map('map', { center: [46.0, 25.0], zoom: 7, zoomControl: true });

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
      <div class="legend-title">Map Legend</div>
      <div class="legend-item"><div class="legend-source" style="background:#2563eb"><svg viewBox="0 0 24 24" style="width:7px;height:7px;fill:rgba(255,255,255,.9)"><path d="M12 2c-1 2-5 6.5-5 9.5a5 5 0 0010 0C17 8.5 13 4 12 2z"/></svg></div>Water Source (Spring)</div>
      <div class="legend-item"><div style="width:20px;height:2px;border-top:2px dashed #94a3b8;flex-shrink:0"></div>Supply Route</div>
      <div class="legend-section" style="margin-top:5px">Villages</div>
      <div class="legend-item"><div class="legend-zone"></div>Water Need Zone</div>`;
    return d;
  };
  legend.addTo(leafletMap);
}

function addMarkers(springs) {
  springs.forEach(sp => {
    const icon = L.divIcon({
      html: `<div style="position:relative;width:26px;height:26px;"><div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:19px;height:19px;background:#2563eb;border:2.5px solid #fff;border-radius:50%;box-shadow:0 0 0 2.5px rgba(37,99,235,.35),0 2px 9px rgba(0,0,0,.45);cursor:pointer;display:flex;align-items:center;justify-content:center;"><svg viewBox="0 0 24 24" style="width:9px;height:9px;fill:rgba(255,255,255,.9)"><path d="M12 2c-1 2-5 6.5-5 9.5a5 5 0 0010 0C17 8.5 13 4 12 2z"/></svg></div></div>`,
      className: '', iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -17]
    });

    const popup = `
      <div class="popup-title">${sp.name} — ${sp.region}</div>
      <div class="popup-row"><span class="popup-k">Water Reserve</span><span class="popup-v">${sp.reserve} m³/day</span></div>
      <div class="popup-row"><span class="popup-k">Confidence</span><span class="popup-v">${sp.confidence}% (SAR)</span></div>
      <div class="popup-row"><span class="popup-k">Distance to Village</span><span class="popup-v">${sp.distance_km} km</span></div>
      <div class="popup-row"><span class="popup-k">Est. Cost</span><span class="popup-v">${fmtCost(sp.cost_eur)}</span></div>
      ${sp.nearest_village ? `<div class="popup-row"><span class="popup-k">Nearest Village</span><span class="popup-v">${sp.nearest_village}</span></div>` : ''}
      <div class="popup-badge"><span class="sbadge sbadge-${sp.status}">${STATUS_LABEL[sp.status]}</span></div>`;

    const marker = L.marker([sp.lat, sp.lon], { icon }).addTo(leafletMap).bindPopup(popup);
    marker.on('click', () => selectSpring(sp));
    markerRefs[sp.id] = marker;
  });
}

function addConnectionLines(springs, zones) {
  const springIndex = {};
  springs.forEach(sp => { springIndex[sp.id] = sp; });

  zones.forEach(feature => {
    const p = feature.properties;
    const sp = springIndex[p.linked_spring_id];
    if (!sp) return;

    const coords = feature.geometry.coordinates[0];
    const lons = coords.map(c => c[0]);
    const lats = coords.map(c => c[1]);
    const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const centerLon = (Math.min(...lons) + Math.max(...lons)) / 2;

    L.polyline([[sp.lat, sp.lon], [centerLat, centerLon]], {
      color: '#94a3b8', weight: 1.6, dashArray: '5 5', opacity: 0.7
    }).addTo(leafletMap).bindTooltip(
      `${sp.name} → ${p.village_name} &nbsp;·&nbsp; ${sp.distance_km} km &nbsp;·&nbsp; ${fmtCost(sp.cost_eur)}`,
      { sticky: true, className: 'line-tooltip' }
    );
  });
}

function addVillageZones(zones) {
  zones.forEach(feature => {
    const latlngs = feature.geometry.coordinates[0].map(([lon, lat]) => [lat, lon]);
    const p = feature.properties;

    L.polygon(latlngs, {
      color: '#dc2626', weight: 1.8, dashArray: '6 4',
      fillColor: '#dc2626', fillOpacity: 0.10
    }).addTo(leafletMap).bindPopup(`
      <div class="popup-title" style="color:#dc2626">&#9888; ${p.village_name}</div>
      <div class="popup-row"><span class="popup-k">County</span><span class="popup-v">${p.county}</span></div>
      <div class="popup-row"><span class="popup-k">Population</span><span class="popup-v">${p.population.toLocaleString()} residents</span></div>
      <div class="popup-row"><span class="popup-k">Water Need</span><span class="popup-v">${p.water_need_m3_day} m³/day</span></div>
      <div class="popup-row"><span class="popup-k">Status</span><span class="popup-v" style="color:#dc2626;font-weight:700">${p.access_status}</span></div>
      <div class="popup-row"><span class="popup-k">Linked Spring</span><span class="popup-v">${p.linked_spring_id}</span></div>
    `);
  });
}

/* ── LOCATION SEARCH (map geocoding) ─────────────── */
function initLocationSearch() {
  const input   = document.getElementById('location-search');
  const results = document.getElementById('location-results');
  let timer;

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { results.style.display = 'none'; results.innerHTML = ''; return; }
    timer = setTimeout(() => geocodeSearch(q, results), 380);
  });

  input.addEventListener('keydown', e => { if (e.key === 'Escape') { results.style.display = 'none'; input.blur(); } });

  document.addEventListener('click', e => {
    if (!e.target.closest('#map-overlay-search')) results.style.display = 'none';
  });

  const overlay = document.getElementById('map-overlay-search');
  if (overlay) {
    overlay.addEventListener('click',      e => e.stopPropagation());
    overlay.addEventListener('mousedown',  e => e.stopPropagation());
    overlay.addEventListener('dblclick',   e => e.stopPropagation());
    overlay.addEventListener('wheel',      e => e.stopPropagation());
  }
}

async function geocodeSearch(q, results) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ', Romania')}&format=json&limit=6&countrycodes=ro`;
    const res  = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    const data = await res.json();
    if (!data.length) {
      results.innerHTML = '<div class="mos-no-result">No results in Romania</div>';
      results.style.display = 'block'; return;
    }
    results.innerHTML = data.map(r => {
      const parts = r.display_name.split(',');
      return `<div class="mos-item" onclick="flyTo(${r.lat},${r.lon},'${parts[0].replace(/'/g,"\\'")}')">
        <svg class="mos-pin" viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>
        <div><div class="mos-name">${parts[0]}</div><div class="mos-region">${parts.slice(1,3).join(',').trim()}</div></div>
      </div>`;
    }).join('');
    results.style.display = 'block';
  } catch (e) {
    console.warn('[geocode] Failed:', e.message);
  }
}

function flyTo(lat, lon, name) {
  leafletMap.flyTo([lat, lon], 13, { duration: 1.4 });
  document.getElementById('location-results').style.display = 'none';
  document.getElementById('location-search').value = name;
}

/* ── DETAIL PANEL ────────────────────────────────── */
function renderDetailPlaceholder() {
  document.getElementById('detail-panel').innerHTML = `
    <div class="dp-placeholder">
      <div class="dp-ph-line" style="width:65%;height:17px;margin-bottom:7px"></div>
      <div class="dp-ph-line" style="width:42%;height:11px;margin-bottom:22px"></div>
      <div class="dp-ph-line" style="width:100%;height:74px;margin-bottom:14px"></div>
      <div class="dp-ph-line" style="width:100%;height:36px;margin-bottom:14px"></div>
      <div class="dp-ph-line" style="width:100%;height:110px;margin-bottom:14px"></div>
      <div class="dp-ph-line" style="width:100%;height:90px;margin-bottom:14px"></div>
      <div class="dp-ph-line" style="width:100%;height:38px"></div>
    </div>`;
}

function renderDetail(sp) {
  const bd  = breakdown(sp.cost_eur);
  const pct = (sp.reserve / MAX_RESERVE * 100).toFixed(1);
  const cc  = confColor(sp.confidence);
  const sat = sp.satellite ?? {};
  const sarPct  = sat.sentinel1_sar_anomaly != null ? (sat.sentinel1_sar_anomaly * 100).toFixed(0) : 0;
  const ndwiPct = sat.sentinel2_ndwi        != null ? (sat.sentinel2_ndwi        * 100).toFixed(0) : 0;
  const sarColor = sat.sentinel1_sar_anomaly >= 0.8 ? '#059669' : sat.sentinel1_sar_anomaly >= 0.6 ? '#2563eb' : '#b45309';

  document.getElementById('detail-panel').innerHTML = `
    <div class="dp-header">
      <div>
        <div class="dp-title">${sp.name}</div>
        <div class="dp-sub">${sp.region} County &middot; ${sp.id}${sp.nearest_village ? ' &middot; ' + sp.nearest_village : ''}</div>
      </div>
      <span class="sbadge sbadge-${sp.status}">${STATUS_LABEL[sp.status]}</span>
    </div>

    <div class="dp-section">
      <div class="dp-section-label">Water Reserve Capacity</div>
      <div class="gauge-box">
        <div class="gauge-top"><span class="gauge-val">${sp.reserve} m³/day</span><span class="gauge-cap">Max: ${MAX_RESERVE} m³/day</span></div>
        <div class="gauge-track"><div class="gauge-fill" style="width:${pct}%"></div></div>
        <div class="gauge-hint">${pct}% of regional threshold</div>
      </div>
    </div>

    <div class="dp-section">
      <div class="dp-section-label">Detection Confidence</div>
      <div class="conf-row">
        <span class="conf-num" style="color:${cc}">${sp.confidence}%</span>
        <div class="conf-track"><div class="conf-fill" style="width:${sp.confidence}%;background:${cc}"></div></div>
      </div>
    </div>

    <div class="dp-section">
      <div class="dp-section-label">Satellite Telemetry</div>
      <div class="sat-grid">
        <div class="sat-cell">
          <div class="sat-lbl">SAR Anomaly (S-1)</div>
          <div class="sat-val" style="color:${sarColor}">${sarPct}%</div>
          <div class="gauge-track" style="margin-top:5px"><div class="gauge-fill" style="width:${sarPct}%;background:${sarColor}"></div></div>
        </div>
        <div class="sat-cell">
          <div class="sat-lbl">NDWI Index (S-2)</div>
          <div class="sat-val" style="color:#2563eb">${sat.sentinel2_ndwi != null ? sat.sentinel2_ndwi.toFixed(2) : '—'}</div>
          <div class="gauge-track" style="margin-top:5px"><div class="gauge-fill" style="width:${ndwiPct}%;background:#2563eb"></div></div>
        </div>
        <div class="sat-cell">
          <div class="sat-lbl">DEM Slope</div>
          <div class="sat-val">${sat.dem_slope_deg != null ? sat.dem_slope_deg + '°' : '—'}</div>
        </div>
        <div class="sat-cell">
          <div class="sat-lbl">Orbit</div>
          <div class="sat-val" style="text-transform:capitalize">${sat.orbit_direction ?? '—'}</div>
        </div>
        <div class="sat-cell sat-cell-full">
          <div class="sat-lbl">Last Pass</div>
          <div class="sat-pass">${sat.last_pass_utc ? fmtPassDate(sat.last_pass_utc) : '—'}</div>
        </div>
      </div>
    </div>

    ${sp.elevation_m != null ? `
    <div class="dp-section">
      <div class="dp-section-label">Geology &amp; Site</div>
      <div class="coord-grid">
        <div class="coord-item"><div class="coord-lbl">Elevation</div><div class="coord-val">${sp.elevation_m} m</div></div>
        <div class="coord-item"><div class="coord-lbl">Aquifer Depth</div><div class="coord-val">${sp.aquifer_depth_m} m</div></div>
        <div class="coord-item"><div class="coord-lbl">Drainage Basin</div><div class="coord-val">${sp.drainage_basin}</div></div>
        <div class="coord-item"><div class="coord-lbl">Catchment</div><div class="coord-val">${sp.catchment_area_km2} km²</div></div>
      </div>
      ${sp.geology_type ? `<div class="geology-badge">${GEOLOGY_LABEL[sp.geology_type] ?? sp.geology_type}</div>` : ''}
    </div>` : ''}

    <div class="dp-section">
      <div class="dp-section-label">Cost Breakdown</div>
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

    <div class="coord-grid">
      <div class="coord-item"><div class="coord-lbl">Latitude</div><div class="coord-val">${sp.lat.toFixed(4)}° N</div></div>
      <div class="coord-item"><div class="coord-lbl">Longitude</div><div class="coord-val">${sp.lon.toFixed(4)}° E</div></div>
    </div>

    <div class="btn-row">
      <button class="btn btn-primary" onclick="generateReport('${sp.name.replace(/'/g,"\\'")}')">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
        Generate Report
      </button>
      <button class="btn btn-secondary" onclick="flagReview('${sp.id}','${sp.name.replace(/'/g,"\\'")}')">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z"/></svg>
        Flag Review
      </button>
    </div>
  `;
}

/* ── ANALYSIS SECTION ────────────────────────────── */
function renderAnalysis(springs, villages) {
  const maxRes = Math.max(...springs.map(s => s.reserve));
  const sorted = [...springs].sort((a, b) => b.reserve - a.reserve);

  document.getElementById('reserve-chart').innerHTML = sorted.map(sp => {
    const w = (sp.reserve / maxRes * 100).toFixed(1);
    const c = STATUS_COLOR[sp.status];
    return `
      <div class="bar-row">
        <div class="bar-label">${sp.name}<span class="bar-region"> ${sp.region}</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${w}%;background:${c}"></div></div>
        <div class="bar-val">${sp.reserve}</div>
      </div>`;
  }).join('');

  const vProps = villages.map(f => f.properties);
  document.getElementById('village-coverage').innerHTML = vProps.map(v => {
    const col = ACCESS_COLOR[v.access_status] ?? '#b45309';
    return `
      <div class="vc-row">
        <div class="vc-dot" style="background:${col}"></div>
        <div class="vc-info">
          <div class="vc-name">${v.village_name} <span class="vc-county">${v.county}</span></div>
          <div class="vc-status" style="color:${col}">${v.access_status}</div>
        </div>
        <div class="vc-meta">
          <div class="vc-pop">${v.population.toLocaleString()} res.</div>
          <div class="vc-need">${v.water_need_m3_day} m³/day</div>
        </div>
        <div class="vc-link"><span class="sbadge sbadge-linked">${v.linked_spring_id}</span></div>
      </div>`;
  }).join('');
}

/* ── SELECT ──────────────────────────────────────── */
function selectSpring(sp) { renderDetail(sp); highlightRow(sp.id); }

/* ── TABLE ───────────────────────────────────────── */
function renderTable(springs) {
  const tbody = document.getElementById('springs-tbody');
  if (springs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="no-results"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>No springs match your search</td></tr>`;
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
  selectSpring(sp);
  markerRefs[id]?.openPopup();
  leafletMap.setView([sp.lat, sp.lon], 11, { animate: true });
}
function viewSpring(id) { handleRowClick(id); }

function highlightRow(id) {
  document.querySelectorAll('.dtbl tbody tr').forEach(r => r.classList.remove('active-row'));
  const row = document.getElementById(`row-${id}`);
  if (row) { row.classList.add('active-row'); row.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
}

/* ── ACTIONS ─────────────────────────────────────── */
function generateReport(name) { alert(`Generating PDF report for ${name}...\nThis feature is available in the full version.`); }
function flagReview(id, name) { alert(`${name} (${id}) flagged for review.\nThe field team will be notified within 24 hours.`); }

/* ── MAP EXPAND TOGGLE ───────────────────────────── */
function toggleMapExpand() {
  const layout  = document.querySelector('.split-layout');
  const icon    = document.getElementById('map-expand-icon');
  const expanded = layout.classList.toggle('map-expanded');

  icon.innerHTML = expanded
    ? `<path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3"/>`
    : `<path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/>`;

  setTimeout(() => leafletMap.invalidateSize(), 360);
}

/* ── INIT ────────────────────────────────────────── */
async function init() {
  initMap();
  renderDetailPlaceholder();

  _allSprings = await loadSprings();

  if (_allSprings.length === 0) {
    document.getElementById('detail-panel').innerHTML =
      `<p style="color:#dc2626;padding:16px;font-size:.82rem">Failed to load data. Serve via <code>npx serve .</code></p>`;
    return;
  }

  const villages = getVillageZones();

  addConnectionLines(_allSprings, villages);
  addMarkers(_allSprings);
  addVillageZones(villages);
  renderTable(_allSprings);
  renderAnalysis(_allSprings, villages);
  selectSpring(_allSprings[0]);
  highlightRow(_allSprings[0].id);
  initLocationSearch();

  const input = document.getElementById('search-input');
  const clearBtn = document.getElementById('search-clear');
  input.addEventListener('input', () => {
    clearBtn.style.display = input.value ? 'flex' : 'none';
    updateSearch(input.value);
  });
  clearBtn.addEventListener('click', () => {
    input.value = ''; clearBtn.style.display = 'none'; input.focus(); updateSearch('');
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { input.value = ''; clearBtn.style.display = 'none'; updateSearch(''); input.blur(); }
  });
}

init();
