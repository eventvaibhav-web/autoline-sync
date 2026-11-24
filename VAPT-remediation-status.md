# YK Sync — VAPT Remediation Status (v1.27.0)

Assessment: Sveltetech VAPT, 23–24 Nov 2026 — 7 findings (1 High, 3 Medium, 3 Low).
This note records what was fixed in the application code and what still needs the infrastructure/server team.

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| YKA-C-001 | Cleartext HTTP (no HTTPS) | High | App-side done; **HTTPS needs infra** |
| YKA-C-002 | Temp password in API response | Medium | **Fixed (code)** |
| YKA-C-003 | Viewers can read audit logs | Medium | **Fixed (code)** |
| YKA-C-004 | No email-domain enforcement | Medium | **Fixed (code)** |
| YKA-C-005 | Server paths in logs | Low | **Fixed (code)** |
| YKA-C-006 | Missing security headers | Low | **Fixed (code)** |
| YKA-C-007 | Unmasked email/IP in logs | Low | **Fixed (code)** |

## What was fixed in the app (v1.27.0)

**C-002 — Temporary password no longer returned by the API.**
`POST /api/users` (add and reset) no longer returns the temporary password. The password is emailed
directly to the user's address (out-of-band). Only when email (SMTP) is not configured is it shown
to the admin once, in-app, as a fallback.

**C-003 — Audit logs restricted to admins + bounded queries.**
`GET /api/logs` returns `403` for non-admin (viewer) accounts, enforced server-side. The Logs menu is
hidden for viewers. The `limit` parameter is capped at 500.

**C-004 — Email-domain allowlist + cleaner emails.**
New accounts must use an approved domain (`ALLOWED_EMAIL_DOMAINS`, default `almoayyed.com,photonsoftwares.com`).
External domains (e.g. Burp Collaborator) are rejected server-side. Onboarding/reset emails no longer
disclose the administrator's name, and sign-in links use `PUBLIC_BASE_URL` (HTTPS) when configured.

**C-005 / C-007 — Logs masked in the dashboard view.**
Emails are masked (`a***@domain`), IPv4 addresses keep only the first two octets (`223.190.x.x`), and
absolute server paths are reduced to the file name (`report-2026-11-23.csv`). Full detail remains only
in the server-side log files, not exposed through the dashboard.

**C-006 — Security headers added to every response.**
`Content-Security-Policy`, `Permissions-Policy` added alongside the existing `X-Frame-Options`,
`X-Content-Type-Options` and `Referrer-Policy`. `Strict-Transport-Security` (HSTS) is sent only when
`HSTS=true` (enable after HTTPS is live).

**C-001 (app-side) — HTTPS-ready.**
Session cookies get the `Secure` attribute when `SECURE_COOKIES=true`; emails can use an HTTPS base URL
(`PUBLIC_BASE_URL`); the app honours `x-forwarded-proto` behind a reverse proxy.

## Still needs the infrastructure / server team (C-001 High)

The High finding is the lack of HTTPS. The application cannot provide TLS by itself — this is a server task:

1. Put the app behind a TLS reverse proxy (e.g. Nginx) with a valid certificate on a proper domain name.
2. Stop exposing port 3005 directly to the internet; the proxy terminates TLS and forwards to the app.
3. Redirect HTTP → HTTPS.
4. Once HTTPS is live, set `SECURE_COOKIES=true` and `HSTS=true` in `.env` and restart the app.

## New `.env` settings

```
ALLOWED_EMAIL_DOMAINS=almoayyed.com,photonsoftwares.com
PUBLIC_BASE_URL=            # e.g. https://sync.yourdomain.com (after HTTPS)
SECURE_COOKIES=false        # set true after HTTPS
HSTS=false                  # set true after HTTPS
```

## Separately (not part of this report) — credential hygiene

An env file and GitHub tokens were briefly committed/exposed during deployment. Rotate: Shopify Admin
token, Shopify webhook secret, Gmail app password, `ADMIN_TOKEN`, dashboard user passwords, and the
GitHub access tokens. These values should be considered compromised until rotated.
