'use strict';
// Marks Shopify products as MDA (delivery only) or SDA (pickup + delivery) from the business list.
//
// Accepted files:
//   - .xlsx from the business (columns "Part number" + "Cat", every sheet is read), e.g. Stock_Report_MDA_SDA.xlsx
//       "Part number" = Autoline part number WITH franchise prefix (NKUHD65SLEDT). The Shopify SKU is the part
//       number without the 2-letter prefix (UHD65SLEDT), as agreed with Almoayyed. The prefix must match the
//       product's brand code (Vendor -> FRANCHISE_MAP); otherwise the row is reported and nothing is changed.
//   - .csv with columns "SKU" + "Category" (Shopify SKU, as in inventory_category.csv)
//   - .csv with columns "Part number" + "Cat"
//
// What it does per matched product:
//   MDA -> tag MDA (and remove SDA)      SDA -> tag SDA (and remove MDA)
//   Toshiba without a code -> product metafield autoline.franchise_code = prefix from the list (TA / TH / TV)
//
//   npm run apply-category -- Stock_Report_MDA_SDA.xlsx            check only, writes a CSV report, changes nothing
//   npm run apply-category -- Stock_Report_MDA_SDA.xlsx --apply    writes tags / codes to Shopify
//   npm run apply-category -- --toshiba [--apply]                  Toshiba codes from the product title (no file)
//
// The sync needs DELIVERY_ONLY_TAG=MDA (Settings > Delivery only).
const fs = require('fs');
const path = require('path');
const { config, validate, normBrand } = require('../src/config');
const shopify = require('../src/shopify');

const APPLY = process.argv.includes('--apply');
const file = process.argv.slice(2).find((a) => !a.startsWith('--'));

// ---------------------------------------------------------------- input
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

// -> [{ kind: 'sku' | 'part', value, category, title, source }]
function readList(f) {
  const tables = [];
  if (/\.xlsx$/i.test(f)) {
    for (const s of require('../src/xlsx').readXlsx(f)) tables.push({ name: s.name, rows: s.rows });
  } else {
    tables.push({ name: path.basename(f), rows: parseCsv(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) });
  }
  const out = [];
  for (const t of tables) {
    const hi = t.rows.findIndex((r) => r.some((c) => /^(sku|part ?number|part no\.?)$/i.test(String(c).trim())));
    if (hi < 0) continue; // sheet without a header we know
    const head = t.rows[hi].map((h) => String(h).trim().toLowerCase());
    const iSku = head.indexOf('sku');
    const iPart = head.findIndex((h) => /^(part ?number|part no\.?)$/.test(h));
    const iCat = head.findIndex((h) => h === 'category' || h === 'cat');
    const iTitle = head.findIndex((h) => h === 'title' || h === 'description');
    if (iCat < 0) throw new Error(`Sheet "${t.name}": no Category / Cat column`);
    for (let r = hi + 1; r < t.rows.length; r++) {
      const row = t.rows[r];
      const sku = iSku >= 0 ? String(row[iSku] || '').trim() : '';
      const part = iPart >= 0 ? String(row[iPart] || '').trim() : '';
      const category = String(row[iCat] || '').trim().toUpperCase();
      if (!sku && !part) continue;
      out.push({
        kind: sku ? 'sku' : 'part',
        value: sku || part,
        category,
        title: iTitle >= 0 ? String(row[iTitle] || '').trim() : '',
        source: `${t.name}!${r + 1}`,
      });
    }
  }
  if (!out.length) throw new Error('No rows found. The file needs a "SKU" or "Part number" column and a "Category" or "Cat" column.');
  return out;
}

