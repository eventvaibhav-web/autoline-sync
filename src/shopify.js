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
function resetCaches() {
  cachedTargets = null;
}
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
const VARIANT_FIELDS = `
  id sku price compareAtPrice
  syncStatus: metafield(namespace: "autoline", key: "sync_status") { value }
  partNumberMf: metafield(namespace: "autoline", key: "part_number") { value }
  installMf: metafield(namespace: "autoline", key: "installation_charge") { value }
  inventoryItem {
    id tracked
    inventoryLevels(first: 50) { nodes { id location { id name } quantities(names: ["available"]) { name quantity } } }
  }
  product {
    id title status descriptionHtml tags vendor productType
    franchiseCode: metafield(namespace: "autoline", key: "franchise_code") { value }
    deliveryOnlyMf: metafield(namespace: "ehastock", key: "delivery_only") { value }
  }`;

function mapVariant(v) {
  const levels = {};
  for (const n of (v.inventoryItem && v.inventoryItem.inventoryLevels.nodes) || []) {
    const q = n.quantities.find((x) => x.name === 'available');
    levels[n.location.id] = { id: n.id, name: n.location.name, available: q ? q.quantity : 0 };
  }
  const p = v.product;
  return {
    id: v.id,
    sku: (v.sku || '').trim(),
    price: v.price,
    compareAtPrice: v.compareAtPrice,
    syncStatus: v.syncStatus ? v.syncStatus.value : null,
    partNumberOverride: v.partNumberMf ? String(v.partNumberMf.value || '').trim().toUpperCase() : '',
    installationCharge: v.installMf ? Number(v.installMf.value) || 0 : 0,
    inventoryItemId: v.inventoryItem && v.inventoryItem.id,
    tracked: !!(v.inventoryItem && v.inventoryItem.tracked),
    levels, // locationId -> { id, name, available }  (only locations where the item is stocked)
    product: {
      id: p.id,
      title: p.title,
      status: p.status,
      descriptionHtml: p.descriptionHtml,
      tags: p.tags || [],
      vendor: p.vendor || '',
      productType: p.productType || '',
      franchiseCode: p.franchiseCode ? String(p.franchiseCode.value || '').trim().toUpperCase() : '',
      deliveryOnlyMf: p.deliveryOnlyMf ? p.deliveryOnlyMf.value : null,
    },
  };
}

