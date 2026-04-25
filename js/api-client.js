/**
 * api-client.js
 * Thin wrapper around the H2Oolkit backend (`backend/server.py`).
 *
 * The backend is an optional companion service.  When it is unreachable
 * the frontend continues to work from the static JSON files — only the
 * "live analysis" and "generate PDF" features become unavailable.
 */

const H2O_API = (() => {
  // Same host the page was served from, but always on port 5000.
  // Override by setting `window.H2O_API_BASE` before this script loads.
  if (window.H2O_API_BASE) return window.H2O_API_BASE.replace(/\/$/, '');
  const host = window.location.hostname || 'localhost';
  return `http://${host}:5000`;
})();

let _backendOnline = null;   // null = unchecked, true/false = checked

async function checkBackend() {
  if (_backendOnline !== null) return _backendOnline;
  try {
    const r = await fetch(`${H2O_API}/api/health`, { method: 'GET' });
    _backendOnline = r.ok;
  } catch (_) {
    _backendOnline = false;
  }
  return _backendOnline;
}

async function apiAnalyzeSpring(springId) {
  const r = await fetch(`${H2O_API}/api/springs/${encodeURIComponent(springId)}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!r.ok) throw new Error(`analyze failed: HTTP ${r.status}`);
  return r.json();
}

async function apiAnalyzeVillage(payload) {
  const r = await fetch(`${H2O_API}/api/analyze/village`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`village analysis failed: HTTP ${r.status}`);
  return r.json();
}

function apiReportUrl(springId) {
  return `${H2O_API}/api/springs/${encodeURIComponent(springId)}/report`;
}

async function apiDownloadReport(springId, fileName) {
  const r = await fetch(apiReportUrl(springId));
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).message || msg; } catch (_) {}
    throw new Error(msg);
  }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || `H2Oolkit_${springId}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

window.H2O = {
  base: H2O_API,
  checkBackend,
  analyzeSpring: apiAnalyzeSpring,
  analyzeVillage: apiAnalyzeVillage,
  downloadReport: apiDownloadReport,
  reportUrl: apiReportUrl,
};
