'use strict';
// Dashboard + scheduler. Start with: npm start
// Open: http://localhost:3000/?token=ADMIN_TOKEN
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { config, validate, getSettings, updateSettings, overridesActive } = require('./config');
const shopify = require('./shopify');
const pickup = require('./pickup');
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
let scheduleTimer = null;
function scheduleNext() {
  if (scheduleTimer) clearTimeout(scheduleTimer);
  const ms = config.sync.intervalMinutes * 60000;
  nextScheduledAt = new Date(Date.now() + ms).toISOString();
  scheduleTimer = setTimeout(async () => {
    if (!config.sync.autoSync) logger.skip('scheduled_run_skipped', { reason: 'AUTO_SYNC is off' });
    else await runSync({ mode: 'scheduled', trigger: 'schedule' }).catch((e) => logger.error('scheduled_run_crash', { error: e.message }));
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
  if (config.sync.autoSync && hhmm >= config.sync.reconciliationTime && state.lastReconciliationDate !== date && !isRunning()) {
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
function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 5e6) req.destroy(); else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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

  // Shopify webhook: orders/create -> pickup re-check. Verified by HMAC, not by ADMIN_TOKEN.
  if (req.method === 'POST' && url.pathname === '/webhooks/orders-create') {
    const raw = await readRaw(req).catch(() => Buffer.alloc(0));
    if (!pickup.verifyWebhook(raw, req.headers['x-shopify-hmac-sha256'])) {
      logger.warn('webhook_rejected', { reason: config.shopify.webhookSecret ? 'bad signature' : 'SHOPIFY_WEBHOOK_SECRET not set' });
      return send(res, 401, { error: 'invalid signature' });
    }
    send(res, 200, { ok: true }); // answer Shopify fast, work afterwards
    if (!config.pickupRecheck) return;
    let id = null;
    try { id = JSON.parse(raw.toString('utf8')).admin_graphql_api_id; } catch {}
    if (id) pickup.recheckOrder(id, { trigger: 'webhook' }).catch((e) => logger.error('pickup_recheck_failed', { orderId: id, error: e.message }));
    return;
  }

  if (!authed(req, url)) {
    if (url.pathname === '/') return send(res, 401, '<h3>Unauthorized. Open /?token=YOUR_ADMIN_TOKEN</h3>', 'text/html');
    return send(res, 401, { error: 'unauthorized' });
  }
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, dashboardHtml(), 'text/html');

    if (req.method === 'GET' && url.pathname === '/api/settings') {
      return send(res, 200, { settings: getSettings(), running: !!isRunning() });
    }

    if (req.method === 'POST' && url.pathname === '/api/settings') {
      if (isRunning()) return send(res, 409, { error: 'A sync is running. Please save again in a minute.' });
      const body = await readBody(req);
      let changes;
      try {
        changes = updateSettings(body.values || {}, Array.isArray(body.reset) ? body.reset : []);
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
      if (Object.keys(changes).length) {
        shopify.resetCaches();
        if (changes.SYNC_INTERVAL_MINUTES) scheduleNext();
        logger.info('settings_changed', { by: 'dashboard', changes });
      }
      return send(res, 200, { ok: true, changes, settings: getSettings() });
    }

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
          deliveryOnlyAction: config.deliveryOnlyAction, statusMetafields: config.statusMetafields, autoSync: config.sync.autoSync,
          overrides: overridesActive(), pickupRecheck: config.pickupRecheck, webhookSecretSet: !!config.shopify.webhookSecret,
          alertEmail: !!(config.alerts.emailTo.length && config.alerts.smtp.host),
        },
        autoline: { lastSuccessAt: state.autolineLastSuccessAt, downSince: state.autolineDownSince, outageAlertSent: state.outageAlertSent },
        lastRun: state.lastRun,
        lastReconciliation: state.lastReconciliation,
        draftedByApp: state.draftedByApp,
        listError,
        lastReport: state.lastReport ? { at: state.lastReport.at, mode: state.lastReport.mode, counts: state.lastReport.counts } : null,
        reports: listReports().slice(0, 30),
        pickupChecks: pickup.recentChecks(100),
        parts: list.map((p) => ({ ...p, ...(state.parts[p.sku] || {}) })),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/logs') {
      const date = url.searchParams.get('date');
      const limit = Math.min(Number(url.searchParams.get('limit')) || 300, 5000);
      const level = url.searchParams.get('level');
      if (level) {
        const all = date ? readLogFile(date, 1e6) : logger.recent(1e6);
        return send(res, 200, { dates: listLogDates(), entries: all.filter((e) => e.level === level).slice(0, limit) });
      }
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
      return res.end('\uFEFF' + csv);
    }

    if (req.method === 'POST' && url.pathname === '/api/pickup-recheck') {
      const body = await readBody(req);
      const name = String(body.order || '').trim();
      if (!name) return send(res, 400, { error: 'order number missing' });
      const id = name.startsWith('gid://') ? name : await shopify.findOrderIdByName(name);
      if (!id) return send(res, 404, { error: `Order ${name} not found` });
      const r = await pickup.recheckOrder(id, { trigger: 'dashboard', force: true });
      return send(res, 200, r);
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
  if (overridesActive().length) logger.info('settings_overrides_active', { keys: overridesActive(), note: 'set from dashboard (settings.json), these win over .env' });
  cleanupOldLogs();
  setTimeout(() => {
    if (!config.sync.autoSync) return logger.skip('startup_run_skipped', { reason: 'AUTO_SYNC is off' });
    runSync({ mode: 'scheduled', trigger: 'startup' }).catch(() => {});
  }, 5000);
  scheduleNext();
});

// ---------- Dashboard page (src/dashboard.html) ----------
const DASHBOARD_FILE = path.join(__dirname, 'dashboard.html');
let dashCache = null;
function dashboardHtml() {
  if (!dashCache || process.env.NODE_ENV !== 'production') dashCache = fs.readFileSync(DASHBOARD_FILE, 'utf8');
  return dashCache;
}
