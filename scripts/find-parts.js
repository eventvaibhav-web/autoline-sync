'use strict';
// Finds the correct Autoline part number for products that were skipped (NOT_FOUND / UNMAPPED).
// Uses the last sync result in state.json, tries several spellings, and writes a CSV.
//
//   npm run find-parts              -> only search, write CSV (nothing changes in Shopify)
//   npm run find-parts -- --apply   -> also save matches to Shopify:
//      - found with the product's own brand code, brand has several codes (Toshiba TA/TH)
//          -> product metafield autoline.franchise_code (the design-doc way)
//      - found with a corrected spelling or the SKU as-is -> variant metafield autoline.part_number
//   Matches found with ANOTHER brand's code (vendor probably wrong) and MULTIPLE are never saved.
const fs = require('fs');
const path = require('path');
const { config, validate, normBrand } = require('../src/config');
const autoline = require('../src/autoline');
const shopify = require('../src/shopify');
const { loadState } = require('../src/sync');

const APPLY = process.argv.includes('--apply');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function skuVariants(sku) {
  const s = String(sku).toUpperCase().trim();
  const out = new Set([s]);
  const noSpace = s.replace(/\s+/g, '');
  out.add(noSpace);
  const noParen = noSpace.replace(/\(.*?\)$/, '');
  out.add(noParen);
  for (const base of [noSpace, noParen]) {
    out.add(base.replace(/-(I|O|IN|OUT|IDU|ODU)$/, ''));
    out.add(base.replace(/-/g, ''));
  }
  return [...out].filter(Boolean);
}

async function tryPart(pn) {
  try {
    const p = await autoline.loadPart(pn, config.autoline.rooftopId);
    return p.found ? p : null;
  } catch (e) {
    if (e.outage) throw e;
    return null;
  }
}

(async () => {
  try {
    validate({ needShopify: APPLY });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const state = loadState();
  const all = Object.values(state.parts || {});
  const todo = all.filter((p) => p.result === 'skipped' && /UNMAPPED|Autoline:/.test(p.note || '') && !/Autoline unreachable/.test(p.note || ''));
  if (!todo.length) {
    console.log('No skipped NOT_FOUND / UNMAPPED products in state.json. Run a full sync first (dashboard: Refresh all now).');
    return;
  }
  const allCodes = [...new Set(Object.values(config.franchiseMap).flat())];
  console.log(`Checking ${todo.length} skipped products against Autoline ${config.autoline.rooftopId}…`);
  console.log(`Known franchise codes: ${allCodes.join(', ') || '(none - add them in Settings → Franchise codes)'}\n`);

  const rows = [];
  let i = 0;
  for (const p of todo) {
    i++;
    const vendorCodes = config.franchiseMap[normBrand(p.vendor)] || [];
    const vars = skuVariants(p.sku);
    const found = [];
    const tried = new Set();
    const attempt = async (pn, how, safe) => {
      if (tried.has(pn)) return;
      tried.add(pn);
      const r = await tryPart(pn);
      if (r) found.push({ pn, how, safe, own: !how.startsWith('other'), code: (how.match(/code (\w+)/) || [])[1] || '', price1: r.price1, stock: r.totalStockQty, desc: r.description });
      await sleep(50);
    };
    // Stage 1: own brand code(s) + SKU spellings, and SKU spellings as-is
    for (const v of vars) for (const c of vendorCodes) await attempt(c + v, `brand code ${c}`, vendorCodes.length === 1);
    for (const v of vars) await attempt(v, 'SKU as-is', true);
    // Stage 2: other franchise codes (vendor may be wrong) - never applied automatically
    if (!found.length) for (const c of allCodes.filter((x) => !vendorCodes.includes(x))) for (const v of vars.slice(0, 2)) await attempt(c + v, `other code ${c} (check vendor)`, false);

    const status = found.length === 1 ? (found[0].safe ? 'FOUND' : 'CHECK') : found.length > 1 ? 'MULTIPLE' : 'NOT_FOUND';
    rows.push({ p, found, status });
    const f = found[0];
    console.log(`[${i}/${todo.length}] ${status.padEnd(9)} ${p.sku.padEnd(22)} ${(p.vendor || '').padEnd(14)} ${f ? f.pn + '  (' + f.how + ', price1 ' + f.price1 + ')' : ''}${found.length > 1 ? '  +' + (found.length - 1) + ' more' : ''}`);
  }

  // CSV
  const dir = path.join(config.dataDir, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `find-parts-${new Date().toISOString().slice(0, 10)}.csv`);
  const esc = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
  const lines = ['status,shopify_sku,vendor,product,autoline_part_number,how,price1,autoline_stock,autoline_description,other_matches'];
  for (const r of rows) {
    const f = r.found[0] || {};
    lines.push([r.status, r.p.sku, r.p.vendor, r.p.title, f.pn, f.how, f.price1, f.stock, f.desc, r.found.slice(1).map((x) => x.pn).join(' | ')].map(esc).join(','));
  }
  fs.writeFileSync(file, lines.join('\r\n') + '\r\n');

  const count = (s) => rows.filter((r) => r.status === s).length;
  console.log(`\nFOUND ${count('FOUND')} · CHECK ${count('CHECK')} · MULTIPLE ${count('MULTIPLE')} · NOT_FOUND ${count('NOT_FOUND')}`);
  console.log(`CSV: ${file}`);

  if (!APPLY) {
    console.log('\nNothing was changed in Shopify. To save the matches (own brand code / SKU as-is) to Shopify, run:');
    console.log('  npm run find-parts -- --apply');
    return;
  }
  if (config.sync.dryRun) {
    console.log('\nDRY_RUN is on: --apply will only log, not write. Turn dry run off to save.');
  }
  const mfs = [];
  let nCode = 0, nPart = 0;
  for (const r of rows) {
    if (r.found.length !== 1 || !r.found[0].own) continue; // only one match, with the product's own brand code / SKU
    const f = r.found[0];
    const vs = await shopify.findVariantsBySku(r.p.sku);
    if (vs.length !== 1) {
      console.log(`  skip ${r.p.sku}: ${vs.length} variants in Shopify`);
      continue;
    }
    const v = vs[0];
    const vendorCodes = config.franchiseMap[normBrand(r.p.vendor)] || [];
    const exact = f.code && f.pn === f.code + r.p.sku.toUpperCase();
    if (exact && vendorCodes.length > 1) {
      // code + SKU is right, only the brand has several codes -> product metafield (design doc)
      if (v.product.franchiseCode !== f.code) {
        mfs.push({ ownerId: v.product.id, namespace: 'autoline', key: 'franchise_code', type: 'single_line_text_field', value: f.code });
        nCode++;
      }
    } else if (!exact || !f.code) {
      // spelling fix or SKU as-is -> full Autoline number on the variant
      if (v.partNumberOverride !== f.pn) {
        mfs.push({ ownerId: v.id, namespace: 'autoline', key: 'part_number', type: 'single_line_text_field', value: f.pn });
        nPart++;
      }
    }
  }
  if (mfs.length) await shopify.setMetafields(mfs);
  console.log(`\nSaved: ${nCode} product franchise code(s) (autoline.franchise_code), ${nPart} variant part number(s) (autoline.part_number).`);
  console.log('Click "Refresh all now" in the dashboard to sync them.');
  console.log('Not saved: matches with ANOTHER brand code (fix the Vendor in Shopify) and MULTIPLE. See the CSV.');
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
