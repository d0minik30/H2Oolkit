/* app.js — H2Oolkit main application logic */

const MAX_RESERVE = 700;

const STATUS_LABEL = {
  verified:      'Verified',
  high_priority: 'High Priority',
  pending:       'Pending Review'
};

const STATUS_COLOR = {
  verified:      '#3b82f6',
  high_priority: '#ef4444',
  pending:       '#f59e0b'
};

const GEOLOGY_LABEL = {
  limestone_karst:    'Limestone Karst',
  alluvial_gravel:    'Alluvial Gravel',
  crystalline_schist: 'Crystalline Schist',
  volcanic_tuff:      'Volcanic Tuff',
  flysch_sandstone:   'Flysch Sandstone',
  granite_gneiss:     'Granite Gneiss'
};

function fmtCost(n) {
  return '€' + n.toLocaleString('de-DE');
}

function confColor(c) {
  if (c >= 90) return '#10b981';
  if (c >= 80) return '#3b82f6';
  if (c >= 70) return '#f59e0b';
  return '#ef4444';
}

function breakdown(total) {
  const pipeline  = Math.round(total * 0.668);
  const pump      = Math.round(total * 0.197);
  const treatment = total - pipeline - pump;
  return { pipeline, pump, treatment };
}

function fmtPassDate(utc) {
  const d = new Date(utc);
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/* ── MAP ─────────────────────────────────────────── */
let leafletMap;
const markerRefs = {};

function initMap() {
  leafletMap = L.map('map', { center: [45.9, 26.1], zoom: 8, zoomControl: true });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19
  }).addTo(leafletMap);

  const legend = L.control({ position: 'bottomleft' });
  legend.onAdd = () => {
    const d = L.DomUtil.create('div', 'map-legend');
    d.innerHTML = `
      <div class="legend-title">Spring Status</div>
      <div class="legend-item"><div class="legend-dot" style="background:#3b82f6"></div>Verified</div>
      <div class="legend-item"><div class="legend-dot" style="background:#ef4444"></div>High Priority</div>
      <div class="legend-item"><div class="legend-dot" style="background:#f59e0b"></div>Pending Review</div>`;
    return d;
  };
  legend.addTo(leafletMap);
}

function addMarkers(springs) {
  springs.forEach(sp => {
    const c          = STATUS_COLOR[sp.status];
    const isPriority = sp.status === 'high_priority';

    const pulse = isPriority
      ? `<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:18px;height:18px;border-radius:50%;background:${c};animation:pulse-ring 1.6s ease-out infinite;"></div>`
      : '';

    const html = `
      <div style="position:relative;width:22px;height:22px;">
        ${pulse}
        <div style="
          position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
          width:16px;height:16px;
          background:${c};
          border:2.5px solid rgba(255,255,255,.85);
          border-radius:50%;
          box-shadow:0 0 0 3px ${c}40, 0 3px 10px rgba(0,0,0,.5);
          cursor:pointer;
        "></div>
      </div>`;

    const icon = L.divIcon({
      html, className: '', iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -14]
    });

    const popup = `
      <div class="popup-title">${sp.name} — ${sp.region}</div>
      <div class="popup-row"><span class="popup-k">Water Reserve</span><span class="popup-v">${sp.reserve} m³/day</span></div>
      <div class="popup-row"><span class="popup-k">Confidence</span><span class="popup-v">${sp.confidence}% (Sentinel-1 SAR)</span></div>
      <div class="popup-row"><span class="popup-k">Distance to Village</span><span class="popup-v">${sp.distance_km} km</span></div>
      <div class="popup-row"><span class="popup-k">Pipeline Cost Est.</span><span class="popup-v">${fmtCost(sp.cost_eur)}</span></div>
      ${sp.nearest_village ? `<div class="popup-row"><span class="popup-k">Nearest Village</span><span class="popup-v">${sp.nearest_village}</span></div>` : ''}
      <div class="popup-badge"><span class="sbadge sbadge-${sp.status}">${STATUS_LABEL[sp.status]}</span></div>`;

    const marker = L.marker([sp.lat, sp.lon], { icon })
      .addTo(leafletMap)
      .bindPopup(popup);

    marker.on('click', () => selectSpring(sp));
    markerRefs[sp.id] = marker;
  });
}

