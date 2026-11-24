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
const acpairs = require('./acpairs');
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

// Pickup order polling (no public URL needed). Independent of AUTO_SYNC: it only reads stock and tags/alerts short orders.
let lastPollRun = 0;
setInterval(() => {
  const m = config.pickupPollMinutes;
  if (!config.pickupRecheck || !m || m <= 0) return;
  if (Date.now() - lastPollRun < m * 60000 - 5000) return;
  lastPollRun = Date.now();
  pickup.pollNewOrders().catch((e) => logger.error('pickup_poll_failed', { error: e.message }));
}, 30000);

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
// ---------- Sign-in (see auth.js) ----------
const auth = require('./auth');
const loginOn = () => auth.enabled();
const clientIp = (req) => auth.clientIp(req);
// Who is asking: { user, role } for a signed-in user, { user: 'admin-token', role: 'admin' } for scripts with the header.
// A request that reached the Node process directly from the same machine (loopback), judged by the RAW socket
// address only - never x-forwarded-for, which a client can fake. Used to keep the admin-token header internal.
function isLocalRequest(req) {
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1';
}
function whoami(req, url) {
  const headerOk = safeEqual(req.headers['x-admin-token'], config.server.adminToken);
  if (loginOn()) {
    // Login is active: the admin-token header still works for local scripts/cron on the server, but never from
    // outside, so a leaked token cannot bypass login over the internet. The ?token= URL is ignored entirely.
    if (headerOk && isLocalRequest(req)) return { user: 'admin-token', role: 'admin' };
    return auth.currentUser(req);
  }
  // No dashboard users set up yet (first run / dev): the token is the only lock, via header or ?token=.
  if (headerOk) return { user: 'admin-token', role: 'admin' };
  return safeEqual(url.searchParams.get('token'), config.server.adminToken) ? { user: 'admin-token', role: 'admin' } : null;
}
function ipAllowed(req) {
  const list = config.server.allowedIps;
  return !list.length || list.includes(clientIp(req));
}
function redirect(res, to) {
  res.writeHead(303, { Location: to, 'Cache-Control': 'no-store' });
  res.end();
}
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
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

  if (!ipAllowed(req)) {
    logger.warn('access_blocked_ip', { ip: clientIp(req), path: url.pathname });
    return send(res, 403, url.pathname.startsWith('/api/') ? { error: 'forbidden' } : '<h3>Access denied</h3>', url.pathname.startsWith('/api/') ? 'application/json' : 'text/html');
  }

  if (loginOn() && (await auth.handlePages(req, res, url))) return;

  const me = whoami(req, url);
  if (!me) {
    if (loginOn() && req.method === 'GET' && !url.pathname.startsWith('/api/')) return redirect(res, '/login');
    if (url.pathname === '/') return send(res, 401, '<h3>Unauthorized. Open /?token=YOUR_ADMIN_TOKEN</h3>', 'text/html');
    return send(res, 401, { error: 'unauthorized' });
  }
  if (me.mustChange) {
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return redirect(res, '/change-password');
    return send(res, 403, { error: 'Set your own password first' });
  }
  // Viewers can look, not change anything
  if (req.method === 'POST' && me.role !== 'admin') return send(res, 403, { error: 'Your account is read-only. Ask an admin.' });
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, dashboardHtml(), 'text/html');

    if (req.method === 'GET' && url.pathname === '/api/users') {
      if (me.role !== 'admin') return send(res, 403, { error: 'Admins only' });
      return send(res, 200, { users: auth.listUsers(), otp: auth.otpOn(), smtp: auth.smtpReady() });
    }
    if (req.method === 'POST' && url.pathname === '/api/users') {
      const r = await auth.userAction(me.user === 'admin-token' ? null : me, await readBody(req), req);
      return send(res, r.error ? 400 : 200, r);
    }

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
        user: me.user === 'admin-token' ? null : me.user, role: me.role, loginOn: loginOn(),
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
          overrides: overridesActive(), pickupRecheck: config.pickupRecheck, webhookSecretSet: !!config.shopify.webhookSecret, pickupPollMinutes: config.pickupPollMinutes, pickupPoll: pickup.pollInfo(),
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

    if (req.method === 'GET' && url.pathname === '/api/ac-pairs') {
      const { source, savedAt, pairs } = acpairs.list();
      const state = loadState();
      const vat = Number(config.priceVatPercent) || 0;
      const norm = (s) => String(s || '').trim().toUpperCase();
      // Index synced AC products (snapshots that carry an indoor+outdoor bundle) by indoor part number.
      const byIndoor = {};
      for (const snap of Object.values(state.parts || {})) {
        if (snap && Array.isArray(snap.bundle) && snap.bundle.length >= 2) byIndoor[norm(snap.bundle[0].partNumber)] = snap;
      }
      const rows = pairs.map((p) => {
        const indoor = norm(p.indoor);
        const outdoor = norm(p.outdoor);
        const snap = byIndoor[indoor] || null;
        const row = {
          indoor, outdoor,
          indoorName: p.indoorName || p.name || null,
          outdoorName: p.outdoorName || null,
          sku: snap ? snap.sku : (p.sku || null),
          title: snap ? snap.title : null,
          indoorStock: null, outdoorStock: null, combinedStock: null,
          indoorPrice: null, outdoorPrice: null, installCharge: snap && snap.installationCharge ? snap.installationCharge : null,
          combinedPrice: null, status: 'not_synced', note: snap ? snap.note || '' : 'not synced yet',
        };
        if (snap) {
          const bi = snap.bundle.find((b) => norm(b.partNumber) === indoor);
          const bo = snap.bundle.find((b) => norm(b.partNumber) === outdoor);
          if (bi) { row.indoorStock = bi.totalStockQty; row.indoorPrice = bi.price1; }
          if (bo) { row.outdoorStock = bo.totalStockQty; row.outdoorPrice = bo.price1; }
          if (bi && bo) {
            row.combinedStock = Math.min(Number(bi.totalStockQty) || 0, Number(bo.totalStockQty) || 0);
            const sub = (Number(bi.price1) || 0) + (Number(bo.price1) || 0) + (Number(row.installCharge) || 0);
            row.combinedPrice = sub > 0 ? Number((sub * (1 + vat / 100)).toFixed(3)) : null;
            row.status = 'ok';
          } else {
            row.status = 'outdoor_missing';
          }
        }
        return row;
      });
      return send(res, 200, { configured: pairs.length, source, savedAt, vatPercent: vat, installPart: config.installationPart, rows });
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
