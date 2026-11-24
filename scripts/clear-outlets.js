'use strict';
// One-time cleanup: set the stock of the OUTLET locations (Manama / Gudaibiya) to 0
// for every synced product, WITHOUT touching the Online Store location.
//
// Why this exists: once OUTLET_STOCK_SYNC is OFF, the sync stops writing to the
// outlet locations - but any stock already written to them earlier stays as-is
// (the sync will never touch those locations again, so it cannot zero them either).
// This script does that one-off zeroing. Run it once after turning the outlet
// toggle OFF, then you never need it again.
//
//   npm run clear-outlets              -> preview only: shows what WOULD be set to 0 (writes nothing)
//   npm run clear-outlets -- --apply   -> actually set outlet stock to 0 in Shopify
//
// Notes:
//  - Outlet locations are taken from OUTLET_ROOFTOPS + LOCATION_STOCK_MAP (same as the app).
//  - Online Store location is never changed.
//  - Honors DRY_RUN: with --apply, if DRY_RUN=true nothing is written (a warning is printed).
const { config, validate } = require('../src/config');
const shopify = require('../src/shopify');
const { getPartsList } = require('../src/sync');

const APPLY = process.argv.includes('--apply');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  validate({ needShopify: true });

  // Which Shopify locations are outlets?
  const targets = await shopify.getTargetLocations();
  const outlets = targets.filter((t) => t.outlet);
  if (!outlets.length) {
    console.log('No outlet locations configured (OUTLET_ROOFTOPS is empty). Nothing to clear.');
    return;
  }
  const outletIds = new Set(outlets.map((o) => o.locationId));
  console.log('Outlet locations to zero:');
  for (const o of outlets) console.log('  - ' + o.name + '  (' + o.locationId + ')');
  console.log(APPLY ? '\nMODE: APPLY (will write 0 to Shopify)\n' : '\nMODE: PREVIEW (nothing will be written). Add --apply to actually clear.\n');
  if (APPLY && config.sync.dryRun) {
    console.log('WARNING: DRY_RUN is ON, so --apply will NOT write anything. Turn DRY_RUN off first.\n');
  }

  const list = await getPartsList();
  console.log('Synced products to check: ' + list.length + '\n');

  let productsChanged = 0;
  let levelsZeroed = 0;
  let notFound = 0;
  let scanned = 0;

  for (const item of list) {
    scanned++;
    let variants;
    try {
      variants = await shopify.findVariantsBySku(item.sku);
    } catch (e) {
      console.log('  ! ' + item.sku + ' - lookup failed: ' + e.message);
      continue;
    }
    if (!variants.length) {
      notFound++;
      continue;
    }
    for (const v of variants) {
      if (!v.inventoryItemId) continue;
      // Only outlet levels that currently have a non-zero quantity.
      const toZero = [];
      for (const [locId, lvl] of Object.entries(v.levels || {})) {
        if (outletIds.has(locId) && Number(lvl.available) > 0) {
          toZero.push({ locationId: locId, quantity: 0, name: lvl.name, from: lvl.available });
        }
      }
      if (!toZero.length) continue;
      productsChanged++;
      levelsZeroed += toZero.length;
      for (const q of toZero) {
        console.log('  ' + (APPLY ? 'ZERO ' : 'would zero ') + item.sku + '  ' + q.name + ': ' + q.from + ' -> 0');
      }
      if (APPLY) {
        try {
          await shopify.setAvailable(v.inventoryItemId, toZero.map((q) => ({ locationId: q.locationId, quantity: 0 })));
        } catch (e) {
          console.log('  ! ' + item.sku + ' - write failed: ' + e.message);
        }
        await sleep(120);
      }
    }
  }

  console.log('\n--- Summary ---');
  console.log('  Products scanned: ' + scanned);
  console.log('  Products with outlet stock to clear: ' + productsChanged);
  console.log('  Outlet stock levels ' + (APPLY ? 'set to 0' : 'that would be set to 0') + ': ' + levelsZeroed);
  console.log('  SKUs not found in Shopify: ' + notFound);
  if (!APPLY && levelsZeroed > 0) console.log('\nRun again with  --apply  to actually clear them.');
  if (levelsZeroed === 0) console.log('\nNothing to clear - outlet stock is already 0 everywhere.');
}

main().catch((e) => {
  console.error('clear-outlets failed: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
