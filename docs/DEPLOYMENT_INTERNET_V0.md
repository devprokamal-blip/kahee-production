# Emergency Registration V0 — Internet Deployment Hardening

Status: implemented 2026-09-22 — awaiting acceptance. Scope: deploy the ACCEPTED Emergency Registration V0
(public P01–P04 + EMERGENCY REGISTRATION INTAKE V0) safely on the public internet. No business field, page or
migration changed. Full CP2 NOT STARTED.

## 1. Deployment modes and the real client IP

Express derives `req.ip` from the `trust proxy` setting. It is now taken from `KAHE_TRUST_PROXY`
(`lib/deploymentConfig.js`); the previous hard-coded `trust proxy 1` is gone.

| Mode | `KAHE_TRUST_PROXY` | What `req.ip` is | Client-sent `X-Forwarded-For` |
|---|---|---|---|
| Direct / LAN (default when unset) | unset or `off` | the TCP peer address | ignored |
| Nginx (or any proxy) on the same host / one hop | `1` | the address the proxy appended (the real client) | anything the client sent is discarded; only the last hop counts |
| Proxy on other hosts | `10.0.0.5, 172.16.0.0/12` or `loopback` | address supplied by a listed proxy | ignored unless the peer is a listed proxy |
| Cloudflare → Nginx → app | `1` (Nginx is the only hop the app sees) | see §1.3 | Nginx must rewrite it from `CF-Connecting-IP` |

Never set a hop count higher than the number of proxies actually in front of the app: every extra hop lets a client
choose its own IP. `req.ip` feeds the public registration rate limit, the login rate limit and every audit record.

### 1.1 Direct single server (LAN or a VM exposed directly)
```
NODE_ENV=production
SESSION_SECRET=<random, >= 32 chars>        # e.g. node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
KAHE_TRUST_PROXY=off
```
HTTPS must terminate in the app process itself for production (Node behind no proxy has no TLS in this project);
in practice put Nginx in front (§1.2). Plain HTTP is for `NODE_ENV=development` on the LAN only.

### 1.2 Nginx reverse proxy on the same host (recommended)
```
KAHE_TRUST_PROXY=1
```
```nginx
server {
    listen 443 ssl http2;
    server_name talent.example.id;
    ssl_certificate     /etc/letsencrypt/live/talent.example.id/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/talent.example.id/privkey.pem;

    client_max_body_size 24m;            # §4
    client_body_timeout  120s;           # slow mobile uploads

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Forwarded-Proto $scheme;      # REQUIRED: Secure session cookies are issued only when https
        proxy_set_header   X-Forwarded-For   $remote_addr; # REWRITE, do not append ($proxy_add_x_forwarded_for)
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_read_timeout 120s;
        proxy_request_buffering on;
    }
}
server { listen 80; server_name talent.example.id; return 301 https://$host$request_uri; }
```
Bind the app to loopback only (`PORT=3000`, firewall 3000 from the outside).

### 1.3 Cloudflare (or another CDN/WAF) in front of Nginx
Keep `KAHE_TRUST_PROXY=1` (the app still sees exactly one hop: Nginx). In Nginx, restore the visitor address from
Cloudflare and trust only Cloudflare's published ranges (keep the list current — Cloudflare publishes them):
```nginx
real_ip_header CF-Connecting-IP;
set_real_ip_from 173.245.48.0/20;   # …all current Cloudflare IPv4 + IPv6 ranges…
# then the same proxy_set_header lines as §1.2 ($remote_addr is now the visitor)
```
Also restrict origin access to Cloudflare (firewall or Authenticated Origin Pulls) so nobody can reach Nginx directly
with a forged `CF-Connecting-IP`. Cloudflare's own request body limit (100 MB on free plans) is above §4.

## 2. HTTPS and session cookies
* Production (`NODE_ENV=production`): cookies are `HttpOnly; SameSite=Lax; Secure` — always. `KAHE_COOKIE_SECURE=false`
  is refused at startup. The cookie is only issued on an HTTPS request, so the proxy MUST send
  `X-Forwarded-Proto: https` and `KAHE_TRUST_PROXY` must cover it; otherwise logins silently do not stick.
* Development: `HttpOnly; SameSite=Lax`, not Secure, so LAN HTTP keeps working; set `KAHE_COOKIE_SECURE=true` when an
  HTTPS dev proxy is used.
* Production refuses to start (exit 1, reasons printed) when `SESSION_SECRET` is missing/default/short or
  `KAHE_TRUST_PROXY` is unset. Login/RBAC behaviour is unchanged.

