'use strict';
// Dashboard + scheduler. Start with: npm start
// Open: http://localhost:3000/?token=ADMIN_TOKEN
const http = require('http');
const crypto = require('crypto');
const { config, validate } = require('./config');
const { logger, readLogFile, listLogDates, cleanupOldLogs } = require('./logger');
const { runSync, isRunning, loadState, readPartsList, listReports, readReport } = require('./sync');

try {
  validate({ needShopify: true, needServer: true });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

// ---------- Scheduler ----------
function localParts(tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}

let nextScheduledAt = null;
function scheduleNext() {
  const ms = config.sync.intervalMinutes * 60000;
  nextScheduledAt = new Date(Date.now() + ms).toISOString();
  setTimeout(async () => {
    await runSync({ mode: 'scheduled', trigger: 'schedule' }).catch((e) => logger.error('scheduled_run_crash', { error: e.message }));
    scheduleNext();
  }, ms);
}

// Nightly reconciliation (checks every minute; runs once per local day at/after RECONCILIATION_TIME).
// On the very first start, mark today as done so it doesn't fire immediately (startup sync covers it).
{
  const st = loadState();
  if (!st.lastReconciliationDate) {
    st.lastReconciliationDate = localParts(config.sync.timezone).date;
    require('./sync').saveState(st);
  }
}
setInterval(async () => {
  const { date, hhmm } = localParts(config.sync.timezone);
  const state = loadState();
  if (hhmm >= config.sync.reconciliationTime && state.lastReconciliationDate !== date && !isRunning()) {
    const s = await runSync({ mode: 'reconciliation', trigger: 'nightly' }).catch((e) => ({ skipped: true, error: e.message }));
    if (!s.skipped) {
      const st = loadState();
      st.lastReconciliationDate = date;
      require('./sync').saveState(st);
    }
    cleanupOldLogs();
  }
}, 60000);

// ---------- HTTP ----------
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function authed(req, url) {
  return safeEqual(req.headers['x-admin-token'] || url.searchParams.get('token'), config.server.adminToken);
}
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') return send(res, 200, { ok: true });
  if (!authed(req, url)) {
    if (url.pathname === '/') return send(res, 401, '<h3>Unauthorized. Open /?token=YOUR_ADMIN_TOKEN</h3>', 'text/html');
    return send(res, 401, { error: 'unauthorized' });
  }
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, DASHBOARD_HTML, 'text/html');

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const state = loadState();
      let list = [];
      let listError = null;
      if (config.partsSource === 'tag') list = Object.values(state.parts).map((p) => ({ sku: p.sku, partNumber: p.partNumber }));
      else try { list = readPartsList(); } catch (e) { listError = e.message; }
      return send(res, 200, {
        now: new Date().toISOString(),
        running: isRunning(),
        nextScheduledAt,
        config: {
          store: config.shopify.store, rooftopId: config.autoline.rooftopId, stockSource: config.stockSource,
          intervalMinutes: config.sync.intervalMinutes, reconciliationTime: config.sync.reconciliationTime,
          timezone: config.sync.timezone, dryRun: config.sync.dryRun, descriptionSync: config.descriptionSync,
          priceMode: config.priceMode, locationStockMap: config.locationStockMap, outletRooftops: config.outletRooftops,
          partsSource: config.partsSource, syncTag: config.syncTag, blockSaleAction: config.blockSaleAction,
          deliveryOnlyAction: config.deliveryOnlyAction,
        },
        autoline: { lastSuccessAt: state.autolineLastSuccessAt, downSince: state.autolineDownSince, outageAlertSent: state.outageAlertSent },
        lastRun: state.lastRun,
        lastReconciliation: state.lastReconciliation,
        draftedByApp: state.draftedByApp,
        listError,
        lastReport: state.lastReport ? { at: state.lastReport.at, mode: state.lastReport.mode, counts: state.lastReport.counts } : null,
        reports: listReports().slice(0, 30),
        parts: list.map((p) => ({ ...p, ...(state.parts[p.sku] || {}) })),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/logs') {
      const date = url.searchParams.get('date');
      const limit = Math.min(Number(url.searchParams.get('limit')) || 300, 5000);
      return send(res, 200, { dates: listLogDates(), entries: date ? readLogFile(date, limit) : logger.recent(limit) });
    }

    if (req.method === 'GET' && url.pathname === '/api/report') {
      const name = url.searchParams.get('name') || '';
      if (name === 'last') {
        const st = loadState();
        return send(res, 200, st.lastReport || { rows: [] });
      }
      const csv = readReport(name);
      if (!csv) return send(res, 404, { error: 'report not found' });
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
      return res.end(csv);
    }

    if (req.method === 'POST' && url.pathname === '/api/sync') {
      if (isRunning()) return send(res, 409, { error: 'A sync is already running' });
      const body = await readBody(req);
      const sku = body.sku ? String(body.sku).trim() : null;
      runSync({ mode: 'manual', trigger: 'dashboard', onlySku: sku }).catch((e) => logger.error('manual_run_crash', { error: e.message }));
      return send(res, 202, { started: true, sku });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    logger.error('http_error', { path: url.pathname, error: e.message });
    return send(res, 500, { error: e.message });
  }
});