async function findVariantsBySku(sku) {
  const safe = sku.replace(/(["\\])/g, '\\$1');
  const d = await gql(`query($q: String!) { productVariants(first: 10, query: $q) { nodes { ${VARIANT_FIELDS} } } }`, {
    q: `sku:"${safe}"`,
  });
  // Shopify search can be fuzzy: keep only exact SKU matches.
  return d.productVariants.nodes.filter((v) => (v.sku || '').trim() === sku).map(mapVariant);
}

// All variants (with SKU) of products carrying the sync tag. Returns [{ sku }].
async function listTaggedSkus(tag) {
  const out = [];
  let after = null;
  const safe = tag.replace(/(['\\])/g, '\\$1');
  do {
    const d = await gql(
      `query($q: String!, $after: String) {
        products(first: 100, after: $after, query: $q) {
          pageInfo { hasNextPage endCursor }
          nodes { id tags variants(first: 100) { nodes { sku } } }
        }
      }`,
      { q: `tag:'${safe}'`, after }
    );
    for (const p of d.products.nodes) {
      // search is tokenised: double-check the exact tag
      if (!p.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) continue;
      for (const v of p.variants.nodes) if (v.sku && v.sku.trim()) out.push({ sku: v.sku.trim(), productId: p.id });
    }
    after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (after);
  return out;
}

// Franchise master from metaobject entries: [{ code, brand, description }]
async function getFranchiseMaster(type) {
  const out = [];
  let after = null;
  do {
    const d = await gql(
      `query($type: String!, $after: String) {
        metaobjects(type: $type, first: 250, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            code: field(key: "code") { value }
            brand: field(key: "brand") { value }
            description: field(key: "description") { value }
          }
        }
      }`,
      { type, after }
    );
    for (const n of d.metaobjects.nodes) {
      out.push({
        code: n.code && n.code.value ? n.code.value.trim().toUpperCase() : '',
        brand: n.brand && n.brand.value ? n.brand.value.trim() : '',
        description: n.description && n.description.value ? n.description.value.trim() : '',
      });
    }
    after = d.metaobjects.pageInfo.hasNextPage ? d.metaobjects.pageInfo.endCursor : null;
  } while (after);
  return out;
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

async function addTags(id, tags) {
  if (dry('tagsAdd', { id, tags })) return;
  const d = await gql(`mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`, { id, tags });
  checkUserErrors('tagsAdd', d.tagsAdd);
}

async function removeTags(id, tags) {
  if (dry('tagsRemove', { id, tags })) return;
  const d = await gql(`mutation($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { field message } } }`, { id, tags });
  checkUserErrors('tagsRemove', d.tagsRemove);
}

// metafields: [{ ownerId, namespace, key, type, value }] - sent 25 at a time
async function setMetafields(metafields) {
  for (let i = 0; i < metafields.length; i += 25) {
    const chunk = metafields.slice(i, i + 25);
    if (dry('metafieldsSet', { count: chunk.length })) continue;
    const d = await gql(
      `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message code } } }`,
      { m: chunk }
    );
    checkUserErrors('metafieldsSet', d.metafieldsSet);
  }
}

async function deactivateInventory(inventoryLevelId) {
  if (dry('inventoryDeactivate', { inventoryLevelId })) return;
  const d = await gql(
    `mutation($id: ID!) { inventoryDeactivate(inventoryLevelId: $id) { userErrors { field message } } }`,
    { id: inventoryLevelId }
  );
  checkUserErrors('inventoryDeactivate', d.inventoryDeactivate);
}

async function activateInventory(inventoryItemId, locationId) {
  if (dry('inventoryActivate', { inventoryItemId, locationId })) return;
  const d = await gql(
    `mutation($i: ID!, $l: ID!) { inventoryActivate(inventoryItemId: $i, locationId: $l) { inventoryLevel { id } userErrors { field message } } }`,
    { i: inventoryItemId, l: locationId }
  );
  checkUserErrors('inventoryActivate', d.inventoryActivate);
}

// ---------- Orders (pickup re-check) ----------
// Only order id/name, delivery method, location and line items (SKU, qty) are read - no customer data.
async function getOrderForRecheck(orderId) {
  const d = await gql(
    `query($id: ID!) {
      order(id: $id) {
        id name tags
        fulfillmentOrders(first: 10) {
          nodes {
            id status
            deliveryMethod { methodType }
            assignedLocation { location { id name } }
            lineItems(first: 100) { nodes { totalQuantity lineItem { sku } } }
          }
        }
      }
    }`,
    { id: orderId }
  );
  return d.order;
}

async function findOrderIdByName(name) {
  const n = String(name).startsWith('#') ? name : '#' + name;
  const d = await gql(`query($q: String!) { orders(first: 1, query: $q) { nodes { id name } } }`, { q: `name:${n}` });
  return d.orders.nodes[0] ? d.orders.nodes[0].id : null;
}

async function listWebhooks() {
  const d = await gql(`{ webhookSubscriptions(first: 50) { nodes { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } } }`);
  return d.webhookSubscriptions.nodes.map((w) => ({ id: w.id, topic: w.topic, url: w.endpoint && w.endpoint.callbackUrl }));
}

async function createOrdersWebhook(callbackUrl) {
  const d = await gql(
    `mutation($url: URL!) {
      webhookSubscriptionCreate(topic: ORDERS_CREATE, webhookSubscription: { callbackUrl: $url, format: JSON }) {
        webhookSubscription { id }
        userErrors { field message }
      }
    }`,
    { url: callbackUrl }
  );
  checkUserErrors('webhookSubscriptionCreate', d.webhookSubscriptionCreate);
  return d.webhookSubscriptionCreate.webhookSubscription.id;
}

module.exports = {
  gql,
  getShopInfo,
  getTargetLocations,
  resetCaches,
  findVariantsBySku,
  listTaggedSkus,
  getOrderForRecheck,
  findOrderIdByName,
  listWebhooks,
  createOrdersWebhook,
  getFranchiseMaster,
  addTags,
  removeTags,
  setMetafields,
  deactivateInventory,
  activateInventory,
  updateVariantPrices,
  setAvailable,
  setProductStatus,
  setProductDescription,
  ShopifyError,
};
