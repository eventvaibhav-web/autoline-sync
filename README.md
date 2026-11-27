# Autoline → Shopify Sync

A dependency-free Node.js service that keeps Shopify in line with Autoline:

- **Stock** per Shopify location (from the mapped Autoline rooftops)
- **Price** (Price1, optional special price, VAT added)
- **Product status** (blocked parts are zeroed or set to Draft)
- **Split AC products** (indoor + outdoor + installation sold as one product)
- **Pickup order re-check** (outlet stock is verified when a pickup order arrives)
- **Dashboard** with sign-in (email OTP), products, pickup checks, alerts, logs, settings and user management

Requires Node.js 18 or newer. No npm packages are needed.

## Quick start

```bash
cp .env.example .env                     # then fill in the values
npm run test-autoline -- <PART_NUMBER>   # check the Autoline connection
npm run test-shopify                     # check the Shopify token, currency and locations
npm start                                # dashboard + scheduler on http://localhost:3000
```

Use `DRY_RUN=true` for the first runs: the sync only logs what it would change and writes nothing to Shopify.

## Configuration

All settings live in `.env` (see `.env.example`, every option is commented). Some can also be changed
from the dashboard (Settings page); secrets, URLs, port and host stay in `.env` only.

Required before the first start:

| Setting | Purpose |
|---|---|
| `AUTOLINE_BASE_URL`, `AUTOLINE_USER_ID`, `AUTOLINE_SESSION_ID`, `AUTOLINE_ROOFTOP_ID` | Autoline API access and the main rooftop |
| `SHOPIFY_STORE` + (`SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`, or `SHOPIFY_ADMIN_TOKEN`) | Shopify Admin API access |
| `LOCATION_STOCK_MAP` | Which Autoline rooftop fills which Shopify location |
| `ADMIN_TOKEN` | Long random string, not the example value |

## Commands

| Command | What it does |
|---|---|
| `npm start` | Start the dashboard and the scheduler |
| `npm run sync-once` | One full sync |
| `npm run sync-part -- <SKU>` | Refresh a single SKU |
| `npm run reconcile` | Full reconciliation (also runs nightly) |
| `npm run test-autoline -- <PART>` | Test the Autoline API (`--search <text>` to search) |
| `npm run test-shopify [-- <SKU>]` | Test the Shopify connection |
| `npm run find-parts [-- --apply]` | Find the right Autoline part number for skipped products |
| `npm run apply-category -- <file> [--apply]` | Tag products MDA (delivery only) or SDA (pickup + delivery) |
| `npm run ac-pairs -- <file.xlsx> [--apply]` | Save the AC indoor → outdoor pairs |
| `npm run clear-outlets [-- --apply]` | One-time: set outlet stock to 0 (preview without `--apply`) |
| `npm run register-webhook -- <https://public-url>` | Register the Shopify `orders/create` webhook |
| `npm run recheck-order -- <order number>` | Re-check one pickup order |
| `npm run test-email -- <address>` | Send a test email |

Scripts that change Shopify data run as a preview unless `--apply` is given.

## How a part is matched

1. Variant metafield `autoline.part_number` (full Autoline part number)
2. Explicit Autoline number from `parts-list.csv`
3. Product metafield `autoline.franchise_code`
4. Brand (Vendor) in the franchise master / `FRANCHISE_MAP` with exactly one code

Otherwise the product is reported as `UNMAPPED` and left untouched. Parts removed from the list are set to Draft, never deleted.

## Security notes

- Passwords are stored as scrypt hashes; sign-in uses an emailed one-time code.
- New accounts are limited to `ALLOWED_EMAIL_DOMAINS`.
- Audit logs are admin-only, and emails, IPs and server paths are masked in the dashboard view.
- Serve the app behind a TLS reverse proxy, then set `SECURE_COOKIES=true` and `HSTS=true`.
- Never commit `.env`. See `VAPT-remediation-status.md` for the security review status.

## Runtime files

Written to `DATA_DIR` (default: the project folder): `logs/`, `reports/`, `state.json`, `settings.json`, `users.json`, `ac-pairs.json`.
On a host with an ephemeral disk, point `DATA_DIR` to a persistent volume.