## 3. Public rate limits
Submissions 20 / 15 min and form tokens 60 / 15 min per validated client IP (IPv6 keyed on the /64), unchanged
limits (`KAHE_TW_REG_SUBMIT_MAX`, `KAHE_TW_REG_TOKEN_MAX`, `KAHE_TW_REG_SUBMIT_WINDOW_MS`). 429 body is
`{ "error": "RATE_LIMITED", "detail": {} }` — never a hint about existing candidates. The limit store is per process: a
multi-process deployment must run one app process for the public form or add a shared store (not done in V0).

## 4. Body size
Application limits are authoritative: CV ≤ 5 MB, ≤ 5 supporting files ≤ 5 MB each and ≤ 10 MB together, JSON part
≤ 32 KB, ≤ 12 multipart parts. Worst legitimate request ≈ 15 MB + multipart/base64 overhead (< 1 MB). Configure the
proxy limit at **24 MB** (`client_max_body_size 24m`); do not raise the application limits.

## 5. Private upload storage
`uploads/talent-registration/` (or `KAHE_TW_UPLOAD_DIR`) is outside `public/`; Express serves static files from `public/`
only, with `index: false` (no directory listing). Names are random `<32 hex>.<type>`, directory 0700, files 0600, no
download route exists, and `uploads/` is git-ignored and excluded from every source snapshot. Recommended production
location: a dedicated directory outside the application tree, owned by the service user (e.g.
`KAHE_TW_UPLOAD_DIR=/srv/kahe360/private/talent-registration`).

## 6. Backup / restore runbook (operator)
A complete Emergency V0 backup is **two parts**; a database-only backup loses every CV.
1. Database (Talent schema, or the whole database):
   `pg_dump --format=custom --schema=talent --file talent-YYYYMMDD.dump "$DATABASE_MIGRATION_URL"`
   (`npm run db:verify-backup-talent` proves the dump restores identically).
2. Files: `tar -czf talent-uploads-YYYYMMDD.tgz -C "$KAHE_TW_UPLOAD_DIR" .` (default `uploads/talent-registration`).
   Take both within the same maintenance window; keep them together, encrypted at rest, off the web host.
Restore: `pg_restore --exit-on-error --single-transaction --dbname <db> talent-YYYYMMDD.dump`, then extract the tar into
`KAHE_TW_UPLOAD_DIR`, `chmod 700` the directory and `chmod 600` the files, owner = service user. Verify: every
`talent.registration_document.storage_key` exists on disk and its SHA-256 equals the `sha256` column:
`SELECT storage_key, sha256 FROM talent.registration_document` vs `sha256sum <dir>/*`.

## 7. Readiness endpoint
`GET /api/public/tw/register/health` → `200 { "service": "talent-registration-v0", "status": "ready" }` or
`503 { …, "status": "not_ready" }`. Ready = Talent schema at the expected version and upload storage writable.
Nothing else is reported (no reason, path, version, counts). Cached 5 s, `Cache-Control: no-store`, rate-limited with
the form-token limit (60 / 15 min per IP — poll ≤ every 20 s).

## 8. Security headers
Helmet defaults apply portal-wide (nosniff, frame deny, HSTS when https, etc.); the portal-wide CSP stays off as before.
The public P01–P04 pages additionally send a strict, scoped CSP
(`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self';
frame-ancestors 'none'; base-uri 'self'; object-src 'none'`), `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`
and `Cache-Control: no-store`. `register.html` has no inline script/style, so nothing was relaxed to make it render.

## 9. Go-live checklist
- [ ] `NODE_ENV=production`, real `SESSION_SECRET`, `KAHE_TRUST_PROXY` matching the real topology, `DATABASE_SSL` as needed
- [ ] HTTPS certificate, HTTP→HTTPS redirect, proxy sends `X-Forwarded-Proto` and REWRITES `X-Forwarded-For`
- [ ] app port not reachable from the internet; upload directory outside the web root with private permissions
- [ ] `client_max_body_size 24m`, upload/read timeouts ≥ 120 s
- [ ] `/api/public/tw/register/health` returns `ready` through the proxy
- [ ] a test registration from a phone on mobile data: 201, receipt shown, file lands with 0600, intake list shows it
- [ ] rate limit checked from the internet (21st submission in 15 min → 429), login still works (Secure cookie set)
- [ ] backup job for BOTH parts (§6) scheduled and restore rehearsed once
- [ ] monitoring on the readiness endpoint and on disk space of the upload directory
