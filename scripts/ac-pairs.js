'use strict';
// Reads the AC pairs list from the business (Excel: "Sl No", "Part number", "Description", "Cat3")
// and saves indoor -> outdoor pairs for the sync (DATA_DIR/ac-pairs.json).
//
// In the list, a numbered row starts an AC and the next row (no number) is its other unit.
// Indoor / outdoor is read from Cat3 ("... Ind" / "... Out"), or from the -I / -O suffix.
//
// After --apply, the sync treats each listed indoor product as ONE AC:
//   price = indoor price1 + outdoor price1 + installation (INSTALLATION_PART, e.g. ZZCARR), plus VAT
//   stock = the lower of indoor and outdoor stock
//
//   npm run ac-pairs -- "AC list.xlsx"           check only: writes a CSV report, changes nothing
//   npm run ac-pairs -- "AC list.xlsx" --apply   saves the pairs (nothing is written to Shopify by this script)
const fs = require('fs');
const path = require('path');
const { config, validate, normBrand } = require('../src/config');
const acpairs = require('../src/acpairs');

const APPLY = process.argv.includes('--apply');
const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
const norm = (s) => String(s ?? '').replace(/ /g, ' ').trim();

function readGroups(f) {
  const groups = [];
  for (const sheet of require('../src/xlsx').readXlsx(f)) {
    const rows = sheet.rows;
    const hi = rows.findIndex((r) => r.some((c) => /^part\s*number$/i.test(norm(c))));
    if (hi < 0) continue;
    const head = rows[hi].map((c) => norm(c).toLowerCase());
    const col = (re) => head.findIndex((h) => re.test(h));
    const cSl = col(/^sl\.?\s*no/), cPart = col(/^part\s*number$/), cDesc = col(/^desc/), cCat3 = col(/^cat3$/), cCat2 = col(/^cat2$/);
    let g = null;
    for (let i = hi + 1; i < rows.length; i++) {
      const r = rows[i];
      const part = norm(r[cPart]).toUpperCase();
      if (!part) continue;
      const sl = cSl >= 0 ? norm(r[cSl]) : '';
      const unit = { part, desc: norm(r[cDesc]), cat3: cCat3 >= 0 ? norm(r[cCat3]) : '', type: cCat2 >= 0 ? norm(r[cCat2]) : '', row: i + 1, sheet: sheet.name };
      if (sl || !g) {
        g = { no: sl || String(groups.length + 1), units: [] };
        groups.push(g);
      }
      g.units.push(unit);
    }
  }
  return groups;
}

function side(u) {
  if (/\bout\b/i.test(u.cat3)) return 'out';
  if (/\bind\b/i.test(u.cat3)) return 'in';
  if (/-O$/.test(u.part)) return 'out';
  if (/-I$/.test(u.part)) return 'in';
  return '?';
}

