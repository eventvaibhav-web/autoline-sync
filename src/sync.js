'use strict';
// Core sync logic. Can also be run from the command line:
//   node src/sync.js --once            one full sync
//   node src/sync.js --part UHD65SLEDT refresh one Shopify SKU
//   node src/sync.js --reconcile       nightly-style full reconciliation
const fs = require('fs');
const crypto = require('crypto');
const { config, validate, normBrand } = require('./config');
const { logger, alert } = require('./logger');
const autoline = require('./autoline');
const shopify = require('./shopify');
const acpairs = require('./acpairs');

// ---------- State (state.json) ----------
const DEFAULT_STATE = {
  knownSkus: [], // SKUs that were in the list at the last full run
  draftedByApp: {}, // productId -> { sku, reason, prevStatus, at }
  autolineLastSuccessAt: null,
  autolineDownSince: null,
  outageAlertSent: false,
  lastRun: null,
  lastReconciliation: null,
  lastReconciliationDate: null,
  parts: {}, // sku -> last result snapshot for dashboard
  deactivatedByApp: {}, // `${inventoryItemId}|${locationId}` -> { sku, at }  (delivery-only, DELIVERY_ONLY_ACTION=deactivate)
  lastReport: null,
};

function loadState() {
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(config.stateFile, 'utf8')) };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}
function saveState(state) {
  fs.mkdirSync(require('path').dirname(config.stateFile), { recursive: true });
  const tmp = config.stateFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, config.stateFile);
}

// ---------- Parts list ----------
// CSV: shopify_sku[,autoline_part_number][,delivery_only]. Empty autoline number -> franchise code + SKU.
function readPartsList() {
  const file = config.sync.partsListFile;
  if (!fs.existsSync(file)) throw new Error(`Parts list not found: ${file}`);
  const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = (lines.shift() || '').split(',').map((h) => h.trim().replace(/^"|"$/g, '').toLowerCase());
  const iSku = header.indexOf('shopify_sku');
  const iPn = header.indexOf('autoline_part_number');
  const iDel = header.indexOf('delivery_only');
  if (iSku < 0) throw new Error('parts-list.csv header must be: shopify_sku[,autoline_part_number][,delivery_only]');
  const items = [];
  const seen = new Set();
  lines.forEach((line, idx) => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    const cols = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const sku = cols[iSku];
    if (!sku) {
      logger.warn('parts_list_bad_row', { row: idx + 2, line });
      return;
    }
    if (seen.has(sku)) {
      logger.warn('parts_list_duplicate_sku', { row: idx + 2, sku });
      return;
    }
    seen.add(sku);
    const deliveryOnly = iDel >= 0 && /^(y|yes|true|1)$/i.test(cols[iDel] || '');
    items.push({ sku, partNumber: iPn >= 0 ? cols[iPn] || null : null, deliveryOnly });
  });
  return items;
}

async function getPartsList() {
  if (config.partsSource !== 'tag') return readPartsList();
  const rows = await shopify.listTaggedSkus(config.syncTag);
  const seen = new Set();
  const items = [];
  for (const r of rows) {
    if (seen.has(r.sku)) continue; // duplicates are caught per part (duplicate_sku_in_shopify)
    seen.add(r.sku);
    items.push({ sku: r.sku, partNumber: null, deliveryOnly: false });
  }
  return items;
}

// ---------- Franchise key ----------
// Order (design doc section 7): variant metafield autoline.part_number (full Autoline number, any SKU)
// -> explicit Autoline number (CSV) -> product metafield autoline.franchise_code
// -> brand (Vendor) in franchise master (metaobject + FRANCHISE_MAP) with exactly one code -> UNMAPPED.
async function loadFranchiseIndex(ctx) {
  const idx = {};
  const add = (brand, code) => {
    if (!brand || !code) return;
    const k = normBrand(brand);
    idx[k] = idx[k] || new Set();
    idx[k].add(code);
  };
  if (config.franchiseMetaobjectType) {
    try {
      const rows = await shopify.getFranchiseMaster(config.franchiseMetaobjectType);
      rows.forEach((r) => add(r.brand, r.code));
      logger.info('franchise_master_loaded', { runId: ctx.runId, entries: rows.length });
    } catch (e) {
      logger.warn('franchise_master_unavailable', { runId: ctx.runId, error: e.message, note: 'using FRANCHISE_MAP only' });
    }
  }
  for (const [brand, codes] of Object.entries(config.franchiseMap)) codes.forEach((c) => add(brand, c));
  return idx;
}