server.listen(config.server.port, config.server.host, () => {
  logger.info('server_started', {
    url: `http://${config.server.host === '0.0.0.0' ? 'localhost' : config.server.host}:${config.server.port}/?token=****`,
    intervalMinutes: config.sync.intervalMinutes, dryRun: config.sync.dryRun,
  });
  cleanupOldLogs();
  setTimeout(() => runSync({ mode: 'scheduled', trigger: 'startup' }).catch(() => {}), 5000);
  scheduleNext();
});

// ---------- Dashboard page ----------
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autoline → Shopify Sync</title>
<style>
 body{font-family:system-ui,Segoe UI,Arial,sans-serif;margin:0;background:#f5f6f8;color:#1d2129}
 header{background:#1f2937;color:#fff;padding:14px 22px;display:flex;justify-content:space-between;align-items:center}
 header h1{font-size:18px;margin:0}
 main{padding:18px 22px;max-width:1400px;margin:auto}
 .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-bottom:16px}
 .card{background:#fff;border-radius:8px;padding:12px 14px;box-shadow:0 1px 2px #0001}
 .card .k{font-size:12px;color:#6b7280}.card .v{font-size:18px;font-weight:600;margin-top:4px}
 .banner{padding:10px 14px;border-radius:6px;margin-bottom:12px;font-weight:500}
 .bad{background:#fee2e2;color:#991b1b}.warn{background:#fef3c7;color:#92400e}.ok{background:#dcfce7;color:#166534}
 table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;font-size:13px}
 th,td{padding:7px 9px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
 th{background:#f9fafb;font-weight:600}
 button{background:#2563eb;color:#fff;border:0;border-radius:6px;padding:7px 12px;cursor:pointer;font-size:13px}
 button.sm{padding:4px 8px;font-size:12px}button:disabled{background:#9ca3af;cursor:default}
 .pill{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
 .changed{background:#dbeafe;color:#1e40af}.unchanged{background:#f3f4f6;color:#374151}.skipped{background:#fef3c7;color:#92400e}.error{background:#fee2e2;color:#991b1b}
 .lv-change{color:#1e40af}.lv-warn,.lv-skip{color:#92400e}.lv-error,.lv-alert{color:#b91c1c;font-weight:600}
 h2{font-size:15px;margin:22px 0 8px}code{font-size:12px}
 .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
 select,input{padding:5px;border:1px solid #ccc;border-radius:6px}
</style></head><body>
<header><h1>Autoline → Shopify Sync</h1><div class="row"><span id="runningTxt"></span><button id="syncAll">Refresh all now</button></div></header>
<main>
<div id="banners"></div>
<div class="cards" id="cards"></div>
<h2>Parts (business list)</h2>
<table><thead><tr><th>Shopify SKU</th><th>Autoline part</th><th>Product</th><th>Autoline price</th><th>Stock per location (Shopify → target)</th><th>Last result</th><th>Changes / note</th><th>Last sync</th><th></th></tr></thead><tbody id="parts"></tbody></table>
<h2>Daily reports</h2>
<div id="reports" class="row" style="margin-bottom:8px"></div>
<h2>Logs</h2>
<div class="row" style="margin-bottom:8px"><label>Day: <select id="logDate"><option value="">Live (recent)</option></select></label>
<label>Filter: <select id="logLevel"><option value="">All</option><option>change</option><option>skip</option><option>warn</option><option>error</option><option>alert</option><option>info</option></select></label>
<input id="logSearch" placeholder="Search SKU / event"></div>
<table><thead><tr><th>Time</th><th>Level</th><th>Event</th><th>Details</th></tr></thead><tbody id="logs"></tbody></table>
</main>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const H = { 'x-admin-token': token, 'Content-Type': 'application/json' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const t = s => s ? new Date(s).toLocaleString() : '—';
async function api(p, opt={}) { const r = await fetch(p, { headers: H, ...opt }); return r.json(); }

async function refresh() {
  const s = await api('/api/status');
  const b = [];
  if (s.config.dryRun) b.push('<div class="banner warn">DRY RUN mode: nothing is written to Shopify (DRY_RUN=true in .env).</div>');
  if (s.autoline.downSince) b.push('<div class="banner bad">Autoline unreachable since ' + t(s.autoline.downSince) + '. Shopify values are being kept unchanged.</div>');
  if (s.listError) b.push('<div class="banner bad">' + esc(s.listError) + '</div>');
  if (s.lastRun && s.lastRun.errors) b.push('<div class="banner bad">Last run had ' + s.lastRun.errors + ' error(s). See logs below.</div>');
  document.getElementById('banners').innerHTML = b.join('');
  const lr = s.lastRun || {}, rc = s.lastReconciliation || {};
  const cards = [
    ['Store', s.config.store], ['Main RooftopId (price/status)', s.config.rooftopId], ['Stock source', s.config.stockSource],
    ['Price rule', s.config.priceMode === 'price1' ? 'Price1 only' : 'Price1 + specialPrice promo'],
    ['Stock locations', (s.config.locationStockMap || []).map(m => m.rooftopId + (s.config.outletRooftops.includes(m.rooftopId) ? ' (outlet)' : '')).join(', ') || 'single location'],
    ['Last run', t(lr.finishedAt)], ['Last run result', lr.total !== undefined ? (lr.changed + ' changed · ' + lr.unchanged + ' same · ' + lr.skipped + ' skipped · ' + lr.errors + ' errors') : '—'],
    ['Next scheduled', t(s.nextScheduledAt)], ['Last reconciliation', t(rc.finishedAt)],
    ['Autoline last OK', t(s.autoline.lastSuccessAt)], ['Drafted by app', Object.keys(s.draftedByApp || {}).length],
    ['Description sync', s.config.descriptionSync ? 'ON' : 'OFF'],
    ['Parts list from', s.config.partsSource === 'tag' ? 'Shopify tag ' + s.config.syncTag : 'parts-list.csv'],
    ['blockSale = Y', s.config.blockSaleAction === 'draft' ? 'Draft product' : 'Stock 0 + tag'],
    ['Last report', s.lastReport ? (Object.entries(s.lastReport.counts).map(([k,n]) => k+' '+n).join(' · ') || 'clean') : '—'],
  ];
  document.getElementById('cards').innerHTML = cards.map(([k,v]) => '<div class="card"><div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+'</div></div>').join('');
  document.getElementById('reports').innerHTML = (s.reports || []).map(r => '<a href="/api/report?name='+encodeURIComponent(r)+'&token='+encodeURIComponent(token)+'">'+esc(r)+'</a>').join(' · ') || '<small>No report yet (written by the nightly reconciliation)</small>';
  document.getElementById('runningTxt').textContent = s.running ? 'Sync running (' + s.running.mode + ')…' : '';
  document.getElementById('syncAll').disabled = !!s.running;
  document.getElementById('parts').innerHTML = s.parts.map(p => {
    const a = p.autoline || {};
    return '<tr><td><code>'+esc(p.sku)+'</code></td><td><code>'+esc(p.partNumber)+'</code></td><td>'+esc(p.title||'')+'</td>'+
      '<td>'+(p.autoline ? ('price1 '+a.price1+(a.specialPrice>0?' · special '+a.specialPrice:'')+(a.blockSale==='Y'?' · <b>blockSale</b>':'')) : '—')+'</td>'+
      '<td>'+((p.stocks||[]).map(x => esc(x.location)+': '+(x.shopify ?? '—')+' → '+(x.target ?? '—')+(x.note?' <small>('+esc(x.note)+')</small>':'')).join('<br>') || '—')+(p.deliveryOnly?'<br><b>delivery only</b>':'')+'</td>'+
      '<td>'+(p.result?'<span class="pill '+esc(p.result)+'">'+esc(p.result)+'</span>':'—')+'</td>'+
      '<td>'+esc((p.changes||[]).join(', '))+(p.note?'<br><small>'+esc(p.note)+'</small>':'')+'</td><td>'+t(p.at)+'</td>'+
      '<td><button class="sm" '+(s.running?'disabled':'')+' onclick="syncOne(\\''+esc(p.sku)+'\\')">Refresh</button></td></tr>';
  }).join('') || '<tr><td colspan="9">No parts in list</td></tr>';
}

async function loadLogs() {
  const d = document.getElementById('logDate').value;
  const r = await api('/api/logs?limit=500' + (d ? '&date=' + d : ''));
  const sel = document.getElementById('logDate');
  if (sel.options.length === 1) r.dates.forEach(x => sel.add(new Option(x, x)));
  const lv = document.getElementById('logLevel').value, q = document.getElementById('logSearch').value.toLowerCase();
  const rows = r.entries.filter(e => (!lv || e.level === lv) && (!q || JSON.stringify(e).toLowerCase().includes(q))).slice(0, 300);
  document.getElementById('logs').innerHTML = rows.map(e => { const { ts, level, event, ...rest } = e;
    return '<tr><td>'+t(ts)+'</td><td class="lv-'+esc(level)+'">'+esc(level)+'</td><td>'+esc(event)+'</td><td><code>'+esc(JSON.stringify(rest))+'</code></td></tr>'; }).join('');
}

async function syncAll() { const r = await api('/api/sync', { method: 'POST', body: '{}' }); if (r.error) alert(r.error); setTimeout(tick, 800); }
async function syncOne(sku) { const r = await api('/api/sync', { method: 'POST', body: JSON.stringify({ sku }) }); if (r.error) alert(r.error); setTimeout(tick, 800); }
document.getElementById('syncAll').onclick = syncAll;
['logDate','logLevel'].forEach(id => document.getElementById(id).onchange = loadLogs);
document.getElementById('logSearch').oninput = loadLogs;
async function tick() { try { await refresh(); await loadLogs(); } catch (e) { console.error(e); } }
tick(); setInterval(tick, 10000);
</script></body></html>`;
