'use strict';
// Registers the Shopify "orders/create" webhook that points to this app.
//   npm run register-webhook -- https://autoline-sync.onrender.com
// The URL must be public HTTPS (Render / server). localhost cannot receive Shopify webhooks.
const { validate } = require('../src/config');
const shopify = require('../src/shopify');

(async () => {
  validate({ needShopify: true });
  const base = (process.argv[2] || '').replace(/\/+$/, '');
  const list = await shopify.listWebhooks();
  console.log('Existing webhooks:');
  list.forEach((w) => console.log(`  ${w.topic}  ${w.url}`));
  if (!list.length) console.log('  (none)');
  if (!base) {
    console.log('\nTo register: npm run register-webhook -- https://YOUR-PUBLIC-URL');
    return;
  }
  if (!/^https:\/\//.test(base)) throw new Error('URL must start with https://');
  const url = base + '/webhooks/orders-create';
  if (list.some((w) => w.topic === 'ORDERS_CREATE' && w.url === url)) {
    console.log(`\nAlready registered: ${url}`);
    return;
  }
  const id = await shopify.createOrdersWebhook(url);
  console.log(`\nRegistered ORDERS_CREATE -> ${url}\n${id}`);
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