function baseKey(item, v, ctx) {
  if (v.partNumberOverride) return { partNumber: v.partNumberOverride, via: 'variant_metafield' };
  if (item.partNumber) return { partNumber: item.partNumber, via: 'list' };
  const sku = v.sku || item.sku;
  if (config.partKeyMode === 'sku') return sku ? { partNumber: String(sku).trim().toUpperCase(), via: 'sku' } : { partNumber: null, reason: 'empty SKU' };
  if (v.product.franchiseCode) return { partNumber: v.product.franchiseCode + sku, via: 'product_metafield', code: v.product.franchiseCode };
  const codes = [...((ctx.franchise || {})[normBrand(v.product.vendor)] || [])];
  if (codes.length === 1) return { partNumber: codes[0] + sku, via: 'brand', code: codes[0] };
  return {
    partNumber: null,
    reason: codes.length > 1
      ? `brand "${v.product.vendor}" has several codes (${codes.join(', ')}); set autoline.franchise_code on the product`
      : `no franchise code for brand "${v.product.vendor || '(empty)'}"`,
  };
}

// Split AC sold as one product (agreed with Almoayyed): a product tagged INSTALLATION_TAG whose Autoline key ends
// with "-I" (indoor) is combined with the matching "-O" (outdoor) part; ZZCARR is added in the price step.
// A full "INDOOR+OUTDOOR" value in variant metafield autoline.part_number always wins.
function resolveKey(item, v, ctx) {
  const key = baseKey(item, v, ctx);
  if (!key.partNumber) return key;
  // Combined product: parts given explicitly (e.g. autoline.part_number = "A+B+C"). Always honoured.
  if (key.partNumber.includes('+')) return { ...key, bundle: true, combined: true };
  // AC from the business pairs list (indoor -> outdoor): one product = indoor + outdoor + installation.
  // Only when AC_MODE allows pairing (pair | both); in "combined" mode you declare parts explicitly instead.
  if (config.acMode === 'pair' || config.acMode === 'both') {
    const outdoor = acpairs.outdoorFor(key.partNumber);
    if (outdoor) return { ...key, partNumber: `${key.partNumber}+${outdoor}`, via: `${key.via} + outdoor (AC list)`, bundle: true, acList: true };
  }
  const tags = ((v.product && v.product.tags) || []).map((t) => t.toLowerCase());
  if (config.installationTag && tags.includes(config.installationTag) && /-I$/i.test(key.partNumber)) {
    const pn = key.partNumber;
    return { ...key, partNumber: `${pn}+${pn.slice(0, -2)}-${pn.slice(-1) === 'i' ? 'o' : 'O'}`, via: `${key.via} + outdoor`, bundle: true };
  }
  return key;
}

