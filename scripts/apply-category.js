'use strict';
// Reads the business category list (Handle,Title,SKU,Category with MDA / SDA) and marks products in Shopify:
//   MDA = delivery only  -> tag MDA (and remove SDA)     the sync then keeps outlet stock 0, so no pickup
//   SDA = pickup + delivery -> tag SDA (and remove MDA)
// Toshiba has three franchise codes; the product metafield autoline.franchise_code is set from the title:
//   "AC" in the title -> TA,  "TV" in the title -> TV,  anything else -> TH   (only if the product has no code yet)
//
//   npm run apply-category -- inventory_category.csv           -> only check, write CSV (nothing changes)
//   npm run apply-category -- inventory_category.csv --apply   -> write tags / codes to Shopify
// After --apply set in the dashboard: Settings > Delivery only > Delivery-only tag = MDA
const fs = require('fs');
const path = require('path');
const { config, validate, normBrand } = require('../src/config');
const shopify = require('../src/shopify');

const APPLY = process.argv.includes('--apply');
const file = process.argv.slice(2).find((a) => !a.startsWith('--'));

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

function toshibaCode(title) {
  const t = ` ${String(title).toUpperCase().replace(/[^A-Z0-9]+/g, ' ')} `;
  if (/ (AC|A C|SPLIT|AIR CONDITIONER) /.test(t)) return 'TA';
  if (/ (TV|TELEVISION|QLED|LED TV) /.test(t)) return 'TV';
  return 'TH';
}

(async () => {
  if (!file) {
    console.log('Usage: npm run apply-category -- <file.csv> [--apply]');
    process.exit(1);
  }
  validate({ needShopify: true });
  const rows = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const head = rows.shift().map((h) => h.trim().toLowerCase());
  const iSku = head.indexOf('sku'), iCat = head.indexOf('category'), iTitle = head.indexOf('title');
  if (iSku < 0 || iCat < 0) throw new Error('CSV needs the columns SKU and Category');

  const out = [];
  const mfs = [];
  let n = 0;
  for (const r of rows) {
    n++;
    const sku = (r[iSku] || '').trim();
    const cat = (r[iCat] || '').trim().toUpperCase();
    const res = { sku, category: cat, title: r[iTitle] || '', status: '', note: '' };
    out.push(res);
    if (!sku || !['MDA', 'SDA'].includes(cat)) { res.status = 'BAD_ROW'; res.note = 'SKU empty or Category not MDA/SDA'; continue; }
    const vs = await shopify.findVariantsBySku(sku);
    if (vs.length === 0) { res.status = 'NOT_IN_SHOPIFY'; console.log(`[${n}] NOT_IN_SHOPIFY ${sku}`); continue; }
    if (vs.length > 1) { res.status = 'DUPLICATE_SKU'; console.log(`[${n}] DUPLICATE_SKU ${sku}`); continue; }
    const v = vs[0];
    const tags = v.product.tags.map((t) => t.toUpperCase());
    const other = cat === 'MDA' ? 'SDA' : 'MDA';
    const actions = [];
    if (!tags.includes(cat)) actions.push(`tag ${cat}`);
    if (tags.includes(other)) actions.push(`remove tag ${other}`);
    let code = '';
    if (normBrand(v.product.vendor) === 'toshiba' && !v.product.franchiseCode) {
      code = toshibaCode(res.title || v.product.title);
      actions.push(`franchise_code ${code}`);
    }
    res.vendor = v.product.vendor;
    res.status = actions.length ? (APPLY ? 'UPDATED' : 'WILL_UPDATE') : 'OK';
    res.note = actions.join('; ');
    console.log(`[${n}] ${res.status.padEnd(11)} ${sku.padEnd(22)} ${cat} ${res.note}`);
    if (!APPLY || !actions.length) continue;
    if (!tags.includes(cat)) await shopify.addTags(v.product.id, [cat]);
    if (tags.includes(other)) await shopify.removeTags(v.product.id, [other]);
    if (code) mfs.push({ ownerId: v.product.id, namespace: 'autoline', key: 'franchise_code', type: 'single_line_text_field', value: code });
  }
  if (APPLY && mfs.length) await shopify.setMetafields(mfs);

  const dir = path.join(config.dataDir, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, `apply-category-${new Date().toISOString().slice(0, 10)}.csv`);
  const esc = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
  fs.writeFileSync(outFile, ['status,sku,category,vendor,title,note', ...out.map((x) => [x.status, x.sku, x.category, x.vendor, x.title, x.note].map(esc).join(','))].join('\r\n') + '\r\n');
  const c = (s) => out.filter((x) => x.status === s).length;
  console.log(`\nOK ${c('OK')} · ${APPLY ? 'UPDATED ' + c('UPDATED') : 'WILL_UPDATE ' + c('WILL_UPDATE')} · NOT_IN_SHOPIFY ${c('NOT_IN_SHOPIFY')} · DUPLICATE_SKU ${c('DUPLICATE_SKU')} · BAD_ROW ${c('BAD_ROW')}`);
  console.log(`CSV: ${outFile}`);
  if (!APPLY) console.log('\nNothing changed in Shopify. To write: npm run apply-category -- ' + file + ' --apply');
  else {
    if (config.sync.dryRun) console.log('\nDRY_RUN is on: changes were only logged. Turn dry run off and run again.');
    console.log('\nNext: Dashboard > Settings > Delivery only > Delivery-only tag = MDA, then Refresh all.');
  }
})().catch((e) => { console.error('Error: ' + e.message); process.exit(1); });
