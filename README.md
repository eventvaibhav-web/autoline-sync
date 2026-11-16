# Autoline → Shopify Stock Sync

Autoline se stock aur Price1 (aur approval ke baad description) lekar Shopify mein inventory aur price
update karta hai. Har Shopify location ka stock uske apne Autoline RooftopId se aata hai.
Sirf `parts-list.csv` wale parts. Server par chalane ke liye: **DEPLOY.md**.
Koi external npm package nahi — sirf Node.js 18+ chahiye.

## Rules jo app follow karta hai
| Situation | Kya hota hai |
|---|---|
| Price (`PRICE_MODE=price1`, business decision) | price = Price1 (main rooftop SOC1P_PH se), compare-at nahi badalta |
| (`PRICE_MODE=price1_special`) | specialPrice > 0 ho to price = specialPrice, compare-at = Price1 |
| Stock | `LOCATION_STOCK_MAP`: har location = us RooftopId ka totalStockQty (SOE4P_PH → Manama, SOE3P_PH → Gudaibiya) |
| Delivery-only part (CSV mein `Y` ya Shopify tag `delivery-only`) | outlet locations par stock 0, taaki pickup option na aaye |
| Kisi ek outlet rooftop ka Autoline down | sirf us location ka stock unchanged, baaki update |
| price1 = 0 / khali | price change nahi, warning log |
| Negative stock | 0 set, warning log |
| blockSale = "Y" | product DRAFT |
| blockSale wapas "N" | sirf wahi product jo app ne DRAFT kiya tha, pehle wale status par wapas |
| Part list se hata | product DRAFT (delete kabhi nahi) |
| Part Autoline mein nahi mila | Shopify unchanged, skip log |
| SKU Shopify mein nahi / duplicate | skip / error log |
| "Track quantity" off | inventory setting nahi badalti, skip log |
| Autoline down | Shopify unchanged; 60 min baad alert, wapas aane par "recovered" alert |
| Description | sirf `DESCRIPTION_SYNC_ENABLED=true` par |

Har change / skip / error `logs/sync-YYYY-MM-DD.jsonl` mein (365 din rakhe jaate hain).
Store ki koi aur setting / data app nahi chhoota.

## Setup (Windows)
1. **Node.js LTS** install karo (nodejs.org). PowerShell mein `node -v` → v18 ya upar.
2. Zip ko `C:\autoline-sync` mein extract karo. PowerShell: `cd C:\autoline-sync`
3. `npm install` (koi dependency nahi, bas check ho jaata hai)
4. `.env.example` ko copy karke `.env` banao: `copy .env.example .env` aur Notepad/VS Code mein bharo.
5. **Autoline test** (RooftopId confirm karne ke liye):
   ```
   npm run test-autoline -- NKUHD65SLEDT
   ```
   (Ya bina Node: `powershell -ExecutionPolicy Bypass -File scripts\test-autoline.ps1 NKUHD65SLEDT`)
   `found: true (SUCCESS)` aana chahiye.
6. **Shopify custom app**: Admin → Settings → Apps and sales channels → Develop apps → Create an app →
   Configure Admin API scopes: `read_products, write_products, read_inventory, write_inventory, read_locations`
   → Install → Admin API access token copy karke `.env` mein `SHOPIFY_ADMIN_TOKEN` mein daalo.
7. **Shopify test** (read-only):
   ```
   npm run test-shopify -- UHD65SLEDT
   ```
   Currency BHD dikhni chahiye. Agar ek se zyada active location hai to jo location id dikhe use
   `.env` mein `SHOPIFY_LOCATION_ID` mein daalo.
8. Pehli baar `.env` mein `DRY_RUN=true` rakho, phir:
   ```
   npm run sync-once
   ```
   Logs mein dikhega kya change HOGA (Shopify mein kuch nahi likha jaata). Sahi lage to `DRY_RUN=false`
   karke dobara `npm run sync-once`. Shopify admin mein stock/price check karo.
9. **Dashboard + scheduler**: `npm start` → browser mein `http://localhost:3000/?token=ADMIN_TOKEN`.
   "Refresh all now" aur har part ka "Refresh" button test karo. Har 15 min sync aur raat 2 baje
   (Bahrain time) reconciliation chalta hai, jab tak `npm start` chal raha hai.