// ---------- Helpers ----------
const money = (n) => Number(n).toFixed(3); // BHD = 3 decimals
const sameMoney = (a, b) => {
  if (a === null || a === undefined || a === '') return b === null || b === undefined || b === '';
  if (b === null || b === undefined || b === '') return false;
  return Math.abs(Number(a) - Number(b)) < 0.0005;
};
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function pool(items, size, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// PRICE_MODE=price1 (business decision): selling price = Price1, compare-at is not touched.
// PRICE_MODE=price1_special: specialPrice > 0 and below price1 => price = special, compare-at = price1.
// Autoline price1 is without VAT; the website shows the price with VAT (PRICE_VAT_PERCENT, default 10).
const withVat = (n) => Math.round(Number(n) * (1 + (config.priceVatPercent || 0) / 100) * 1000) / 1000;
function desiredPrices(raw) {
  if (!(raw.price1 > 0)) return null;
  const part = { ...raw, price1: withVat(raw.price1), specialPrice: raw.specialPrice > 0 ? withVat(raw.specialPrice) : 0 };
  if (config.priceMode === 'price1') return { price: money(part.price1), compareAtPrice: undefined, promo: false };
  if (part.specialPrice > 0 && part.specialPrice < part.price1) {
    return { price: money(part.specialPrice), compareAtPrice: money(part.price1), promo: true };
  }
  return { price: money(part.price1), compareAtPrice: null, promo: false };
}

// ---------- Draft / reactivate ----------
async function draftProduct(state, ctx, variant, sku, reason) {
  const p = variant.product;
  if (p.status === 'DRAFT') {
    logger.skip('already_draft', { runId: ctx.runId, sku, productId: p.id, reason });
    return false;
  }
  await shopify.setProductStatus(p.id, 'DRAFT');
  state.draftedByApp[p.id] = { sku, reason, prevStatus: p.status, at: new Date().toISOString() };
  logger.change('product_drafted', { runId: ctx.runId, sku, productId: p.id, title: p.title, from: p.status, reason });
  return true;
}

async function maybeReactivate(state, ctx, variant, sku) {
  const p = variant.product;
  const rec = state.draftedByApp[p.id];
  if (!rec) return false;
  if (p.status !== 'DRAFT') {
    delete state.draftedByApp[p.id]; // someone changed it manually; stop tracking
    return false;
  }
  const to = rec.prevStatus && rec.prevStatus !== 'DRAFT' ? rec.prevStatus : 'ACTIVE';
  await shopify.setProductStatus(p.id, to);
  delete state.draftedByApp[p.id];
  logger.change('product_reactivated', { runId: ctx.runId, sku, productId: p.id, to, previousReason: rec.reason });
  return true;
}

// ---------- One part ----------
function report(ctx, type, base, detail) {
  ctx.report.push({ type, sku: base.sku, partNumber: base.partNumber || '', detail: detail || '' });
}

function queueStatus(ctx, v, status) {
  if (!config.statusMetafields || !v) return;
  const now = new Date().toISOString();
  if (v.syncStatus !== status)
    ctx.metafields.push({ ownerId: v.id, namespace: 'autoline', key: 'sync_status', type: 'single_line_text_field', value: status });
  if (status === 'OK' || status === 'BLOCKED')
    ctx.metafields.push({ ownerId: v.id, namespace: 'autoline', key: 'last_synced_at', type: 'date_time', value: now });
}

// "PART1+PART2" = one Shopify product made of several Autoline parts (e.g. AC indoor + outdoor unit):
// found only if all are found; stock = lowest; price1 = sum; blocked if any part is blocked.
async function loadBundle(partNumber, rooftopId) {
  const pieces = partNumber.split('+').map((x) => x.trim()).filter(Boolean);
  if (pieces.length < 2) return autoline.loadPart(partNumber, rooftopId);
  const parts = [];
  for (const pn of pieces) parts.push(await autoline.loadPart(pn, rooftopId));
  const missing = parts.find((x) => !x.found);
  if (missing) return { ...missing, errorMessage: `${missing.partNumber || ''} ${missing.errorMessage || 'not found'}`.trim() };
  return {
    ...parts[0],
    partNumber,
    bundle: parts.map((x) => ({ partNumber: x.partNumber, price1: x.price1, totalStockQty: x.totalStockQty })),
    totalStockQty: Math.min(...parts.map((x) => Number(x.totalStockQty) || 0)),
    price1: parts.every((x) => x.price1 > 0) ? parts.reduce((a, x) => a + Number(x.price1), 0) : 0,
    specialPrice: 0,
    blockSale: parts.some((x) => x.blockSale === 'Y') ? 'Y' : 'N',
    supercededTo: parts.map((x) => x.supercededTo).filter(Boolean).join('+'),
  };
}

async function loadFromRooftop(partNumber, rooftopId, ctx, base) {
  try {
    const p = await loadBundle(partNumber, rooftopId);
    ctx.autolineOk++;
    return { part: p };
  } catch (e) {
    if (!e.outage) throw e;
    ctx.autolineFail++;
    if (ctx.autolineOk === 0 && ctx.autolineFail >= 3) ctx.autolineAbort = true;
    logger.warn('autoline_unreachable', { ...base, rooftopId, error: e.message });
    return { down: true };
  }
}

function toQty(src, rooftopId, base) {
  let qty = autoline.pickStock(src);
  if (qty < 0) {
    logger.warn('negative_stock_set_to_zero', { ...base, rooftopId, autolineQty: qty });
    qty = 0;
  }
  if (!Number.isInteger(qty)) {
    logger.warn('fractional_stock_rounded_down', { ...base, rooftopId, autolineQty: qty });
    qty = Math.floor(qty);
  }
  const buffer = config.safetyBuffer[rooftopId] || 0;
  return Math.max(0, qty - buffer);
}

async function processPart(item, state, ctx) {
  const { sku } = item;
  const base = { runId: ctx.runId, sku, partNumber: item.partNumber || null };
  const snap = { sku, partNumber: item.partNumber || '', at: new Date().toISOString(), result: 'unchanged', changes: [], note: '' };
  const skip = (note) => {
    snap.result = 'skipped';
    snap.note = note;
    return snap;
  };

  if (ctx.autolineAbort) {
    logger.skip('autoline_down_part_skipped', base);
    return skip('Autoline unreachable - Shopify left unchanged');
  }

  // 1) Shopify variant
  const variants = await shopify.findVariantsBySku(sku);
  if (variants.length === 0) {
    logger.skip('sku_not_found_in_shopify', base);
    report(ctx, 'NOT_IN_SHOPIFY', base);
    return skip('SKU not found in Shopify');
  }
  if (variants.length > 1) {
    logger.error('duplicate_sku_in_shopify', { ...base, variantIds: variants.map((x) => x.id) });
    report(ctx, 'DUPLICATE_SKU', base, `${variants.length} variants`);
    snap.result = 'skipped';
    snap.note = `SKU used by ${variants.length} variants in Shopify - all skipped`;
    return snap;
  }
  const v = variants[0];
  snap.productId = v.product.id;
  snap.title = v.product.title;
  snap.vendor = v.product.vendor;

  // 2) Autoline key (franchise code + SKU)
  const key = resolveKey(item, v, ctx);
  if (!key.partNumber) {
    logger.skip('franchise_unmapped', { ...base, vendor: v.product.vendor, reason: key.reason });
    report(ctx, 'UNMAPPED', base, key.reason);
    queueStatus(ctx, v, 'UNMAPPED');
    return skip(`UNMAPPED: ${key.reason}`);
  }
  base.partNumber = key.partNumber;
  snap.partNumber = key.partNumber;
  snap.keyVia = key.via;

  // 3) Main rooftop (price, blockSale, website stock)
  let main = await loadFromRooftop(key.partNumber, config.autoline.rooftopId, ctx, base);
  if (main.down) return skip('Autoline unreachable - Shopify left unchanged');
  // SKU already carries the franchise code (e.g. Panasonic PANC-K101WTZ): try the SKU as-is
  const skuU = (v.sku || sku).toUpperCase();
  if (!main.part.found && !key.bundle && key.code && skuU.startsWith(key.code) && skuU !== key.partNumber) {
    const alt = await loadFromRooftop(skuU, config.autoline.rooftopId, ctx, base);
    if (alt.down) return skip('Autoline unreachable - Shopify left unchanged');
    if (alt.part.found) {
      logger.info('key_sku_already_has_code', { ...base, tried: key.partNumber, used: skuU });
      main = alt;
      key.partNumber = skuU;
      key.via += ' (SKU has code)';
      base.partNumber = skuU;
      snap.partNumber = skuU;
      snap.keyVia = key.via;
    }
  }
  const part = main.part;
  if (!part.found && config.notInC1Zero) {
    // Not in C1 but maybe in a showroom: business rule = website shows 0 ("Arriving Soon"), price unchanged, reported by email
    const found = [];
    for (const t of ctx.targets.filter((x) => x.rooftopId !== config.autoline.rooftopId)) {
      const o = await loadFromRooftop(key.partNumber, t.rooftopId, ctx, base);
      if (o.part && o.part.found) found.push(`${t.name.replace(/^.*- /, '')}: ${Math.max(0, Math.floor(Number(o.part.totalStockQty) || 0))}`);
    }
    if (found.length) {
      const zero = [];
      if (v.tracked) for (const t of ctx.targets) {
        const lvl = v.levels[t.locationId];
        if (lvl && lvl.available !== 0) zero.push({ locationId: t.locationId, quantity: 0, from: lvl.available, name: t.name });
      }
      if (zero.length) {
        await shopify.setAvailable(v.inventoryItemId, zero);
        for (const w of zero) {
          logger.change('inventory_updated', { ...base, location: w.name, from: w.from, to: 0, reason: 'not_in_c1' });
          snap.changes.push(`${w.name}: ${w.from} -> 0 (not in C1)`);
        }
      }
      logger.skip('part_not_in_c1', { ...base, outlets: found.join(', ') });
      report(ctx, 'NOT_IN_C1', base, `Not in C1, available at ${found.join(', ')}; Shopify set to 0 (Arriving Soon)`);
      queueStatus(ctx, v, 'NOT_IN_C1');
      snap.note = 'Not in C1, shown as Arriving Soon';
      if (snap.changes.length) snap.result = 'changed';
      return snap.changes.length ? snap : skip('Not in C1 (available in a showroom) - shown as Arriving Soon');
    }
  }
  if (!part.found) {
    logger.skip('part_not_found_in_autoline', { ...base, rooftopId: part.rooftopId, errorMessage: part.errorMessage, errorCode: part.errorCode });
    report(ctx, 'NOT_FOUND', base, `${part.rooftopId}: ${part.errorMessage} (${part.errorCode})`);
    queueStatus(ctx, v, 'NOT_FOUND');
    return skip(`Autoline: ${part.errorMessage || 'no data'}`);
  }
  snap.autoline = {
    rooftopId: part.rooftopId,
    totalStockQty: part.totalStockQty,
    price1: part.price1,
    specialPrice: part.specialPrice,
    blockSale: part.blockSale,
  };
  if (part.supercededTo) {
    logger.info('part_superseded', { ...base, supercededTo: part.supercededTo });
    report(ctx, 'SUPERSEDED', base, `superseded by ${part.supercededTo}`);
  }

  const blocked = part.blockSale === 'Y';
  const tagsLower = v.product.tags.map((t) => t.toLowerCase());

  // 4) Status: blockSale / reactivation
  if (blocked) {
    report(ctx, 'BLOCKED', base);
    if (config.blockSaleAction === 'draft') {
      if (await draftProduct(state, ctx, v, sku, 'block_sale')) snap.changes.push('status: DRAFT (blockSale=Y)');
      v.product.status = 'DRAFT';
    } else if (!tagsLower.includes(config.blockedTag.toLowerCase())) {
      await shopify.addTags(v.product.id, [config.blockedTag]);
      logger.change('blocked_tag_added', { ...base, tag: config.blockedTag });
      snap.changes.push(`tag ${config.blockedTag} added`);
    }
  } else {
    if (await maybeReactivate(state, ctx, v, sku)) snap.changes.push('status: reactivated');
    if (tagsLower.includes(config.blockedTag.toLowerCase())) {
      await shopify.removeTags(v.product.id, [config.blockedTag]);
      logger.change('blocked_tag_removed', { ...base, tag: config.blockedTag });
      snap.changes.push(`tag ${config.blockedTag} removed`);
    }
  }

  // 5) Price (+ installation charge: Autoline installation part, e.g. ZZCARR, for products tagged for installation;
  //    or a fixed amount in variant metafield autoline.installation_charge). Both are without VAT; VAT is added once.
  let install = Number(v.installationCharge) || 0;
  const wantInstall = !!key.acList || !!(config.installationTag && tagsLower.includes(config.installationTag));
  if (!install && config.installationPart && wantInstall) {
    if (ctx.installPrice === undefined) {
      const ip = await loadFromRooftop(config.installationPart, config.autoline.rooftopId, ctx, base);
      ctx.installPrice = ip.part && ip.part.found ? Number(ip.part.price1) || 0 : 0;
      if (!ctx.installPrice) logger.warn('installation_part_not_found', { part: config.installationPart });
    }
    install = ctx.installPrice;
    if (!install) {
      report(ctx, 'NO_INSTALL_PRICE', base, `${config.installationPart} not found in C1 - price not changed`);
      snap.note = 'installation price missing - price not changed';
    }
  }
  const installMissing = !install && wantInstall && !Number(v.installationCharge);
  const want = desiredPrices(install > 0 && part.price1 > 0 ? { ...part, price1: part.price1 + install, specialPrice: part.specialPrice > 0 ? part.specialPrice + install : 0 } : part);
  if (install > 0) snap.installationCharge = install;
  if (part.bundle) snap.bundle = part.bundle;
  if (installMissing) {
    logger.warn('price_skipped_no_installation_price', base);
  } else if (!want) {
    logger.warn('invalid_price_skipped', { ...base, price1: part.price1 });
    snap.note = 'price1 is 0/empty - price not changed';
  } else if (
    !sameMoney(v.price, want.price) ||
    (want.compareAtPrice !== undefined && !sameMoney(v.compareAtPrice, want.compareAtPrice))
  ) {
    const cmp = want.compareAtPrice === undefined ? v.compareAtPrice : want.compareAtPrice;
    await shopify.updateVariantPrices(v.product.id, v.id, want.price, cmp);
    logger.change('price_updated', { ...base, from: { price: v.price, compareAtPrice: v.compareAtPrice }, to: { price: want.price, compareAtPrice: cmp }, promo: want.promo });
    snap.changes.push(`price ${v.price} -> ${want.price}`);
    const old = Number(v.price);
    if (old > 0) {
      const pct = (Math.abs(Number(want.price) - old) / old) * 100;
      if (pct > config.priceSwingPercent) {
        logger.warn('price_swing', { ...base, from: v.price, to: want.price, percent: Math.round(pct) });
        report(ctx, 'PRICE_SWING', base, `${v.price} -> ${want.price} (${Math.round(pct)}%)`);
      }
    }
  }

  // 6) Delivery-only?
  const deliveryOnly =
    item.deliveryOnly ||
    (config.deliveryOnlyTag && tagsLower.includes(config.deliveryOnlyTag)) ||
    (config.deliveryOnlyTypes.length > 0 && config.deliveryOnlyTypes.includes(v.product.productType.toLowerCase()));
  snap.deliveryOnly = deliveryOnly;
  const mfWant = deliveryOnly ? 'true' : 'false';
  if (v.product.deliveryOnlyMf !== mfWant && (deliveryOnly || v.product.deliveryOnlyMf !== null)) {
    ctx.metafields.push({ ownerId: v.product.id, namespace: 'ehastock', key: 'delivery_only', type: 'boolean', value: mfWant });
  }

  // 7) Inventory per location
  snap.stocks = [];
  const writes = [];
  const toDeactivate = [];
  if (!v.tracked) {
    logger.skip('inventory_not_tracked', { ...base, note: 'Track quantity is off in Shopify; not changing that setting' });
    snap.note = (snap.note ? snap.note + '; ' : '') + 'inventory not tracked in Shopify';
  } else {
    for (const t of ctx.targets) {
      const deKey = `${v.inventoryItemId}|${t.locationId}`;
      let lvl = v.levels[t.locationId];
      const row = { location: t.name, rooftopId: t.rooftopId, outlet: !!t.outlet, writable: !!t.writable, shopify: lvl ? lvl.available : null, target: null };
      snap.stocks.push(row);
      const outletDeliveryOnly = deliveryOnly && t.outlet;

      // Auto-stocking (re-activate / stock-at-all-locations) only for locations we actually write to.
      if (t.writable) {
        // Re-activate an outlet the app deactivated earlier, once the product is no longer delivery-only
        if (!lvl && !outletDeliveryOnly && state.deactivatedByApp[deKey]) {
          await shopify.activateInventory(v.inventoryItemId, t.locationId);
          delete state.deactivatedByApp[deKey];
          logger.change('inventory_reactivated', { ...base, location: t.name });
          snap.changes.push(`${t.name}: inventory re-activated`);
          lvl = { id: null, name: t.name, available: 0 };
          row.shopify = 0;
        }
        // Product not set up at this location yet (e.g. Gudaibiya): stock it there, so pickup can be offered
        if (!lvl && !outletDeliveryOnly && config.stockAtAllLocations) {
          await shopify.activateInventory(v.inventoryItemId, t.locationId);
          logger.change('inventory_activated', { ...base, location: t.name });
          snap.changes.push(`${t.name}: product stocked here`);
          lvl = { id: null, name: t.name, available: 0 };
          row.shopify = 0;
        }
      }

      // Work out the Autoline quantity for this location. We do this even for outlet locations we do
      // not write to, so the dashboard can show their Autoline stock (read-only).
      let qty;
      if (blocked && config.blockSaleAction === 'zero') {
        qty = 0;
        row.note = 'blockSale=Y';
      } else if (outletDeliveryOnly) {
        qty = 0;
        row.note = 'delivery only';
        if (t.writable && lvl && config.deliveryOnlyAction === 'deactivate' && lvl.id) toDeactivate.push({ t, lvl, deKey });
      } else {
        const src = t.rooftopId === part.rooftopId ? { part } : await loadFromRooftop(key.partNumber, t.rooftopId, ctx, base);
        if (src.down) {
          row.note = 'Autoline unreachable - unchanged';
          continue;
        }
        if (!src.part.found) {
          if (t.writable) logger.skip('part_not_found_in_rooftop', { ...base, rooftopId: t.rooftopId, location: t.name, errorMessage: src.part.errorMessage });
          row.note = 'not in this rooftop';
          continue;
        }
        qty = toQty(src.part, t.rooftopId, base);
      }
      row.target = qty;

      // Outlet location with writing turned off: show the Autoline figure, never push it to Shopify.
      if (!t.writable) {
        row.note = row.note ? row.note + ' - not synced' : 'Autoline only - not synced';
        continue;
      }
      if (!lvl) {
        logger.skip('variant_not_stocked_at_location', { ...base, location: t.name, note: 'not changing stocking settings' });
        row.note = row.note || 'not stocked here';
        continue;
      }
      if (lvl.available !== qty) writes.push({ locationId: t.locationId, quantity: qty, from: lvl.available, name: t.name });
    }
    if (writes.length) {
      await shopify.setAvailable(v.inventoryItemId, writes);
      for (const w of writes) {
        logger.change('inventory_updated', { ...base, location: w.name, from: w.from, to: w.quantity, deliveryOnly, blocked });
        snap.changes.push(`${w.name}: ${w.from} -> ${w.quantity}`);
      }
    }
    for (const d of toDeactivate) {
      await shopify.deactivateInventory(d.lvl.id);
      state.deactivatedByApp[d.deKey] = { sku, at: new Date().toISOString() };
      logger.change('inventory_deactivated', { ...base, location: d.t.name, reason: 'delivery_only' });
      snap.changes.push(`${d.t.name}: inventory deactivated (delivery only)`);
    }
  }

  // 8) Description (only if approved)
  if (config.descriptionSync && part.description) {
    const html = `<p>${escapeHtml(part.description)}</p>`;
    if ((v.product.descriptionHtml || '').trim() !== html) {
      await shopify.setProductDescription(v.product.id, html);
      logger.change('description_updated', base);
      snap.changes.push('description');
    }
  }

  queueStatus(ctx, v, blocked ? 'BLOCKED' : 'OK');
  if (snap.changes.length) snap.result = 'changed';
  else logger.info('no_change', { ...base, price: want && want.price });
  return snap;
}

// ---------- Report file (CSV) ----------
const path = require('path');
const reportsDir = () => path.join(config.dataDir, 'reports');
function writeReport(rows) {
  fs.mkdirSync(reportsDir(), { recursive: true });
  const file = path.join(reportsDir(), `report-${new Date().toISOString().slice(0, 10)}.csv`);
  const esc = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
  const body = rows.length ? rows.map((r) => [r.type, r.sku, r.partNumber, r.detail].map(esc).join(',')) : ['"OK","","","Nothing to report: all listed products matched Autoline"'];
  const lines = ['type,shopify_sku,autoline_part_number,detail', ...body];
  // BOM so Excel / Google Sheets read it as UTF-8
  fs.writeFileSync(file, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');
  return file;
}
function listReports() {
  if (!fs.existsSync(reportsDir())) return [];
  return fs.readdirSync(reportsDir()).filter((f) => /^report-\d{4}-\d{2}-\d{2}\.csv$/.test(f)).sort().reverse();
}
function readReport(name) {
  if (!/^report-\d{4}-\d{2}-\d{2}\.csv$/.test(name)) return null;
  const f = path.join(reportsDir(), name);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '') : null;
}

// ---------- Run ----------
let running = null;
function isRunning() {
  return running;
}

async function runSync({ mode = 'scheduled', onlySku = null, trigger = 'schedule' } = {}) {
  if (running) {
    logger.skip('run_skipped_overlap', { mode, trigger, runningSince: running.startedAt });
    return { skipped: true, reason: 'Another sync is already running' };
  }
  const runId = crypto.randomBytes(4).toString('hex');
  running = { runId, mode, startedAt: new Date().toISOString() };
  const started = Date.now();
  const ctx = { runId, autolineOk: 0, autolineFail: 0, autolineAbort: false, report: [], metafields: [] };
  const state = loadState();
  const summary = { runId, mode, trigger, startedAt: running.startedAt, total: 0, changed: 0, unchanged: 0, skipped: 0, errors: 0, drafted_removed: 0 };

  try {
    logger.info('run_started', { runId, mode, trigger, onlySku, dryRun: config.sync.dryRun });
    ctx.targets = await shopify.getTargetLocations();
    // Outlet locations (Manama / Gudaibiya): their Autoline stock is still READ and shown in the
    // dashboard, but it is only WRITTEN to Shopify when OUTLET_STOCK_SYNC is on. "writable" carries
    // that distinction; targets are no longer dropped, so the Products panel can show outlet stock.
    for (const t of ctx.targets) t.writable = config.outletStockSync || !t.outlet;
    if (!ctx.targets.some((t) => t.writable)) throw new Error('No writable Shopify location: map the main rooftop (e.g. SOC1P_PH) to "Online Store Location" in LOCATION_STOCK_MAP');
    ctx.franchise = await loadFranchiseIndex(ctx);
    let list = await getPartsList();
    const listSkus = new Set(list.map((x) => x.sku));

    if (onlySku) {
      list = list.filter((x) => x.sku === onlySku);
      if (!list.length) throw new Error(`SKU ${onlySku} is not in the parts list (${config.partsSource === 'tag' ? 'tag ' + config.syncTag : 'parts-list.csv'})`);
    } else {
      // Parts removed from the business list -> DRAFT (never delete)
      const removed = (state.knownSkus || []).filter((s) => !listSkus.has(s));
      for (const sku of removed) {
        try {
          const vs = await shopify.findVariantsBySku(sku);
          if (vs.length === 1) {
            if (await draftProduct(state, ctx, vs[0], sku, 'removed_from_list')) summary.drafted_removed++;
          } else {
            logger.warn('removed_sku_lookup', { runId, sku, matches: vs.length });
          }
          delete state.parts[sku];
        } catch (e) {
          summary.errors++;
          logger.error('removed_sku_draft_failed', { runId, sku, error: e.message });
        }
      }
      state.knownSkus = [...listSkus];
    }

    summary.total = list.length;
    const results = await pool(list, config.sync.concurrency, async (item) => {
      try {
        return await processPart(item, state, ctx);
      } catch (e) {
        logger.error('part_failed', { runId, sku: item.sku, partNumber: item.partNumber, error: e.message });
        return { sku: item.sku, partNumber: item.partNumber, at: new Date().toISOString(), result: 'error', note: e.message, changes: [] };
      }
    });
    for (const r of results) {
      summary[r.result === 'changed' ? 'changed' : r.result === 'unchanged' ? 'unchanged' : r.result === 'error' ? 'errors' : 'skipped']++;
      state.parts[r.sku] = r;
    }
    // Status / delivery-only metafields, 25 per call
    if (ctx.metafields.length) {
      try {
        await shopify.setMetafields(ctx.metafields);
        logger.info('metafields_written', { runId, count: ctx.metafields.length });
      } catch (e) {
        summary.errors++;
        logger.error('metafields_failed', { runId, error: e.message });
      }
    }
  } catch (e) {
    summary.errors++;
    summary.fatal = e.message;
    logger.error('run_failed', { runId, error: e.message });
  }

  // ---------- Autoline outage tracking ----------
  const now = Date.now();
  if (ctx.autolineOk > 0) {
    state.autolineLastSuccessAt = new Date(now).toISOString();
    if (state.autolineDownSince) {
      const mins = Math.round((now - Date.parse(state.autolineDownSince)) / 60000);
      logger.info('autoline_recovered', { downMinutes: mins });
      if (state.outageAlertSent) await alert('autoline_recovered', `Autoline is reachable again after ~${mins} min.`, {}, { force: true });
    }
    state.autolineDownSince = null;
    state.outageAlertSent = false;
  } else if (ctx.autolineFail > 0) {
    if (!state.autolineDownSince) state.autolineDownSince = new Date(now).toISOString();
    const mins = (now - Date.parse(state.autolineDownSince)) / 60000;
    if (mins >= config.alerts.outageMinutes && !state.outageAlertSent) {
      await alert('autoline_outage', `Autoline API unreachable for ${Math.round(mins)} min. Shopify values are being kept unchanged.`, {
        since: state.autolineDownSince,
      }, { force: true });
      state.outageAlertSent = true;
    }
  }

  // ---------- Business report ----------
  const counts = {};
  for (const r of ctx.report) counts[r.type] = (counts[r.type] || 0) + 1;
  summary.report = counts;
  if (!onlySku) {
    state.lastReport = { at: new Date().toISOString(), mode, counts, rows: ctx.report.slice(0, 500) };
    {
      // every full run (nightly, Refresh all) writes today's report; the nightly one also sends it by alert
      const file = writeReport(ctx.report);
      const txt = Object.entries(counts).map(([k, n]) => `${k}: ${n}`).join(', ') || 'nothing to report';
      logger.info('daily_report_written', { file: path.basename(file), counts });
      if (mode === 'reconciliation') {
        const notInC1 = ctx.report.filter((r) => r.type === 'NOT_IN_C1');
        const list = notInC1.map((r) => `- ${r.sku} (${r.partNumber}): ${r.detail}`).join('\n');
        await alert('daily_report', `Daily report: ${txt}. File: ${require('path').basename(file)}` +
          (notInC1.length ? `\n\nProducts not in C1 but available in a showroom (shown as Arriving Soon on the website):\n${list}` : ''),
          { counts }, { force: true });
      }
    }
  }

  summary.durationMs = Date.now() - started;
  summary.finishedAt = new Date().toISOString();
  if (!onlySku) state.lastRun = summary;
  if (mode === 'reconciliation') state.lastReconciliation = summary;
  saveState(state);

  logger.info(mode === 'reconciliation' ? 'reconciliation_summary' : 'run_finished', summary);
  if (summary.errors > 0) {
    await alert('sync_errors', `Sync ${mode} finished with ${summary.errors} error(s). Check dashboard/logs.`, { runId });
  }
  running = null;
  return summary;
}

module.exports = { runSync, isRunning, loadState, saveState, readPartsList, getPartsList, desiredPrices, resolveKey, loadFranchiseIndex, listReports, readReport, loadBundle };

// ---------- CLI ----------
if (require.main === module) {
  (async () => {
    try {
      validate({ needShopify: true });
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    const args = process.argv.slice(2);
    let opts = { mode: 'manual', trigger: 'cli' };
    if (args.includes('--reconcile')) opts = { mode: 'reconciliation', trigger: 'cli' };
    const pi = args.indexOf('--part');
    if (pi >= 0) {
      if (!args[pi + 1]) {
        console.error('Usage: npm run sync-part -- <SHOPIFY_SKU>');
        process.exit(1);
      }
      opts.onlySku = args[pi + 1];
    }
    const s = await runSync(opts);
    console.log('\nSummary:', JSON.stringify(s, null, 2));
    process.exit(s.errors ? 2 : 0);
  })();
}
