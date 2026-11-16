'use strict';
// Usage: npm run test-shopify               (checks token, currency, locations)
//        npm run test-shopify -- UHD65SLEDT (also looks up one SKU, read-only)
const { config, validate } = require('../src/config');
const shopify = require('../src/shopify');

(async () => {
  try {
    validate({ needShopify: true });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  try {
    const { shop, locations } = await shopify.getShopInfo();
    console.log(`Connected: ${shop.name} (${shop.myshopifyDomain})  currency=${shop.currencyCode}`);
    if (shop.currencyCode !== 'BHD') console.warn('  WARNING: store currency is not BHD');
    console.log('\nLocations:');
    locations.forEach((l) => console.log(`  ${l.isActive ? 'active  ' : 'inactive'}  ${l.name.padEnd(30)} ${l.id}`));
    console.log('\nStock will be synced to:');
    for (const t of await shopify.getTargetLocations())
      console.log(`  ${t.name.padEnd(40)} <- Autoline ${t.rooftopId}${t.outlet ? '  (outlet / pickup)' : ''}`);
    const sku = process.argv[2];
    if (sku) {
      const vs = await shopify.findVariantsBySku(sku);
      console.log(`\nSKU ${sku}: ${vs.length} exact match(es)`);
      vs.forEach((v) => {
        console.log(`  ${v.product.title} [${v.product.status}]  price=${v.price} compareAt=${v.compareAtPrice}  tracked=${v.tracked}  tags=${(v.product.tags || []).join('|')}`);
        console.log(`     vendor=${v.product.vendor || '(empty)'}  type=${v.product.productType || '(empty)'}  franchise_code metafield=${v.product.franchiseCode || '(none)'}  sync_status=${v.syncStatus || '(none)'}`);
        for (const l of Object.values(v.levels)) console.log(`     stocked at ${l.name}: available=${l.available}`);
      });
    }
    console.log('\nOK - read-only check, nothing was changed.');
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exit(1);
  }
})();