10. Business list se aur parts `parts-list.csv` mein jodo (format: `shopify_sku,autoline_part_number,delivery_only`,
    jahan delivery_only = Y ya N).
    Restart ki zaroorat nahi — agla sync naya list padhta hai.

## Design-doc features (v1.1)
| Feature | Setting |
|---|---|
| Parts list from Shopify tag `autoline-sync` (instead of CSV) | `PARTS_SOURCE=tag` |
| Autoline key = franchise code + SKU (product metafield `autoline.franchise_code` → brand in metaobject `autoline_franchise` / `FRANCHISE_MAP` → else UNMAPPED) | `FRANCHISE_METAOBJECT_TYPE`, `FRANCHISE_MAP` |
| blockSale = Y → stock 0 at all locations + tag `autoline-blocked` (reversed on N) | `BLOCK_SALE_ACTION=zero` (or `draft`) |
| Delivery-only by tag / product type; outlet stock 0 or inventory deactivated; metafield `ehastock.delivery_only` | `DELIVERY_ONLY_TAG`, `DELIVERY_ONLY_PRODUCT_TYPES`, `DELIVERY_ONLY_ACTION` |
| Variant metafields `autoline.sync_status` (OK / NOT_FOUND / UNMAPPED / BLOCKED) and `autoline.last_synced_at` | `STATUS_METAFIELDS=true` |
| Daily business report (UNMAPPED, NOT_FOUND, BLOCKED, DUPLICATE_SKU, PRICE_SWING, SUPERSEDED, NOT_IN_SHOPIFY) as CSV, download from dashboard, summary alert | nightly reconciliation |
| Price swing flag | `PRICE_SWING_PERCENT=50` |
| Safety buffer per rooftop | `SAFETY_BUFFER=SOE4P_PH=1` |
| Retries 1 / 4 / 16 seconds | `AUTOLINE_RETRY_DELAYS=1,4,16` |

**Shopify scopes needed now:** `read_products, write_products, read_inventory, write_inventory, read_locations, read_metaobjects`.

## Commands
| Command | Kaam |
|---|---|
| `npm start` | dashboard + 15-min sync + nightly reconciliation |
| `npm run sync-once` | ek baar full sync |
| `npm run sync-part -- UHD65SLEDT` | ek SKU refresh |
| `npm run reconcile` | reconciliation abhi chalao |
| `npm run test-autoline -- <PART>` | Autoline raw response dekho (main rooftop) |
| `npm run test-autoline -- <PART> --rooftop SOE4P_PH` | kisi aur rooftop ka response |
| `npm run test-autoline -- --search UHD65` | PartsStockSearch |
| `npm run test-shopify -- <SKU>` | Shopify connection + SKU check (read-only) |

## Alerts
`ALERT_WEBHOOK_URL` mein Teams / Slack / Google Chat incoming webhook daalo — `{"text": "..."}` POST hota hai.
Alerts: Autoline 60 min down, recovered, aur kisi run mein errors. Webhook na ho to alerts log + dashboard mein dikhte hain.

## Business decisions (12 Nov 2026)
- Stock = totalStockQty, Price = Price1, main RooftopId = SOC1P_PH
- Outlet stock: Manama = SOE4P_PH, Gudaibiya = SOE3P_PH
- Delivery-only categories: outlet par stock 0 (Basic plan par pickup chhupane ka yahi tarika hai)

## Basic plan par kya NAHI ho sakta
- Checkout ke time Autoline se **live** stock check. Stock har 15 min mein sync hota hai.
- Checkout mein custom message ya rok ("is outlet par stock nahi, delivery chuno").
  Shopify khud sirf us outlet par pickup dikhata hai jahan stock hai.
- Custom code se pickup option chhupana. Iske liye Shopify Plus chahiye.

## Server par deploy
Poori guide **DEPLOY.md** mein hai: Linux (systemd) aur Windows (NSSM), dono ke liye.

## Files
- `src/config.js` – .env padhta hai · `src/logger.js` – logs, retention, alerts
- `src/autoline.js` – Autoline API · `src/shopify.js` – Shopify GraphQL (2025-07)
- `src/sync.js` – saare rules · `src/server.js` – dashboard + scheduler
- `state.json` (auto) – last run, app ne kaunse products DRAFT kiye, outage status
