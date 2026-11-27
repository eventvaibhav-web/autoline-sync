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

// SRC = .env / real environment, plus overrides saved from the dashboard (settings.json)
let SRC = process.env;
const env = (k, d = '') => (SRC[k] !== undefined && SRC[k] !== '' ? SRC[k] : d);
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

// "Nikai=NK, Comfee=CO, Toshiba=TA|TH" -> { nikai: ['NK'], comfee: ['CO'], toshiba: ['TA','TH'] }
function parseFranchiseMap(raw) {
  const out = {};
  for (const part of String(raw).split(',')) {
    const m = part.trim().match(/^(.+?)\s*=\s*([A-Za-z0-9|]+)$/);
    if (!part.trim()) continue;
    if (!m) throw new Error(`FRANCHISE_MAP entry is wrong: "${part.trim()}" (use Brand=CODE)`);
    out[normBrand(m[1])] = m[2].toUpperCase().split('|').filter(Boolean);
  }
  return out;
}
function normBrand(s) {
  // "Glem Gas" = "Glemgas", "White-Westinghouse" = "White Westinghouse", "NIKAI" = "Nikai"
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
// "SOE4P_PH=1,SOE3P_PH=1" -> { SOE4P_PH: 1, SOE3P_PH: 1 }
function parseNumMap(raw) {
  const out = {};
  for (const part of String(raw).split(',')) {
    if (!part.trim()) continue;
    const m = part.trim().match(/^([^=\s]+)\s*=\s*(\d+)$/);
    if (!m) throw new Error(`SAFETY_BUFFER entry is wrong: "${part.trim()}" (use ROOFTOP=number)`);
    out[m[1]] = Number(m[2]);
  }
  return out;
}

function build() {
  return {
  root: ROOT,
  dataDir: DATA_DIR,
  envLoaded,
  autoline: {
    baseUrl: env('AUTOLINE_BASE_URL', 'https://ykacentralapi.almoayyed.com.bh/prod/api/v1').replace(/\/+$/, ''),
    sessionId: num('AUTOLINE_SESSION_ID', 12345),
    rooftopId: env('AUTOLINE_ROOFTOP_ID', 'SO01P_PH'),
    // path between base URL and the endpoint name, e.g. "parts/shopify" -> .../parts/shopify/LoadPartsStockRecord
    partsPath: env('AUTOLINE_PARTS_PATH', 'parts/shopify').replace(/^\/+|\/+$/g, ''),
    userId: env('AUTOLINE_USER_ID', 'ADMIN-YK'),
    extraHeaders: parseJsonEnv('AUTOLINE_EXTRA_HEADERS'),
    timeoutMs: num('AUTOLINE_TIMEOUT_MS', 20000),
    // wait between retries (seconds); 3 retries = 1, 4, 16 (design doc)
    retryDelaysMs: env('AUTOLINE_RETRY_DELAYS', '1,4,16').split(',').map((x) => Number(x) * 1000).filter((x) => x >= 0),
  },
  stockSource: env('STOCK_SOURCE', 'total').toLowerCase(),
  // franchise = Autoline key is franchise code + SKU; sku = Shopify SKU already IS the Autoline part number (e.g. NKUHD65SLEDT)
  partKeyMode: env('PART_KEY_MODE', 'franchise').toLowerCase(),
  // false = do not write stock to outlet locations (Manama / Gudaibiya); pickup re-check still reads them
  outletStockSync: bool('OUTLET_STOCK_SYNC', true),
  // Write ehastock.online_qty metafield (= Online Store Location / C1 qty) so the theme can gate
  // checkout + pickup on online stock only. online_qty <= 0 => "Arriving Soon", no checkout.
  onlineQtyMetafield: bool('ONLINE_QTY_METAFIELD', true),
  // How AC / combined products are formed:
  //  pair     = ac-pairs.json auto-pairs indoor -> outdoor on the indoor product
  //  combined = separate combined product declares its parts via the autoline.part_number metafield ("A+B+C")
  //  both     = both methods active
  acMode: (env('AC_MODE', 'both').trim().toLowerCase() || 'both'),
  descriptionSync: bool('DESCRIPTION_SYNC_ENABLED', false),
  // price1 = selling price is Price1 only (compare-at not touched)
  // price1_special = specialPrice > 0 -> price=specialPrice, compare-at=price1
  priceMode: env('PRICE_MODE', 'price1').toLowerCase(),
  // VAT added to Autoline price1 (price1 is without VAT). 0 = write price1 as it is
  priceVatPercent: num('PRICE_VAT_PERCENT', 10),
  // true = if a product is not set up at a mapped location (e.g. Gudaibiya), the sync sets it up there
  stockAtAllLocations: bool('STOCK_AT_ALL_LOCATIONS', true),
  // Part missing in C1 but present in a showroom: set Shopify stock 0 everywhere ("Arriving Soon") and report it
  notInC1Zero: bool('NOT_IN_C1_ZERO', true),
  // Installation charge part in C1 (e.g. ZZCARR) added to the price of products with INSTALLATION_TAG
  installationPart: env('INSTALLATION_PART', 'ZZCARR').trim().toUpperCase(),
  installationTag: env('INSTALLATION_TAG', 'installation').trim().toLowerCase(),
  // "ROOFTOP=gid://shopify/Location/ID, ROOFTOP=..."  (which Autoline rooftop fills which Shopify location)
  locationStockMap: parseMap(env('LOCATION_STOCK_MAP', '')),
  // Rooftops that are pickup outlets; delivery-only parts get 0 stock there
  outletRooftops: env('OUTLET_ROOFTOPS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  deliveryOnlyTag: env('DELIVERY_ONLY_TAG', 'delivery-only').trim().toLowerCase(),
  // Product types that are delivery-only (comma separated, case-insensitive)
  deliveryOnlyTypes: env('DELIVERY_ONLY_PRODUCT_TYPES', '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  // zero = outlet stock 0 (default, reversible) | deactivate = remove outlet inventory (design doc)
  deliveryOnlyAction: env('DELIVERY_ONLY_ACTION', 'zero').toLowerCase(),
  // Which parts to sync: csv = parts-list.csv | tag = Shopify products with SYNC_TAG
  partsSource: env('PARTS_SOURCE', 'csv').toLowerCase(),
  syncTag: env('SYNC_TAG', 'autoline-sync').trim(),
  // Franchise key: Autoline part = franchise code + Shopify SKU
  franchiseMetaobjectType: env('FRANCHISE_METAOBJECT_TYPE', 'autoline_franchise').trim(),
  franchiseMap: parseFranchiseMap(env('FRANCHISE_MAP', '')),
  // blockSale = Y: zero = stock 0 everywhere + tag (design doc default) | draft = product to Draft
  blockSaleAction: env('BLOCK_SALE_ACTION', 'zero').toLowerCase(),
  blockedTag: env('BLOCKED_TAG', 'autoline-blocked').trim(),
  statusMetafields: bool('STATUS_METAFIELDS', true),
  // Pickup order re-check (orders/create webhook)
  pickupRecheck: bool('PICKUP_RECHECK', true),
  pickupAlertTag: env('PICKUP_ALERT_TAG', 'pickup-stock-alert').trim(),
  // Check Shopify for new pickup orders every N minutes (works without a public URL / webhook). 0 = off.
  pickupPollMinutes: num('PICKUP_POLL_MINUTES', 3),
  priceSwingPercent: num('PRICE_SWING_PERCENT', 50),
  safetyBuffer: parseNumMap(env('SAFETY_BUFFER', '')),
  shopify: {
    store: env('SHOPIFY_STORE', '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    token: env('SHOPIFY_ADMIN_TOKEN', ''),
    clientId: env('SHOPIFY_CLIENT_ID', ''),
    clientSecret: env('SHOPIFY_CLIENT_SECRET', ''),
    apiVersion: env('SHOPIFY_API_VERSION', '2025-07'),
    locationId: env('SHOPIFY_LOCATION_ID', ''),
    // App "API secret key" (legacy app) or "Client secret" (Dev Dashboard app): verifies webhook signatures
    webhookSecret: env('SHOPIFY_WEBHOOK_SECRET', env('SHOPIFY_CLIENT_SECRET', '')),
  },
  sync: {
    intervalMinutes: num('SYNC_INTERVAL_MINUTES', 15),
    reconciliationTime: env('RECONCILIATION_TIME', '02:00'),
    timezone: env('TIMEZONE', 'Asia/Bahrain'),
    concurrency: Math.max(1, num('CONCURRENCY', 3)),
    dryRun: bool('DRY_RUN', false),
    // false = no scheduled / nightly / startup runs; only manual Refresh from the dashboard or CLI
    autoSync: bool('AUTO_SYNC', true),
    partsListFile: path.resolve(ROOT, env('PARTS_LIST_FILE', 'parts-list.csv')),
  },
  alerts: {
    outageMinutes: num('OUTAGE_ALERT_MINUTES', 60),
    webhookUrl: env('ALERT_WEBHOOK_URL', ''),
    emailTo: env('ALERT_EMAIL_TO', '').split(/[,;]/).map((x) => x.trim()).filter(Boolean),
    emailFrom: env('ALERT_EMAIL_FROM', env('SMTP_USER', '')),
    smtp: {
      host: env('SMTP_HOST', ''),
      port: num('SMTP_PORT', 587),
      user: env('SMTP_USER', ''),
      pass: env('SMTP_PASS', ''),
    },
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
    // First admin users, used only on the very first start (then users are managed in the dashboard):
    // "user:password:email,user2:password2:email2"
    users: env('DASHBOARD_USERS', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const i = s.indexOf(':');
        if (i <= 0) return null;
        let pass = s.slice(i + 1);
        let email = '';
        const j = pass.lastIndexOf(':');
        if (j > 0 && pass.slice(j + 1).includes('@')) {
          email = pass.slice(j + 1).trim();
          pass = pass.slice(0, j);
        }
        return { user: s.slice(0, i).trim(), pass, email };
      })
      .filter((u) => u && u.user && u.pass),
    loginOtp: bool('LOGIN_EMAIL_OTP', true),
    sessionHours: num('SESSION_HOURS', 12),
    // Optional: only these IPs may open the dashboard (comma separated). Empty = any IP (login still required).
    allowedIps: env('ALLOWED_IPS', '').split(',').map((s) => s.trim()).filter(Boolean),
    // New user accounts must use one of these email domains (comma separated). Empty = any domain allowed.
    allowedEmailDomains: env('ALLOWED_EMAIL_DOMAINS', 'almoayyed.com,photonsoftwares.com')
      .split(',').map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean),
    // Public base URL used in emails (e.g. https://sync.example.com). Empty = build from the request host.
    publicBaseUrl: env('PUBLIC_BASE_URL', '').trim().replace(/\/+$/, ''),
    // Set true once the app is served over HTTPS (behind a TLS reverse proxy): adds Secure to cookies + HSTS.
    secureCookies: bool('SECURE_COOKIES', false),
    hsts: bool('HSTS', false),
  },
  };
}

// ---------- Dashboard settings (settings.json) ----------
// Only these keys can be changed from the dashboard. Secrets, URLs, port/host are .env only.
const EDITABLE = {
  AUTO_SYNC: { type: 'bool', group: 'Sync', label: 'Automatic sync (every interval + nightly). OFF = only manual Refresh' },
  DRY_RUN: { type: 'bool', group: 'Sync', label: 'Dry run (write nothing to Shopify)' },
  SYNC_INTERVAL_MINUTES: { type: 'number', group: 'Sync', label: 'Sync every (minutes)', min: 5, max: 1440 },
  RECONCILIATION_TIME: { type: 'time', group: 'Sync', label: 'Nightly reconciliation time (HH:MM, ' },
  CONCURRENCY: { type: 'number', group: 'Sync', label: 'Parallel parts', min: 1, max: 20 },
  PARTS_SOURCE: { type: 'select', group: 'Parts', label: 'Parts list from', options: { csv: 'parts-list.csv', tag: 'Shopify tag' } },
  SYNC_TAG: { type: 'text', group: 'Parts', label: 'Sync tag' },
  FRANCHISE_MAP: { type: 'textarea', group: 'Parts', label: 'Franchise codes (Brand=CODE, comma separated)' },
  AUTOLINE_ROOFTOP_ID: { type: 'text', group: 'Autoline', label: 'Main rooftop (price, blockSale)' },
  LOCATION_STOCK_MAP: { type: 'textarea', group: 'Autoline', label: 'Rooftop → Shopify location (ROOFTOP=gid://shopify/Location/ID)' },
  OUTLET_ROOFTOPS: { type: 'text', group: 'Autoline', label: 'Pickup outlet rooftops' },
  OUTLET_STOCK_SYNC: { type: 'bool', group: 'Autoline', label: 'Write outlet stock (Manama / Gudaibiya) to Shopify' },
  ONLINE_QTY_METAFIELD: { type: 'bool', group: 'Price & product', label: 'Write ehastock.online_qty metafield (theme online-stock gate)' },
  PART_KEY_MODE: { type: 'select', group: 'Parts', label: 'Autoline part number', options: { franchise: 'Franchise code + SKU', sku: 'SKU is the Autoline part number' } },
  AC_MODE: { type: 'select', group: 'Parts', label: 'AC / combined products', options: { pair: 'Pair list (indoor product + outdoor)', combined: 'Combined product (parts in metafield)', both: 'Both methods' } },
  STOCK_SOURCE: { type: 'select', group: 'Autoline', label: 'Stock quantity', options: { total: 'totalStockQty', prime1: 'Prime1 only', 'prime1-3': 'Prime1 + 2 + 3' } },
  SAFETY_BUFFER: { type: 'text', group: 'Autoline', label: 'Safety buffer (ROOFTOP=number)' },
  PRICE_MODE: { type: 'select', group: 'Price & product', label: 'Selling price', options: { price1: 'Price1 only', price1_special: 'Price1 + specialPrice promo' } },
  PRICE_VAT_PERCENT: { type: 'number', group: 'Price & product', label: 'Add VAT to price1 (%)', min: 0, max: 100 },
  STOCK_AT_ALL_LOCATIONS: { type: 'bool', group: 'Autoline', label: 'Set up product at every mapped location (e.g. Gudaibiya) if missing' },
  INSTALLATION_PART: { type: 'text', group: 'Price & product', label: 'Installation charge part (C1)' },
  INSTALLATION_TAG: { type: 'text', group: 'Price & product', label: 'Tag for products with installation (e.g. AC)' },
  NOT_IN_C1_ZERO: { type: 'bool', group: 'Autoline', label: 'Not in C1 but in a showroom: show 0 (Arriving Soon) and report' },
  PRICE_SWING_PERCENT: { type: 'number', group: 'Price & product', label: 'Report price change above (%)', min: 1, max: 1000 },
  DESCRIPTION_SYNC_ENABLED: { type: 'bool', group: 'Price & product', label: 'Sync description from Autoline' },
  BLOCK_SALE_ACTION: { type: 'select', group: 'Price & product', label: 'When blockSale = Y', options: { zero: 'Stock 0 + tag', draft: 'Set product to Draft' } },
  BLOCKED_TAG: { type: 'text', group: 'Price & product', label: 'Blocked tag' },
  STATUS_METAFIELDS: { type: 'bool', group: 'Price & product', label: 'Write sync status metafields' },
  DELIVERY_ONLY_TAG: { type: 'text', group: 'Delivery only', label: 'Delivery-only tag' },
  DELIVERY_ONLY_PRODUCT_TYPES: { type: 'text', group: 'Delivery only', label: 'Delivery-only product types (comma separated)' },
  DELIVERY_ONLY_ACTION: { type: 'select', group: 'Delivery only', label: 'Outlet stock for delivery-only', options: { zero: 'Set to 0', deactivate: 'Deactivate inventory' } },
  PICKUP_RECHECK: { type: 'bool', group: 'Pickup orders', label: 'Re-check outlet stock in Autoline when a pickup order arrives' },
  PICKUP_ALERT_TAG: { type: 'text', group: 'Pickup orders', label: 'Order tag when outlet stock is short' },
  PICKUP_POLL_MINUTES: { type: 'number', group: 'Pickup orders', label: 'Check Shopify for new pickup orders every (minutes, 0 = off)', min: 0, max: 60 },
  OUTAGE_ALERT_MINUTES: { type: 'number', group: 'Alerts', label: 'Alert when Autoline down (minutes)', min: 5, max: 1440 },
  ALERT_WEBHOOK_URL: { type: 'text', group: 'Alerts', label: 'Alert webhook URL (Teams/Slack)' },
  ALERT_EMAIL_TO: { type: 'text', group: 'Alerts', label: 'Alert email to (comma separated)' },
};
EDITABLE.RECONCILIATION_TIME.label = 'Nightly reconciliation time (HH:MM)';

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
let overrides = {};
function readOverrides() {
  try {
    const o = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const clean = {};
    for (const [k, v] of Object.entries(o || {})) if (EDITABLE[k]) clean[k] = String(v);
    return clean;
  } catch {
    return {};
  }
}

function buildWith(o) {
  const prev = SRC;
  SRC = { ...process.env, ...o };
  try {
    return build();
  } finally {
    SRC = prev;
  }
}

// Copy a freshly built config into the shared object (other modules hold a reference to it)
function assignInto(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      for (const kk of Object.keys(target[k])) if (!(kk in v)) delete target[k][kk];
      Object.assign(target[k], v);
    } else target[k] = v;
  }
}

