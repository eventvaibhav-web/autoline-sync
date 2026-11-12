'use strict';
// Shopify Admin GraphQL client (API 2025-07). Only touches: variant price/compare-at,
// inventory "available" quantity, product status, and (if enabled) description.
const { config } = require('./config');
const { logger } = require('./logger');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ShopifyError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ShopifyError';
    this.details = details;
  }
}

// ---------- Access token ----------
// Dev Dashboard apps (2026+): Client ID + Secret -> 24h token via client credentials grant (auto-refreshed).
// Legacy admin-created apps: static SHOPIFY_ADMIN_TOKEN.
let tokenCache = { token: null, expiresAt: 0 };
async function getAccessToken(forceRefresh = false) {
  const s = config.shopify;
  if (!s.clientId) return s.token;
  if (!forceRefresh && tokenCache.token && Date.now() < tokenCache.expiresAt - 10 * 60000) return tokenCache.token;
  const res = await fetch(`https://${s.store}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: s.clientId, client_secret: s.clientSecret }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw Object.assign(
      new ShopifyError(`Shopify token request failed (HTTP ${res.status}): ${text.slice(0, 300)}. Check Client ID/Secret and that the app is installed on ${s.store}.`),
      { fatal: true }
    );
  }
  const j = JSON.parse(text);
  tokenCache = { token: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 86399) * 1000 };
  logger.info('shopify_token_refreshed', { scope: j.scope, expiresInSec: j.expires_in });
  return tokenCache.token;
}

async function gql(query, variables = {}) {
  const s = config.shopify;
  const url = `https://${s.store}/admin/api/${s.apiVersion}/graphql.json`;
  let lastErr;
  let refreshed = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const token = await getAccessToken();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 401 && s.clientId && !refreshed) {
        refreshed = true;
        await getAccessToken(true);
        attempt--;
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        const t = await res.text();
        throw Object.assign(new ShopifyError(`Shopify auth failed (HTTP ${res.status}). Check token/scopes. ${t.slice(0, 200)}`), {
          fatal: true,
        });
      }
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.errors && json.errors.length) {
        const throttled = json.errors.some((e) => e.extensions && e.extensions.code === 'THROTTLED');
        if (throttled) throw new Error('THROTTLED');
        throw Object.assign(new ShopifyError(json.errors.map((e) => e.message).join('; '), json.errors), { fatal: true });
      }
      // Gentle pacing if the cost bucket is getting low
      const ts = json.extensions && json.extensions.cost && json.extensions.cost.throttleStatus;
      if (ts && ts.currentlyAvailable < 100) await sleep(1000);
      return json.data;
    } catch (e) {
      lastErr = e;
      if (e.fatal) throw e;
      if (attempt < 3) await sleep(1000 * 2 ** attempt); // 2s, 4s
    }
  }
  throw new ShopifyError(`Shopify request failed after 3 attempts: ${lastErr.message}`);
}

function checkUserErrors(op, payload) {
  const errs = (payload && payload.userErrors) || [];
  if (errs.length) throw new ShopifyError(`${op}: ${errs.map((e) => `${(e.field || []).join('.')} ${e.message}`).join('; ')}`, errs);
}

// ---------- Shop / location ----------
async function getShopInfo() {
  const d = await gql(`{ shop { name currencyCode myshopifyDomain }
    locations(first: 50) { nodes { id name isActive } } }`);
  return { shop: d.shop, locations: d.locations.nodes };
}

// Which Shopify location gets stock from which Autoline rooftop.
// LOCATION_STOCK_MAP wins; otherwise main rooftop -> SHOPIFY_LOCATION_ID (or the only active location).
let cachedTargets = null;
async function getTargetLocations() {
  if (cachedTargets) return cachedTargets;
  const { locations } = await getShopInfo();
  const byId = Object.fromEntries(locations.map((l) => [l.id, l]));
  let targets;
  if (config.locationStockMap.length) {
    targets = config.locationStockMap.map((m) => {
      const l = byId[m.locationId];
      if (!l) throw new ShopifyError(`LOCATION_STOCK_MAP: location ${m.locationId} not found in store`);
      if (!l.isActive) throw new ShopifyError(`LOCATION_STOCK_MAP: location ${l.name} is not active`);
      return { rooftopId: m.rooftopId, locationId: l.id, name: l.name, outlet: config.outletRooftops.includes(m.rooftopId) };
    });
  } else {
    let id = config.shopify.locationId;
    if (!id) {
      const active = locations.filter((l) => l.isActive);
      if (active.length !== 1)
        throw new ShopifyError(
          `Store has ${active.length} active locations. Set LOCATION_STOCK_MAP (or SHOPIFY_LOCATION_ID) in .env. Options: ` +
            active.map((l) => `${l.name}=${l.id}`).join(', ')
        );
      id = active[0].id;
    }
    if (!byId[id]) throw new ShopifyError(`SHOPIFY_LOCATION_ID ${id} not found in store`);
    targets = [{ rooftopId: config.autoline.rooftopId, locationId: id, name: byId[id].name, outlet: false }];
  }
  cachedTargets = targets;
  return targets;
}

