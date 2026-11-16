'use strict';
// Pickup order re-check (design doc BR-08, section 11C, test T-16).
// When an order with local pickup arrives, the outlet stock is read again from Autoline.
// If the outlet cannot cover a line, the order gets a tag (default "pickup-stock-alert") and an alert is sent.
// Only order id/name, pickup location and line items (SKU, qty) are used and stored - no customer data.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('./config');
const { logger, alert } = require('./logger');
const autoline = require('./autoline');
const shopify = require('./shopify');
const { resolveKey, loadFranchiseIndex } = require('./sync');

const FILE = () => path.join(config.dataDir, 'pickup.json');
function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    return { processed: [], checks: [] };
  }
}
function save(d) {
  d.processed = d.processed.slice(-1000);
  d.checks = d.checks.slice(-200);
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE() + '.tmp', JSON.stringify(d, null, 2));
  fs.renameSync(FILE() + '.tmp', FILE());
}

function verifyWebhook(rawBody, hmacHeader) {
  const secret = config.shopify.webhookSecret;
  if (!secret || !hmacHeader) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(digest);
  const b = Buffer.from(String(hmacHeader));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Autoline stock of one SKU at one rooftop, using the same key rules as the sync
async function outletStock(sku, rooftopId, ctx) {
  const vs = await shopify.findVariantsBySku(sku);
  if (vs.length !== 1) return { error: vs.length ? 'duplicate SKU in Shopify' : 'SKU not found in Shopify' };
  const v = vs[0];
  const key = resolveKey({ sku, partNumber: null }, v, ctx);
  if (!key.partNumber) return { error: 'UNMAPPED: ' + key.reason };
  let p = await autoline.loadPart(key.partNumber, rooftopId);
  let pn = key.partNumber;
  const skuU = sku.toUpperCase();
  if (!p.found && key.code && skuU.startsWith(key.code) && skuU !== pn) {
    const alt = await autoline.loadPart(skuU, rooftopId);
    if (alt.found) {
      p = alt;
      pn = skuU;
    }
  }
  if (!p.found) return { partNumber: pn, error: `not found in ${rooftopId}` };
  let q = autoline.pickStock(p);
  q = Math.max(0, Math.floor(q));
  return { partNumber: pn, qty: q };
}

async function recheckOrder(orderId, { trigger = 'webhook', force = false } = {}) {
  const store = load();
  if (!force && store.processed.includes(orderId)) {
    logger.skip('pickup_recheck_duplicate', { orderId });
    return { skipped: true, reason: 'already checked' };
  }
  const order = await shopify.getOrderForRecheck(orderId);
  if (!order) throw new Error(`Order ${orderId} not found`);
  const byLocation = Object.fromEntries(config.locationStockMap.map((m) => [m.locationId, m.rooftopId]));
  const pickups = order.fulfillmentOrders.nodes.filter((fo) => fo.deliveryMethod && fo.deliveryMethod.methodType === 'PICK_UP');

  const result = { at: new Date().toISOString(), orderId: order.id, order: order.name, trigger, pickup: pickups.length > 0, lines: [], short: false, problems: [] };
  if (!pickups.length) {
    logger.info('pickup_recheck_not_pickup', { orderId: order.id, order: order.name });
  } else {
    const ctx = { runId: 'pickup', franchise: await loadFranchiseIndex({ runId: 'pickup' }) };
    for (const fo of pickups) {
      const loc = fo.assignedLocation && fo.assignedLocation.location;
      const rooftopId = loc && byLocation[loc.id];
      if (!rooftopId) {
        result.problems.push(`pickup location ${loc ? loc.name : '?'} has no Autoline rooftop in LOCATION_STOCK_MAP`);
        continue;
      }
      for (const li of fo.lineItems.nodes) {
        const sku = li.lineItem && li.lineItem.sku ? li.lineItem.sku.trim() : '';
        const line = { location: loc.name, rooftopId, sku, ordered: li.totalQuantity };
        if (!sku) {
          line.status = 'NO_SKU';
          result.problems.push('line without SKU');
        } else {
          try {
            const s = await outletStock(sku, rooftopId, ctx);
            line.partNumber = s.partNumber;
            if (s.error) {
              line.status = 'UNKNOWN';
              line.note = s.error;
              result.problems.push(`${sku}: ${s.error}`);
            } else {
              line.autolineQty = s.qty;
              line.status = s.qty >= li.totalQuantity ? 'OK' : 'SHORT';
              if (line.status === 'SHORT') result.short = true;
            }
          } catch (e) {
            line.status = 'UNKNOWN';
            line.note = e.outage ? 'Autoline unreachable' : e.message;
            result.problems.push(`${sku}: ${line.note}`);
          }
        }
        result.lines.push(line);
      }
    }
    if (result.short) {
      const tag = config.pickupAlertTag;
      if (!order.tags.includes(tag)) await shopify.addTags(order.id, [tag]);
      const txt = result.lines.filter((l) => l.status === 'SHORT').map((l) => `${l.sku} at ${l.location}: ordered ${l.ordered}, Autoline ${l.autolineQty}`).join('; ');
      logger.warn('pickup_stock_short', { orderId: order.id, order: order.name, lines: result.lines });
      await alert('pickup_stock_short', `Pickup order ${order.name} is short at the outlet: ${txt}. Order tagged "${tag}". Please follow up.`, { order: order.name }, { force: true });
    } else if (result.problems.length) {
      logger.warn('pickup_recheck_incomplete', { orderId: order.id, order: order.name, problems: result.problems, lines: result.lines });
      await alert('pickup_recheck_incomplete', `Pickup order ${order.name} could not be fully checked: ${result.problems.join('; ')}`, { order: order.name }, { force: true });
    } else {
      logger.info('pickup_recheck_ok', { orderId: order.id, order: order.name, lines: result.lines });
    }
  }
  store.processed.push(order.id);
  store.checks.push(result);
  save(store);
  return result;
}

function recentChecks(n = 50) {
  return load().checks.slice(-n).reverse();
}

module.exports = { verifyWebhook, recheckOrder, recentChecks };

// ---------- CLI: npm run recheck-order -- 1001   (order number, or gid://shopify/Order/...) ----------
if (require.main === module) {
  (async () => {
    const { validate } = require('./config');
    validate({ needShopify: true });
    const arg = process.argv[2];
    if (!arg) {
      console.error('Usage: npm run recheck-order -- <order number, e.g. 1001>');
      process.exit(1);
    }
    const id = arg.startsWith('gid://') ? arg : await shopify.findOrderIdByName(arg);
    if (!id) throw new Error(`Order ${arg} not found`);
    const r = await recheckOrder(id, { trigger: 'cli', force: true });
    console.log(JSON.stringify(r, null, 2));
    if (config.sync.dryRun && r.short) console.log('\n(DRY_RUN is on: the order tag was only logged, not written.)');
  })().catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
  });
}