/* ── DETAIL PANEL ────────────────────────────────── */
function renderDetailPlaceholder() {
  document.getElementById('detail-panel').innerHTML = `
    <div class="dp-placeholder">
      <div class="dp-ph-line" style="width:60%;height:18px;margin-bottom:8px"></div>
      <div class="dp-ph-line" style="width:40%;height:12px;margin-bottom:24px"></div>
      <div class="dp-ph-line" style="width:100%;height:80px;margin-bottom:16px"></div>
      <div class="dp-ph-line" style="width:100%;height:40px;margin-bottom:16px"></div>
      <div class="dp-ph-line" style="width:100%;height:60px"></div>
    </div>`;
}

function renderDetailEmpty() {
  document.getElementById('detail-panel').innerHTML = `
    <div class="dp-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M12 2C6.48 2 2 8.5 2 13a10 10 0 0020 0c0-4.5-4.48-11-10-11z" stroke-linecap="round"/>
      </svg>
      <p>Select a spring from the map<br>or the table below</p>
    </div>`;
}

function renderDetail(sp) {
  const bd  = breakdown(sp.cost_eur);
  const pct = (sp.reserve / MAX_RESERVE * 100).toFixed(1);
  const cc  = confColor(sp.confidence);
  const sat = sp.satellite ?? {};
  const geo = {
    elevation_m:        sp.elevation_m,
    geology_type:       sp.geology_type,
    drainage_basin:     sp.drainage_basin,
    catchment_area_km2: sp.catchment_area_km2,
    nearest_village:    sp.nearest_village,
    aquifer_depth_m:    sp.aquifer_depth_m
  };

  const sarPct   = sat.sentinel1_sar_anomaly != null ? (sat.sentinel1_sar_anomaly * 100).toFixed(0) : '—';
  const ndwiPct  = sat.sentinel2_ndwi        != null ? (sat.sentinel2_ndwi        * 100).toFixed(0) : '—';
  const sarColor = sat.sentinel1_sar_anomaly >= 0.8 ? '#10b981' : sat.sentinel1_sar_anomaly >= 0.6 ? '#3b82f6' : '#f59e0b';

  document.getElementById('detail-panel').innerHTML = `
    <div class="dp-header">
      <div>
        <div class="dp-title">${sp.name}</div>
        <div class="dp-sub">${sp.region} County &middot; ${sp.id}${geo.nearest_village ? ' &middot; ' + geo.nearest_village : ''}</div>
      </div>
      <span class="sbadge sbadge-${sp.status}">${STATUS_LABEL[sp.status]}</span>
    </div>

    <div class="dp-section">
      <div class="dp-section-label">Water Reserve Capacity</div>
      <div class="gauge-box">
        <div class="gauge-top">
          <span class="gauge-val">${sp.reserve} m³/day</span>
          <span class="gauge-cap">Max: ${MAX_RESERVE} m³/day</span>
        </div>
        <div class="gauge-track">
          <div class="gauge-fill" style="width:${pct}%"></div>
        </div>
        <div class="gauge-hint">${pct}% of regional capacity threshold</div>
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
          <div class="sat-lbl">SAR Moisture Anomaly</div>
          <div class="sat-val" style="color:${sarColor}">${sarPct}%</div>
          <div class="gauge-track" style="margin-top:5px">
            <div class="gauge-fill" style="width:${sarPct}%;background:${sarColor}"></div>
          </div>
        </div>
        <div class="sat-cell">
          <div class="sat-lbl">NDWI Index (S2)</div>
          <div class="sat-val" style="color:#60a5fa">${sat.sentinel2_ndwi != null ? sat.sentinel2_ndwi.toFixed(2) : '—'}</div>
          <div class="gauge-track" style="margin-top:5px">
            <div class="gauge-fill" style="width:${ndwiPct}%;background:#3b82f6"></div>
          </div>
        </div>
        <div class="sat-cell">
          <div class="sat-lbl">DEM Slope</div>
          <div class="sat-val">${sat.dem_slope_deg != null ? sat.dem_slope_deg + '°' : '—'}</div>
        </div>
        <div class="sat-cell">
          <div class="sat-lbl">Orbit Direction</div>
          <div class="sat-val" style="text-transform:capitalize">${sat.orbit_direction ?? '—'}</div>
        </div>
        <div class="sat-cell sat-cell-full">
          <div class="sat-lbl">Last Satellite Pass</div>
          <div class="sat-val sat-pass">${sat.last_pass_utc ? fmtPassDate(sat.last_pass_utc) : '—'}</div>
        </div>
      </div>
    </div>

    ${geo.elevation_m != null ? `
    <div class="dp-section">
      <div class="dp-section-label">Geology & Site</div>
      <div class="geo-grid">
        <div class="coord-item">
          <div class="coord-lbl">Elevation</div>
          <div class="coord-val">${geo.elevation_m} m</div>
        </div>
        <div class="coord-item">
          <div class="coord-lbl">Aquifer Depth</div>
          <div class="coord-val">${geo.aquifer_depth_m} m</div>
        </div>
        <div class="coord-item">
          <div class="coord-lbl">Drainage Basin</div>
          <div class="coord-val">${geo.drainage_basin}</div>
        </div>
        <div class="coord-item">
          <div class="coord-lbl">Catchment Area</div>
          <div class="coord-val">${geo.catchment_area_km2} km²</div>
        </div>
      </div>
      ${geo.geology_type ? `<div class="geology-badge">${GEOLOGY_LABEL[geo.geology_type] ?? geo.geology_type}</div>` : ''}
    </div>
    ` : ''}

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
      <div class="dp-section-label">EU Funding Eligibility</div>
      <div class="eu-badge">&#10003; Eligible — POIM 2021–2027</div>
    </div>

    <div class="coord-grid">
      <div class="coord-item">
        <div class="coord-lbl">Latitude</div>
        <div class="coord-val">${sp.lat.toFixed(4)}° N</div>
      </div>
      <div class="coord-item">
        <div class="coord-lbl">Longitude</div>
        <div class="coord-val">${sp.lon.toFixed(4)}° E</div>
      </div>
    </div>

    <div class="btn-row">
      <button class="btn btn-primary" onclick="generateReport('${sp.name.replace(/'/g, "\\'")}')">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
        Generate Report
      </button>
      <button class="btn btn-secondary" onclick="flagReview('${sp.id}','${sp.name.replace(/'/g, "\\'")}')">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z"/></svg>
        Flag Review
      </button>
    </div>
  `;
}

