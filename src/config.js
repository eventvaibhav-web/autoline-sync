'use strict';
// Loads .env (no external packages) and exposes validated config.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function loadEnvFile() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return false;
  const text = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return true;
}
const envLoaded = loadEnvFile();

const env = (k, d = '') => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const num = (k, d) => {
  const n = Number(env(k, d));
  return Number.isFinite(n) ? n : d;
};
const bool = (k, d = false) => {
  const v = String(env(k, d)).trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
};

function parseJsonEnv(k) {
  const raw = env(k, '');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${k} must be valid JSON, e.g. {"x-api-key":"abc"}`);
  }
}

function parseMap(raw) {
  const out = [];
  for (const part of String(raw).split(/[,;]/)) {
    const m = part.trim().match(/^([^=\s]+)\s*=\s*(gid:\/\/shopify\/Location\/\d+)$/);
    if (part.trim() && !m) throw new Error(`LOCATION_STOCK_MAP entry is wrong: "${part.trim()}" (use ROOFTOP=gid://shopify/Location/123)`);
    if (m) out.push({ rooftopId: m[1], locationId: m[2] });
  }
  return out;
}

// DATA_DIR: where logs/ and state.json live (on Render: the persistent disk, e.g. /var/data)
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || '.');

const config = {
  root: ROOT,
  dataDir: DATA_DIR,
  envLoaded,
  autoline: {
    baseUrl: env('AUTOLINE_BASE_URL', 'https://ykacentralapi.almoayyed.com.bh/prod/api/v1').replace(/\/+$/, ''),
    sessionId: num('AUTOLINE_SESSION_ID', 12345),
    rooftopId: env('AUTOLINE_ROOFTOP_ID', 'SO01P_PH'),
    userId: env('AUTOLINE_USER_ID', 'ADMIN-YK'),
    extraHeaders: parseJsonEnv('AUTOLINE_EXTRA_HEADERS'),
    timeoutMs: num('AUTOLINE_TIMEOUT_MS', 20000),
  },
  stockSource: env('STOCK_SOURCE', 'total').toLowerCase(),
  descriptionSync: bool('DESCRIPTION_SYNC_ENABLED', false),
  // price1 = selling price is Price1 only (compare-at not touched)
  // price1_special = specialPrice > 0 -> price=specialPrice, compare-at=price1
  priceMode: env('PRICE_MODE', 'price1').toLowerCase(),
  // "ROOFTOP=gid://shopify/Location/ID, ROOFTOP=..."  (which Autoline rooftop fills which Shopify location)
  locationStockMap: parseMap(env('LOCATION_STOCK_MAP', '')),
  // Rooftops that are pickup outlets; delivery-only parts get 0 stock there
  outletRooftops: env('OUTLET_ROOFTOPS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  deliveryOnlyTag: env('DELIVERY_ONLY_TAG', 'delivery-only').trim().toLowerCase(),
  shopify: {
    store: env('SHOPIFY_STORE', '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    token: env('SHOPIFY_ADMIN_TOKEN', ''),
    clientId: env('SHOPIFY_CLIENT_ID', ''),
    clientSecret: env('SHOPIFY_CLIENT_SECRET', ''),
    apiVersion: env('SHOPIFY_API_VERSION', '2025-07'),
    locationId: env('SHOPIFY_LOCATION_ID', ''),
  },
  sync: {
    intervalMinutes: num('SYNC_INTERVAL_MINUTES', 15),
    reconciliationTime: env('RECONCILIATION_TIME', '02:00'),
    timezone: env('TIMEZONE', 'Asia/Bahrain'),
    concurrency: Math.max(1, num('CONCURRENCY', 3)),
    dryRun: bool('DRY_RUN', false),
    partsListFile: path.resolve(ROOT, env('PARTS_LIST_FILE', 'parts-list.csv')),
  },
  alerts: {
    outageMinutes: num('OUTAGE_ALERT_MINUTES', 60),
    webhookUrl: env('ALERT_WEBHOOK_URL', ''),
    cooldownMinutes: num('ALERT_COOLDOWN_MINUTES', 60),
  },
  logs: {
    dir: path.join(DATA_DIR, 'logs'),
    retentionDays: num('LOG_RETENTION_DAYS', 365),
  },
  stateFile: path.join(DATA_DIR, 'state.json'),
  server: {
    port: num('PORT', 3000),
    // On Render (RENDER env is set) the app must listen on 0.0.0.0
    host: env('HOST', process.env.RENDER ? '0.0.0.0' : '127.0.0.1'),
    adminToken: env('ADMIN_TOKEN', ''),
  },
};

function validate({ needShopify = true, needServer = false } = {}) {
  const errs = [];
  // .env file is optional when settings come from real environment variables (Render, systemd, etc.)
  if (!envLoaded && !process.env.SHOPIFY_STORE) errs.push('.env file not found. Copy .env.example to .env and fill it in.');
  if (!['total', 'prime1', 'prime1-3'].includes(config.stockSource))
    errs.push('STOCK_SOURCE must be one of: total, prime1, prime1-3');
  if (!['price1', 'price1_special'].includes(config.priceMode)) errs.push('PRICE_MODE must be price1 or price1_special');
  const locIds = config.locationStockMap.map((x) => x.locationId);
  if (new Set(locIds).size !== locIds.length) errs.push('LOCATION_STOCK_MAP: one Shopify location is used twice');
  const mapped = config.locationStockMap.map((x) => x.rooftopId);
  for (const o of config.outletRooftops)
    if (!mapped.includes(o)) errs.push(`OUTLET_ROOFTOPS has ${o}, but it is not in LOCATION_STOCK_MAP`);
  if (!config.autoline.rooftopId) errs.push('AUTOLINE_ROOFTOP_ID is empty');
  if (needShopify) {
    if (!/\.myshopify\.com$/.test(config.shopify.store)) errs.push('SHOPIFY_STORE must look like xxx.myshopify.com');
    const s = config.shopify;
    const hasClient = s.clientId && s.clientSecret && !s.clientId.includes('xxxx');
    const hasToken = s.token && !s.token.includes('xxxx');
    if (s.clientId && !s.clientSecret) errs.push('SHOPIFY_CLIENT_SECRET is empty (needed with SHOPIFY_CLIENT_ID)');
    else if (!hasClient && !hasToken)
      errs.push('Set SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (Dev Dashboard app) or SHOPIFY_ADMIN_TOKEN (old legacy app)');
    if (s.clientId && s.clientId.includes('xxxx')) s.clientId = '';
  }
  if (needServer) {
    if (!config.server.adminToken || config.server.adminToken.startsWith('change-me') || config.server.adminToken.length < 12)
      errs.push('ADMIN_TOKEN must be a long random string (min 12 chars), not the example value');
  }
  if (errs.length) {
    const e = new Error('Config problems:\n - ' + errs.join('\n - '));
    e.configErrors = errs;
    throw e;
  }
}

module.exports = { config, validate };