async function loadCatalogue() {
  const shopify = require('../src/shopify');
  const bySku = new Map();
  let after = null;
  do {
    const d = await shopify.gql(
      `query($after: String) { products(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { title vendor status variants(first: 100) { nodes { sku } } } } }`,
      { after }
    );
    for (const p of d.products.nodes)
      for (const v of p.variants.nodes) {
        const k = (v.sku || '').trim().toUpperCase();
        if (k && !bySku.has(k)) bySku.set(k, { title: p.title, vendor: p.vendor || '', status: p.status });
      }
    after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (after);
  return bySku;
}
// Shopify SKU = Autoline part number without the 2-letter brand prefix
function inShopify(part, cat) {
  if (!cat) return null;
  return cat.get(part.slice(2)) || cat.get(part) || null;
}

function writeReport(rows) {
  const dir = path.join(config.dataDir, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `ac-pairs-${new Date().toISOString().slice(0, 10)}.csv`);
  const esc = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
  fs.writeFileSync(
    f,
    '﻿' +
      ['status,sl_no,indoor_part,outdoor_part,type,shopify_product,shopify_status,outdoor_in_shopify,note',
        ...rows.map((r) => [r.status, r.no, r.indoor, r.outdoor, r.type, r.product, r.pstatus, r.outShop, r.note].map(esc).join(','))].join('\r\n') + '\r\n',
    'utf8'
  );
  return f;
}

(async () => {
  if (!file || !fs.existsSync(file)) {
    console.error('Usage: npm run ac-pairs -- "<AC list.xlsx>" [--apply]');
    process.exit(1);
  }
  const groups = readGroups(file);
  if (!groups.length) throw new Error('No rows found. The sheet needs a "Part number" column.');

  let cat = null;
  try {
    validate({ needShopify: true });
    cat = await loadCatalogue();
  } catch (e) {
    console.log(`(Shopify not checked: ${e.message})`);
  }

  const rows = [];
  const pairs = [];
  const seen = new Map();
  for (const g of groups) {
    const ins = g.units.filter((u) => side(u) === 'in');
    const outs = g.units.filter((u) => side(u) === 'out');
    const r = { no: g.no, indoor: g.units[0].part, outdoor: g.units[1] ? g.units[1].part : '', type: g.units[0].type, product: '', pstatus: '', outShop: '', note: '' };
    if (g.units.length !== 2 || ins.length !== 1 || outs.length !== 1) {
      r.status = 'PAIR_PROBLEM';
      r.note = g.units.length !== 2 ? `${g.units.length} rows in this AC (expected indoor + outdoor)` : `${ins.length} indoor + ${outs.length} outdoor (expected 1 + 1): ` + g.units.map((u) => `${u.part} [${u.cat3 || '?'}]`).join(', ');
      rows.push(r);
      continue;
    }
    r.indoor = ins[0].part;
    r.outdoor = outs[0].part;
    if (r.indoor.slice(0, 2) !== r.outdoor.slice(0, 2)) r.note = 'indoor and outdoor have different brand prefixes';
    if (seen.has(r.indoor)) {
      r.status = 'DUPLICATE';
      r.note = `indoor already listed in Sl No ${seen.get(r.indoor)}`;
      rows.push(r);
      continue;
    }
    seen.set(r.indoor, g.no);
    const pIn = inShopify(r.indoor, cat);
    const pOut = inShopify(r.outdoor, cat);
    if (cat) {
      r.product = pIn ? pIn.title : '';
      r.pstatus = pIn ? pIn.status : '';
      r.outShop = pOut ? `${pOut.status}: ${pOut.title}` : 'no';
      if (pIn && config.franchiseMap) {
        const codes = config.franchiseMap[normBrand(pIn.vendor)] || [];
        if (codes.length && !codes.includes(r.indoor.slice(0, 2))) r.note = (r.note ? r.note + '; ' : '') + `prefix ${r.indoor.slice(0, 2)} does not match vendor ${pIn.vendor} (${codes.join('/')})`;
      }
      if (pOut && pOut.status === 'ACTIVE') r.note = (r.note ? r.note + '; ' : '') + 'outdoor is also ACTIVE in Shopify (sold twice?) - set it to Draft';
    }
    r.status = !cat ? 'OK' : pIn ? 'OK' : 'NOT_IN_SHOPIFY';
    pairs.push({ no: g.no, indoor: r.indoor, outdoor: r.outdoor, type: r.type, desc: ins[0].desc });
    rows.push(r);
  }

  const count = (s) => rows.filter((r) => r.status === s).length;
  const f = writeReport(rows);
  console.log(`ACs in list: ${groups.length}`);
  console.log(`  OK (pair saved, product found in Shopify): ${count('OK')}`);
  console.log(`  NOT_IN_SHOPIFY (pair saved, product not in Shopify yet): ${count('NOT_IN_SHOPIFY')}`);
  console.log(`  PAIR_PROBLEM (skipped, ask business): ${count('PAIR_PROBLEM')}`);
  console.log(`  DUPLICATE (skipped): ${count('DUPLICATE')}`);
  for (const r of rows.filter((x) => x.status === 'PAIR_PROBLEM' || x.status === 'DUPLICATE')) console.log(`    Sl No ${r.no}: ${r.note}`);
  const warn = rows.filter((r) => r.note && (r.status === 'OK' || r.status === 'NOT_IN_SHOPIFY'));
  if (warn.length) {
    console.log(`  Notes (${warn.length}):`);
    for (const r of warn.slice(0, 30)) console.log(`    Sl No ${r.no} ${r.indoor}: ${r.note}`);
  }
  console.log(`Report: ${f}`);
  if (APPLY) {
    acpairs.save(pairs, path.basename(file));
    console.log(`\nSaved ${pairs.length} AC pairs to ${acpairs.FILE()}. The next sync prices these ACs as indoor + outdoor + ${config.installationPart || 'installation'} + VAT.`);
  } else {
    console.log('\nCheck only. Nothing saved. Run again with --apply to save the pairs.');
  }
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
