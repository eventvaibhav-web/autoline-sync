'use strict';
// AC pairs from the business list: indoor Autoline part -> outdoor Autoline part.
// An AC listed here is sold as ONE Shopify product (the indoor one):
//   price = indoor price1 + outdoor price1 + installation part (INSTALLATION_PART, e.g. ZZCARR), then VAT
//   stock = the lower of indoor and outdoor stock.
// Saved by: npm run ac-pairs -- "<file.xlsx>" --apply   (file: DATA_DIR/ac-pairs.json)
const fs = require('fs');
const path = require('path');
const { config } = require('./config');

const FILE = () => path.join(config.dataDir, 'ac-pairs.json');
const norm = (s) => String(s || '').trim().toUpperCase();
let cache = { mtime: -1, map: new Map() };

function load() {
  let st;
  try {
    st = fs.statSync(FILE());
  } catch {
    cache = { mtime: -1, map: new Map() };
    return cache.map;
  }
  if (st.mtimeMs !== cache.mtime) {
    const map = new Map();
    try {
      const d = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      for (const p of d.pairs || []) if (p.indoor && p.outdoor) map.set(norm(p.indoor), norm(p.outdoor));
    } catch {}
    cache = { mtime: st.mtimeMs, map };
  }
  return cache.map;
}
const outdoorFor = (indoorPart) => load().get(norm(indoorPart)) || null;
const isOutdoor = (part) => [...load().values()].includes(norm(part));
// Full list for the dashboard: the saved pairs plus file metadata (empty when not configured yet).
function list() {
  load();
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    return { source: null, savedAt: null, pairs: [] };
  }
  return { source: raw.source || null, savedAt: raw.savedAt || null, pairs: Array.isArray(raw.pairs) ? raw.pairs : [] };
}
function save(pairs, source) {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE() + '.tmp', JSON.stringify({ source, savedAt: new Date().toISOString(), pairs }, null, 2));
  fs.renameSync(FILE() + '.tmp', FILE());
  cache.mtime = -1;
}
module.exports = { outdoorFor, isOutdoor, list, save, count: () => load().size, FILE };