overrides = readOverrides();
let config;
try {
  config = buildWith(overrides);
} catch (e) {
  // A bad settings.json must never stop the app: fall back to .env only
  console.error('settings.json ignored: ' + e.message);
  overrides = {};
  config = build();
}
SRC = Object.keys(overrides).length ? { ...process.env, ...overrides } : process.env;

function validate({ needShopify = true, needServer = false } = {}, cfg = config) {
  const config = cfg;
  const errs = [];
  // .env file is optional when settings come from real environment variables (Render, systemd, etc.)
  if (!envLoaded && !process.env.SHOPIFY_STORE) errs.push('.env file not found. Copy .env.example to .env and fill it in.');
  if (!['total', 'prime1', 'prime1-3'].includes(config.stockSource))
    errs.push('STOCK_SOURCE must be one of: total, prime1, prime1-3');
  if (!['franchise', 'sku'].includes(config.partKeyMode)) errs.push('PART_KEY_MODE must be franchise or sku');
  if (!['pair', 'combined', 'both'].includes(config.acMode)) errs.push('AC_MODE must be pair, combined or both');
  if (!['price1', 'price1_special'].includes(config.priceMode)) errs.push('PRICE_MODE must be price1 or price1_special');
  if (!['csv', 'tag'].includes(config.partsSource)) errs.push('PARTS_SOURCE must be csv or tag');
  if (!['zero', 'draft'].includes(config.blockSaleAction)) errs.push('BLOCK_SALE_ACTION must be zero or draft');
  if (!['zero', 'deactivate'].includes(config.deliveryOnlyAction)) errs.push('DELIVERY_ONLY_ACTION must be zero or deactivate');
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

function currentValue(k) {
  return overrides[k] !== undefined ? overrides[k] : process.env[k] !== undefined ? process.env[k] : '';
}

function getSettings() {
  return Object.entries(EDITABLE).map(([key, def]) => ({
    key,
    ...def,
    value: currentValue(key),
    envValue: process.env[key] !== undefined ? process.env[key] : '',
    source: overrides[key] !== undefined ? 'dashboard' : 'env',
  }));
}

// values: { KEY: 'string' }; reset: [KEY] -> back to .env. Throws with a clear message if invalid.
function updateSettings(values = {}, reset = []) {
  const next = { ...overrides };
  for (const k of reset) delete next[k];
  for (const [k, raw] of Object.entries(values)) {
    const def = EDITABLE[k];
    if (!def) throw new Error(`${k} cannot be changed from the dashboard`);
    let v = raw === null || raw === undefined ? '' : String(raw).trim();
    if (def.type === 'bool') v = v === 'true' || v === '1' ? 'true' : 'false';
    if (def.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < def.min || n > def.max) throw new Error(`${def.label}: must be a number between ${def.min} and ${def.max}`);
      v = String(Math.round(n));
    }
    if (def.type === 'time' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new Error(`${def.label}: use HH:MM, e.g. 02:00`);
    if (def.type === 'select' && !Object.keys(def.options).includes(v)) throw new Error(`${def.label}: invalid choice`);
    if (k === 'ALERT_EMAIL_TO' && v && !v.split(/[,;]/).every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()))) throw new Error('Alert email: invalid address');
    if (k === 'ALERT_WEBHOOK_URL' && v && !/^https:\/\//.test(v)) throw new Error('Alert webhook URL must start with https://');
    // same as .env -> no override needed
    if ((process.env[k] || '') === v) delete next[k];
    else next[k] = v;
  }
  const fresh = buildWith(next); // throws on parse errors (map formats)
  validate({ needShopify: false }, fresh); // throws on rule errors
  const changes = {};
  for (const k of Object.keys(EDITABLE)) {
    const before = currentValue(k);
    const after = next[k] !== undefined ? next[k] : process.env[k] !== undefined ? process.env[k] : '';
    if (before !== after) changes[k] = { from: before, to: after };
  }
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
  overrides = next;
  SRC = Object.keys(overrides).length ? { ...process.env, ...overrides } : process.env;
  assignInto(config, fresh);
  return changes;
}

module.exports = { config, validate, normBrand, getSettings, updateSettings, EDITABLE, overridesActive: () => Object.keys(overrides) };