/* ── SELECT ──────────────────────────────────────── */
function selectSpring(sp) {
  renderDetail(sp);
  highlightRow(sp.id);
}

/* ── TABLE ───────────────────────────────────────── */
function renderTable(springs) {
  document.getElementById('springs-tbody').innerHTML = springs.map(sp => `
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
    </tr>
  `).join('');

  document.querySelector('.table-count').textContent = `${springs.length} sources`;
}

function handleRowClick(id) {
  const sp = getSpringById(id);
  if (!sp) return;
  selectSpring(sp);
  markerRefs[id].openPopup();
  leafletMap.setView([sp.lat, sp.lon], 10, { animate: true });
}

function viewSpring(id) {
  handleRowClick(id);
}

function highlightRow(id) {
  document.querySelectorAll('.dtbl tbody tr').forEach(r => r.classList.remove('active-row'));
  const row = document.getElementById(`row-${id}`);
  if (row) {
    row.classList.add('active-row');
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

/* ── ACTIONS ─────────────────────────────────────── */
function generateReport(name) {
  alert(`Generating PDF report for ${name}...\nThis feature is available in the full version.`);
}
function flagReview(id, name) {
  alert(`${name} (${id}) has been flagged for review.\nThe field team will be notified within 24 hours.`);
}

/* ── INIT ────────────────────────────────────────── */
async function init() {
  initMap();
  renderDetailPlaceholder();

  const springs = await loadSprings();

  if (springs.length === 0) {
    document.getElementById('detail-panel').innerHTML = `
      <div class="dp-empty" style="color:#ef4444">
        <p>Failed to load spring data.<br>
        <small>Make sure the app is served via HTTP:<br>
        <code>npx serve .</code></small></p>
      </div>`;
    return;
  }

  addMarkers(springs);
  renderTable(springs);
  selectSpring(springs[0]);
  highlightRow(springs[0].id);
}

init();
