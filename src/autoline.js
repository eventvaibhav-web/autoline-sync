'use strict';
// Autoline API client: LoadPartsStockRecord / PartsStockSearch with retries.
const { config } = require('./config');

const LOCATIONS = ['Prime1', 'Prime2', 'Prime3', 'DispRtn', 'Insptn', 'Impreset', 'Reprd', 'Insuran', 'Clear'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class AutolineUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AutolineUnavailableError';
    this.outage = true;
  }
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseFloat(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

async function post(endpoint, extraBody, rooftopId) {
  const a = config.autoline;
  const body = { SessionId: a.sessionId, RooftopId: rooftopId || a.rooftopId, UserId: a.userId, ...extraBody };
  let lastErr;
  const delays = a.retryDelaysMs;
  const attempts = delays.length + 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(`${a.baseUrl}/${a.partsPath}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...a.extraHeaders },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(a.timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        if (res.status === 401 || res.status === 403) {
          err.message += ' (access denied - check AUTOLINE_EXTRA_HEADERS / IP whitelist)';
          lastErr = err;
          break; // retrying won't help
        }
        throw err;
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Non-JSON response: ${text.slice(0, 200)}`);
      }
    } catch (e) {
      lastErr = e;
      if (attempt < attempts) await sleep(delays[attempt - 1]); // default 1s, 4s, 16s
    }
  }
  throw new AutolineUnavailableError(`Autoline ${endpoint} (${rooftopId || a.rooftopId}) failed: ${lastErr.message}`);
}

// Real response shape:
// { status, message, data: { errorMessage, errorCode, partsStockRecord: { description, price1, ... } } }
function normalize(raw) {
  let top = Array.isArray(raw) ? raw[0] || {} : raw || {};
  const data = top.data && typeof top.data === 'object' ? top.data : top;
  const rec = data.partsStockRecord && typeof data.partsStockRecord === 'object' ? data.partsStockRecord : null;
  const r = rec || data;
  const errorMessage = String(data.errorMessage ?? top.message ?? '').trim();
  const found = errorMessage.toUpperCase() === 'SUCCESS' && !!rec && top.status !== false;
  const locations = {};
  LOCATIONS.forEach((name, i) => {
    locations[name] = { qty: toNum(r[`quantity_${i + 1}`]), bin: r[`bin_${i + 1}`] ?? '' };
  });
  return {
    found,
    errorMessage,
    errorCode: data.errorCode ?? null,
    description: (r.description ?? '').toString().trim(),
    price1: toNum(r.price1),
    price2: toNum(r.price2),
    price3: toNum(r.price3),
    specialPrice: toNum(r.specialPrice),
    totalStockQty: toNum(r.totalStockQty),
    groupStock: r.groupStock ?? null,
    unitOfStock: r.unitOfStock ?? null,
    vatCode: r.vatCode ?? null,
    blockSale: String(r.blockSale ?? '').trim().toUpperCase(),
    supercededFrom: r.supercededFrom ?? null,
    supercededTo: r.supercededTo ?? null,
    locations,
  };
}

async function loadPart(partNumber, rooftopId) {
  const raw = await post('LoadPartsStockRecord', { PartNumber: partNumber }, rooftopId);
  return { ...normalize(raw), rooftopId: rooftopId || config.autoline.rooftopId, raw };
}

async function searchParts(searchText, rooftopId) {
  return post('PartsStockSearch', { SearchText: searchText }, rooftopId);
}

// Stock for the store, based on STOCK_SOURCE (open question 2).
function pickStock(part) {
  const L = part.locations;
  switch (config.stockSource) {
    case 'prime1':
      return L.Prime1.qty;
    case 'prime1-3':
      return L.Prime1.qty + L.Prime2.qty + L.Prime3.qty;
    default:
      return part.totalStockQty;
  }
}

module.exports = { loadPart, searchParts, pickStock, AutolineUnavailableError, LOCATIONS };