// ---------- Variant lookup ----------
async function findVariantsBySku(sku) {
  const safe = sku.replace(/(["\\])/g, '\\$1');
  const d = await gql(
    `query($q: String!) {
      productVariants(first: 10, query: $q) {
        nodes {
          id sku price compareAtPrice
          inventoryItem {
            id tracked
            inventoryLevels(first: 50) { nodes { location { id name } quantities(names: ["available"]) { name quantity } } }
          }
          product { id title status descriptionHtml tags }
        }
      }
    }`,
    { q: `sku:"${safe}"` }
  );
  // Shopify search can be fuzzy: keep only exact SKU matches.
  return d.productVariants.nodes
    .filter((v) => (v.sku || '').trim() === sku)
    .map((v) => {
      const levels = {};
      for (const n of (v.inventoryItem && v.inventoryItem.inventoryLevels.nodes) || []) {
        const q = n.quantities.find((x) => x.name === 'available');
        levels[n.location.id] = { name: n.location.name, available: q ? q.quantity : 0 };
      }
      return {
        id: v.id,
        sku: v.sku,
        price: v.price,
        compareAtPrice: v.compareAtPrice,
        inventoryItemId: v.inventoryItem && v.inventoryItem.id,
        tracked: !!(v.inventoryItem && v.inventoryItem.tracked),
        levels, // locationId -> { name, available }  (only locations where the item is stocked)
        product: v.product,
      };
    });
}

// ---------- Mutations (respect DRY_RUN) ----------
function dry(op, data) {
  if (!config.sync.dryRun) return false;
  logger.info('dry_run_skip_write', { op, ...data });
  return true;
}

async function updateVariantPrices(productId, variantId, price, compareAtPrice) {
  if (dry('price', { variantId, price, compareAtPrice })) return;
  const d = await gql(
    `mutation($pid: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $pid, variants: $variants) {
        productVariants { id price compareAtPrice }
        userErrors { field message }
      }
    }`,
    { pid: productId, variants: [{ id: variantId, price, compareAtPrice }] }
  );
  checkUserErrors('productVariantsBulkUpdate', d.productVariantsBulkUpdate);
}

// quantities: [{ locationId, quantity }]  (one call for all locations)
async function setAvailable(inventoryItemId, quantities) {
  if (!quantities.length) return;
  if (dry('inventory', { inventoryItemId, quantities })) return;
  const d = await gql(
    `mutation($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup { id }
        userErrors { field message code }
      }
    }`,
    {
      input: {
        name: 'available',
        reason: 'correction',
        ignoreCompareQuantity: true,
        quantities: quantities.map((q) => ({ inventoryItemId, locationId: q.locationId, quantity: q.quantity })),
      },
    }
  );
  checkUserErrors('inventorySetQuantities', d.inventorySetQuantities);
}

async function setProductStatus(productId, status) {
  if (dry('status', { productId, status })) return;
  const d = await gql(
    `mutation($product: ProductUpdateInput!) {
      productUpdate(product: $product) { product { id status } userErrors { field message } }
    }`,
    { product: { id: productId, status } }
  );
  checkUserErrors('productUpdate(status)', d.productUpdate);
}

async function setProductDescription(productId, descriptionHtml) {
  if (dry('description', { productId })) return;
  const d = await gql(
    `mutation($product: ProductUpdateInput!) {
      productUpdate(product: $product) { product { id } userErrors { field message } }
    }`,
    { product: { id: productId, descriptionHtml } }
  );
  checkUserErrors('productUpdate(description)', d.productUpdate);
}

module.exports = {
  gql,
  getShopInfo,
  getTargetLocations,
  findVariantsBySku,
  updateVariantPrices,
  setAvailable,
  setProductStatus,
  setProductDescription,
  ShopifyError,
};
