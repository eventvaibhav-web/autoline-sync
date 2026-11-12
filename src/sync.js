'use strict';
// Core sync logic. Can also be run from the command line:
//   node src/sync.js --once            one full sync
//   node src/sync.js --part UHD65SLEDT refresh one Shopify SKU
//   node src/sync.js --reconcile       nightly-style full reconciliation
const fs = require('fs');
const crypto = require('crypto');
const { config, validate } = require('./config');
const { logger, alert } = require('./logger');
const autoline = require('./autoline');
const shopify = require('./shopify');

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

// ---------- Parts list (CSV) ----------
function readPartsList() {
  const file = config.sync.partsListFile;
  if (!fs.existsSync(file)) throw new Error(`Parts list not found: ${file}`);
  const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
  const header = (lines.shift() || '').split(',').map((h) => h.trim().replace(/^"|"$/g, '').toLowerCase());
  const iSku = header.indexOf('shopify_sku');
  const iPn = header.indexOf('autoline_part_number');
  const iDel = header.indexOf('delivery_only');
  if (iSku < 0 || iPn < 0) throw new Error('parts-list.csv header must be: shopify_sku,autoline_part_number[,delivery_only]');
  const items = [];
  const seen = new Set();
  lines.forEach((line, idx) => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    const cols = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const sku = cols[iSku];
    const pn = cols[iPn];
    if (!sku || !pn) {
      logger.warn('parts_list_bad_row', { row: idx + 2, line });
      return;
    }
    if (seen.has(sku)) {
      logger.warn('parts_list_duplicate_sku', { row: idx + 2, sku });
      return;
    }
    seen.add(sku);
    const deliveryOnly = iDel >= 0 && /^(y|yes|true|1)$/i.test(cols[iDel] || '');
    items.push({ sku, partNumber: pn, deliveryOnly });
  });
  return items;
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
function desiredPrices(part) {
  if (!(part.price1 > 0)) return null;
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
async function processPart(item, state, ctx) {
  const { sku, partNumber } = item;
  const base = { runId: ctx.runId, sku, partNumber };
  const snap = { sku, partNumber, at: new Date().toISOString(), result: 'unchanged', changes: [], note: '' };

  if (ctx.autolineAbort) {
    snap.result = 'skipped';
    snap.note = 'Autoline unreachable - Shopify left unchanged';
    logger.skip('autoline_down_part_skipped', base);
    return snap;
  }

  // 1) Autoline
  let part;
  try {
    part = await autoline.loadPart(partNumber);
    ctx.autolineOk++;
  } catch (e) {
    if (e.outage) {
      ctx.autolineFail++;
      if (ctx.autolineOk === 0 && ctx.autolineFail >= 3) ctx.autolineAbort = true;
      snap.result = 'skipped';
      snap.note = 'Autoline unreachable - Shopify left unchanged';
      logger.warn('autoline_unreachable', { ...base, error: e.message });
      return snap;
    }
    throw e;
  }
  if (!part.found) {
    snap.result = 'skipped';
    snap.note = `Autoline: ${part.errorMessage || 'no data'}`;
    logger.skip('part_not_found_in_autoline', { ...base, errorMessage: part.errorMessage, errorCode: part.errorCode });
    return snap;
  }
  snap.autoline = {
    rooftopId: part.rooftopId,
    totalStockQty: part.totalStockQty,
    prime1: part.locations.Prime1.qty,
    price1: part.price1,
    specialPrice: part.specialPrice,
    blockSale: part.blockSale,
  };

  // 2) Shopify variant
  const variants = await shopify.findVariantsBySku(sku);
  if (variants.length === 0) {
    snap.result = 'skipped';
    snap.note = 'SKU not found in Shopify';
    logger.skip('sku_not_found_in_shopify', base);
    return snap;
  }
  if (variants.length > 1) {
    snap.result = 'error';
    snap.note = `SKU used by ${variants.length} variants in Shopify`;
    logger.error('duplicate_sku_in_shopify', { ...base, variantIds: variants.map((v) => v.id) });
    return snap;
  }
  const v = variants[0];
  snap.productId = v.product.id;
  snap.title = v.product.title;

  // 3) blockSale -> DRAFT, otherwise reactivate if we drafted it
  if (part.blockSale === 'Y') {
    if (await draftProduct(state, ctx, v, sku, 'block_sale')) snap.changes.push('status: DRAFT (blockSale=Y)');
    v.product.status = 'DRAFT';
  } else if (await maybeReactivate(state, ctx, v, sku)) {
    snap.changes.push('status: reactivated');
  }

  // 4) Price / compare-at
  const want = desiredPrices(part);
  if (!want) {
    logger.warn('invalid_price_skipped', { ...base, price1: part.price1 });
    snap.note = 'price1 is 0/empty - price not changed';
  } else if (
    !sameMoney(v.price, want.price) ||
    (want.compareAtPrice !== undefined && !sameMoney(v.compareAtPrice, want.compareAtPrice))
  ) {
    const cmp = want.compareAtPrice === undefined ? v.compareAtPrice : want.compareAtPrice;
    await shopify.updateVariantPrices(v.product.id, v.id, want.price, cmp);
    logger.change('price_updated', {
      ...base,
      from: { price: v.price, compareAtPrice: v.compareAtPrice },
      to: { price: want.price, compareAtPrice: cmp },
      promo: want.promo,
    });
    snap.changes.push(`price ${v.price} -> ${want.price}` + (want.promo ? ` (compare-at ${want.compareAtPrice})` : ''));
  }

  // 5) Inventory - one Shopify location per Autoline rooftop
  const deliveryOnly =
    item.deliveryOnly || (config.deliveryOnlyTag && (v.product.tags || []).some((t) => t.toLowerCase() === config.deliveryOnlyTag));
  snap.deliveryOnly = deliveryOnly;
  snap.stocks = [];
  const writes = [];
  if (!v.tracked) {
    logger.skip('inventory_not_tracked', { ...base, note: 'Track quantity is off in Shopify; not changing that setting' });
    snap.note = (snap.note ? snap.note + '; ' : '') + 'inventory not tracked in Shopify';
  } else {
    for (const t of ctx.targets) {
      const lvl = v.levels[t.locationId];
      const row = { location: t.name, rooftopId: t.rooftopId, shopify: lvl ? lvl.available : null, target: null };
      snap.stocks.push(row);
      if (!lvl) {
        logger.skip('variant_not_stocked_at_location', { ...base, location: t.name, note: 'not changing stocking settings' });
        row.note = 'not stocked here';
        continue;
      }
      let qty;
      if (deliveryOnly && t.outlet) {
        qty = 0; // delivery-only: no pickup stock at outlets
      } else {
        let src = t.rooftopId === part.rooftopId ? part : null;
        if (!src) {
          try {
            src = await autoline.loadPart(partNumber, t.rooftopId);
            ctx.autolineOk++;
          } catch (e) {
            if (!e.outage) throw e;
            ctx.autolineFail++;
            logger.warn('autoline_unreachable_location_skipped', { ...base, rooftopId: t.rooftopId, location: t.name, error: e.message });
            row.note = 'Autoline unreachable - unchanged';
            continue;
          }
          if (!src.found) {
            logger.skip('part_not_found_in_rooftop', { ...base, rooftopId: t.rooftopId, location: t.name, errorMessage: src.errorMessage });
            row.note = 'not in this rooftop - unchanged';
            continue;
          }
        }
        qty = autoline.pickStock(src);
        if (qty < 0) {
          logger.warn('negative_stock_set_to_zero', { ...base, rooftopId: t.rooftopId, autolineQty: qty });
          qty = 0;
        }
        if (!Number.isInteger(qty)) {
          logger.warn('fractional_stock_rounded_down', { ...base, rooftopId: t.rooftopId, autolineQty: qty });
          qty = Math.floor(qty);
        }
      }
      row.target = qty;
      if (lvl.available !== qty) writes.push({ locationId: t.locationId, quantity: qty, from: lvl.available, name: t.name });
    }
    if (writes.length) {
      await shopify.setAvailable(v.inventoryItemId, writes);
      for (const w of writes) {
        logger.change('inventory_updated', { ...base, location: w.name, from: w.from, to: w.quantity, deliveryOnly });
        snap.changes.push(`${w.name}: ${w.from} -> ${w.quantity}`);
      }
    }
  }

  // 6) Description (only if approved)
  if (config.descriptionSync && part.description) {
    const html = `<p>${escapeHtml(part.description)}</p>`;
    if ((v.product.descriptionHtml || '').trim() !== html) {
      await shopify.setProductDescription(v.product.id, html);
      logger.change('description_updated', base);
      snap.changes.push('description');
    }
  }

  if (snap.changes.length) snap.result = 'changed';
  else logger.info('no_change', { ...base, price: want && want.price });
  return snap;
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
  const ctx = { runId, autolineOk: 0, autolineFail: 0, autolineAbort: false };
  const state = loadState();
  const summary = { runId, mode, trigger, startedAt: running.startedAt, total: 0, changed: 0, unchanged: 0, skipped: 0, errors: 0, drafted_removed: 0 };

  try {
    logger.info('run_started', { runId, mode, trigger, onlySku, dryRun: config.sync.dryRun });
    ctx.targets = await shopify.getTargetLocations();
    let list = readPartsList();
    const listSkus = new Set(list.map((x) => x.sku));

    if (onlySku) {
      list = list.filter((x) => x.sku === onlySku);
      if (!list.length) throw new Error(`SKU ${onlySku} is not in the parts list`);
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

module.exports = { runSync, isRunning, loadState, saveState, readPartsList, desiredPrices };

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