// ---------------------------------------------------------------- Shopify catalogue (read once)
async function loadCatalogue() {
  const products = [];
  let after = null;
  do {
    const d = await shopify.gql(
      `query($after: String) { products(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id title vendor tags
          code: metafield(namespace: "autoline", key: "franchise_code") { value }
          variants(first: 100) { nodes { sku } } } } }`,
      { after }
    );
    for (const p of d.products.nodes) {
      products.push({
        id: p.id, title: p.title, vendor: p.vendor || '', tags: p.tags || [],
        code: p.code && p.code.value ? String(p.code.value).trim().toUpperCase() : '',
        skus: p.variants.nodes.map((v) => (v.sku || '').trim()).filter(Boolean),
      });
    }
    after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (after);
  const bySku = new Map();
  for (const p of products) for (const s of p.skus) {
    const k = s.toUpperCase();
    if (!bySku.has(k)) bySku.set(k, []);
    bySku.get(k).push(p);
  }
  return { products, bySku };
}

const codesOf = (p) => {
  if (p.code) return [p.code];
  return config.franchiseMap[normBrand(p.vendor)] || [];
};

// part number with prefix -> product, with checks
function matchPart(part, cat) {
  const P = part.toUpperCase();
  const prefix = P.slice(0, 2);
  const tries = [];
  if (/^[A-Z]{2}/.test(P) && P.length > 2) tries.push({ sku: P.slice(2), how: 'prefix' });
  tries.push({ sku: P, how: 'as-is' });
  for (const t of tries) {
    const hit = cat.bySku.get(t.sku);
    if (!hit) continue;
    if (hit.length > 1) return { status: 'DUPLICATE_SKU', sku: t.sku, note: `${hit.length} products have SKU ${t.sku}` };
    const p = hit[0];
    const codes = codesOf(p);
    if (t.how === 'prefix' && codes.length && !codes.includes(prefix)) {
      return { status: 'CODE_MISMATCH', sku: t.sku, product: p, note: `list prefix ${prefix}, product brand "${p.vendor}" uses ${codes.join('/')} - not changed` };
    }
    return { status: 'MATCH', sku: t.sku, product: p, prefix: t.how === 'prefix' ? prefix : '' };
  }
  return { status: 'NOT_IN_SHOPIFY' };
}

function toshibaCode(title) {
  const t = ` ${String(title).toUpperCase().replace(/[^A-Z0-9]+/g, ' ')} `;
  if (/ (AC|A C|SPLIT|AIR CONDITIONER) /.test(t)) return 'TA';
  if (/ (TV|TELEVISION|QLED|LED TV) /.test(t)) return 'TV';
  return 'TH';
}

function writeReport(name, rows) {
  const dir = path.join(config.dataDir, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${name}-${new Date().toISOString().slice(0, 10)}.csv`);
  const esc = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
  fs.writeFileSync(f, '﻿' + ['status,list_value,category,shopify_sku,product,vendor,note,source',
    ...rows.map((r) => [r.status, r.value, r.category, r.sku, r.product, r.vendor, r.note, r.source].map(esc).join(','))].join('\r\n') + '\r\n', 'utf8');
  return f;
}

// ---------------------------------------------------------------- --toshiba (no file)
async function toshibaAll() {
  validate({ needShopify: true });
  const { products } = await loadCatalogue();
  const mfs = [];
  for (const p of products) {
    if (normBrand(p.vendor) !== 'toshiba' || p.code) continue;
    if (!p.tags.some((t) => t.toLowerCase() === config.syncTag.toLowerCase())) continue;
    const code = toshibaCode(p.title);
    console.log(`${APPLY ? 'SET ' : 'WILL'} ${code}  ${p.title}`);
    mfs.push({ ownerId: p.id, namespace: 'autoline', key: 'franchise_code', type: 'single_line_text_field', value: code });
  }
  if (APPLY && mfs.length) await shopify.setMetafields(mfs);
  console.log(`\n${mfs.length} Toshiba products ${APPLY ? 'updated' : 'will be updated'}.`);
  if (!APPLY) console.log('Nothing changed. To write: npm run apply-category -- --toshiba --apply');
  else if (config.sync.dryRun) console.log('DRY_RUN is on: changes were only logged.');
}

// ---------------------------------------------------------------- main
async function main() {
  if (process.argv.includes('--toshiba')) return toshibaAll();
  if (!file) {
    console.log('Usage: npm run apply-category -- <file.xlsx|file.csv> [--apply]   or   npm run apply-category -- --toshiba [--apply]');
    process.exit(1);
  }
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  validate({ needShopify: true });
  const list = readList(file);
  console.log(`List: ${list.length} rows from ${path.basename(file)}. Reading Shopify products...`);
  const cat = await loadCatalogue();
  console.log(`Shopify: ${cat.products.length} products.\n`);

  // 1) match every row
  const report = [];
  const perProduct = new Map(); // id -> { product, cats:Set, prefixes:Set, rows:[] }
  const seen = new Map();
  for (const row of list) {
    const r = { value: row.value, category: row.category, source: row.source, sku: '', product: '', vendor: '', note: '' };
    report.push(r);
    if (!['MDA', 'SDA'].includes(row.category)) { r.status = 'BAD_ROW'; r.note = 'Category is not MDA or SDA'; continue; }
    const key = row.value.toUpperCase();
    if (seen.has(key)) {
      if (seen.get(key) !== row.category) { r.status = 'LIST_CONFLICT'; r.note = `same part listed as ${seen.get(key)} and ${row.category}`; }
      else { r.status = 'REPEATED'; r.note = 'same part listed twice (same category)'; }
      continue;
    }
    seen.set(key, row.category);
    let m;
    if (row.kind === 'sku') {
      const hit = cat.bySku.get(key);
      m = !hit ? { status: 'NOT_IN_SHOPIFY' } : hit.length > 1 ? { status: 'DUPLICATE_SKU', sku: key, note: `${hit.length} products have this SKU` } : { status: 'MATCH', sku: key, product: hit[0], prefix: '' };
    } else m = matchPart(row.value, cat);
    r.status = m.status;
    r.sku = m.sku || '';
    r.note = m.note || '';
    if (m.product) { r.product = m.product.title; r.vendor = m.product.vendor; }
    if (m.status !== 'MATCH') continue;
    const e = perProduct.get(m.product.id) || { product: m.product, cats: new Set(), prefixes: new Set(), rows: [] };
    e.cats.add(row.category);
    if (m.prefix) e.prefixes.add(m.prefix);
    e.rows.push(r);
    perProduct.set(m.product.id, e);
  }

  // 2) decide per product
  const mfs = [];
  let changed = 0;
  for (const e of perProduct.values()) {
    const p = e.product;
    if (e.cats.size > 1) {
      for (const r of e.rows) { r.status = 'PRODUCT_CONFLICT'; r.note = 'variants of this product are listed as both MDA and SDA - not changed'; }
      continue;
    }
    const cat1 = [...e.cats][0];
    const other = cat1 === 'MDA' ? 'SDA' : 'MDA';
    const tagsU = p.tags.map((t) => t.toUpperCase());
    const actions = [];
    if (!tagsU.includes(cat1)) actions.push(`tag ${cat1}`);
    if (tagsU.includes(other)) actions.push(`remove ${other}`);
    let code = '';
    if (normBrand(p.vendor) === 'toshiba' && !p.code) {
      code = e.prefixes.size === 1 ? [...e.prefixes][0] : toshibaCode(p.title);
      actions.push(`franchise_code ${code}`);
    }
    const status = actions.length ? (APPLY ? 'UPDATED' : 'WILL_UPDATE') : 'OK';
    for (const r of e.rows) { r.status = status; r.note = actions.join('; ') || 'already correct'; }
    console.log(`${status.padEnd(11)} ${cat1}  ${p.title}${actions.length ? '  -> ' + actions.join('; ') : ''}`);
    if (!actions.length) continue;
    changed++;
    if (!APPLY) continue;
    if (!tagsU.includes(cat1)) await shopify.addTags(p.id, [cat1]);
    if (tagsU.includes(other)) await shopify.removeTags(p.id, p.tags.filter((t) => t.toUpperCase() === other));
    if (code) mfs.push({ ownerId: p.id, namespace: 'autoline', key: 'franchise_code', type: 'single_line_text_field', value: code });
  }
  if (APPLY && mfs.length) await shopify.setMetafields(mfs);

  // 3) synced products that are not in the list
  const listed = new Set(perProduct.keys());
  const tag = config.syncTag.toLowerCase();
  for (const p of cat.products) {
    if (listed.has(p.id) || !p.tags.some((t) => t.toLowerCase() === tag)) continue;
    const tagsU = p.tags.map((t) => t.toUpperCase());
    report.push({ status: 'SYNCED_NOT_IN_LIST', value: '', category: tagsU.includes('MDA') ? 'MDA' : tagsU.includes('SDA') ? 'SDA' : '', sku: p.skus.join(' | '), product: p.title, vendor: p.vendor, note: 'product has the sync tag but is not in this list (left as it is)', source: '' });
  }

  const f = writeReport('apply-category', report);
  const count = (s) => report.filter((r) => r.status === s).length;
  console.log('\nRows: ' + ['OK', APPLY ? 'UPDATED' : 'WILL_UPDATE', 'NOT_IN_SHOPIFY', 'CODE_MISMATCH', 'DUPLICATE_SKU', 'PRODUCT_CONFLICT', 'LIST_CONFLICT', 'REPEATED', 'BAD_ROW']
    .map((s) => `${s} ${count(s)}`).join(' · '));
  console.log(`Products to change: ${changed} · Synced products not in the list: ${count('SYNCED_NOT_IN_LIST')}`);
  console.log(`Report: ${f}`);
  if (!APPLY) console.log(`\nNothing changed in Shopify. To write: npm run apply-category -- "${file}" --apply`);
  else if (config.sync.dryRun) console.log('\nDRY_RUN is on: changes were only logged. Turn dry run off and run again.');
  else console.log('\nDone. Make sure Settings > Delivery only > Delivery-only tag = MDA.');
}

main().catch((e) => { console.error('Error: ' + e.message); process.exit(1); });
