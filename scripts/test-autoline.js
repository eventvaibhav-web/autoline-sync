'use strict';
// Usage: npm run test-autoline -- NKUHD65SLEDT
//        npm run test-autoline -- NKUHD65SLEDT --rooftop SOE4P_PH
//        npm run test-autoline -- --search UHD65
const { config, validate } = require('../src/config');
const autoline = require('../src/autoline');

(async () => {
  try {
    validate({ needShopify: false });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const ri = args.indexOf('--rooftop');
  const rooftop = ri >= 0 ? args.splice(ri, 2)[1] : config.autoline.rooftopId;
  console.log(`Autoline: ${config.autoline.baseUrl}  RooftopId=${rooftop}  UserId=${config.autoline.userId}\n`);
  try {
    if (args[0] === '--search') {
      const r = await autoline.searchParts(args[1] || '', rooftop);
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    const pn = args[0] || 'NKUHD65SLEDT';
    const p = await autoline.loadPart(pn, rooftop);
    console.log('RAW RESPONSE:\n' + JSON.stringify(p.raw, null, 2));
    console.log('\nPARSED:');
    console.log(`  found          : ${p.found} (${p.errorMessage})`);
    console.log(`  description    : ${p.description}`);
    console.log(`  price1         : ${p.price1}   specialPrice: ${p.specialPrice}`);
    console.log(`  totalStockQty  : ${p.totalStockQty}   groupStock: ${p.groupStock}`);
    console.log(`  blockSale      : ${p.blockSale || '(empty)'}`);
    for (const [name, l] of Object.entries(p.locations)) console.log(`  ${name.padEnd(9)}: qty ${l.qty}  bin ${l.bin}`);
    console.log(`\n  => stock that will go to Shopify (STOCK_SOURCE=${config.stockSource}): ${autoline.pickStock(p)}`);
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exit(1);
  }
})();
