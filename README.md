# KAHE 360° Internal Operations Portal — Phase 1

> **DATABASE UPDATE — DB-M1 (2026-09): the application now runs on PostgreSQL 13+ ONLY.** Everything below that mentions SQLite,
> `node:sqlite` or `database/kahe360.db` describes the historical A3 build and is kept for context.
> Setup today: install PostgreSQL → `copy .env.example .env` and fill it in → `npm run db:bootstrap` (first time) → `START_KAHE360.bat`
> (applies migrations, seeds the demo data, starts the server). Details: `README_DEVELOPMENT.md`, `docs/POSTGRES_MIGRATION_RUNBOOK.md`,
> `docs/DATABASE_ARCHITECTURE.md`. Status and evidence: `docs/DB_M1_FINAL_REPORT.md`.


Local/LAN-only Phase 1 build: Login, Authentication, RBAC, SQLite, Home dashboard.

## Requirements
- Node.js 22.5+ (this project targets Node 24) — nothing else. There are no
  native dependencies: the app uses Node's built-in `node:sqlite` module, so
  no Visual Studio Build Tools, Python, C/C++ compiler, or Docker is ever
  needed on Windows. You may see a one-line `ExperimentalWarning: SQLite is
  an experimental feature` in the console — that's expected and harmless.
- Windows laptop (for the .bat scripts) — also runs fine on macOS/Linux via `npm start`

## Install & run (first time)
```
npm install
npm run seed
npm start
```
Then open **http://127.0.0.1:3000**

## Windows one-click scripts
- `START_KAHE360.bat` — installs dependencies and seeds the DB on first run,
  starts the server minimized, waits for it to actually respond, then opens
  your browser at the login page. If Node.js/npm is missing, or `npm install`
  or `npm run seed` fails, or the server doesn't respond within 20 seconds, it
  stops immediately with a clear error and does **not** open the browser.
  Uses `curl` (ships with Windows 10 1803+/Windows 11) to check the server;
  if your PC is missing it, just start the server with `npm start` and open
  `http://127.0.0.1:3000` yourself.
- `STOP_KAHE360.bat` — stops the server (kills the process listening on port 3000).
- `OPEN_KAHE360.bat` — just opens the browser to the login page (use once the
  server is already running).

## Demo accounts
Password for all demo users: **`Kahe360Demo!2026`**

| Email | Role |
|---|---|
| director@kahe360.local | Operations Director (full access) |
| workforce@kahe360.local | Workforce Manager |
| payroll@kahe360.local | Payroll Officer |
| health@kahe360.local | Occupational Health |
| hse@kahe360.local | HSE Officer |

**DEMO CREDENTIALS ONLY — remove/rotate before any production use.**

See `docs/RBAC_MATRIX.md` for exactly which modules each role can see and act on.

## Phone / LAN testing
The server listens on `0.0.0.0:3000`, so it's reachable from any device on the
same Wi-Fi/LAN as your laptop.

1. Start the server (`START_KAHE360.bat` or `npm start`).
2. Check the server console/window — it prints your LAN address, e.g.
   `Phone / LAN: http://192.168.1.23:3000`
3. On your phone (same Wi-Fi), open that address in a browser.

**Windows Firewall:** the first time Node listens on the network, Windows may
prompt "Windows Defender Firewall has blocked some features of this app."
Choose **Allow access** for **Private networks** (do not need Public networks
for LAN-only testing). If you miss the prompt, add an inbound rule for Node.js
on port 3000 via Windows Defender Firewall → Advanced Settings → Inbound Rules.

## Environment variables
Copy `.env.example` to `.env` and adjust if needed:
```
PORT=3000
SESSION_SECRET=change_this_for_development
NODE_ENV=development
```

## Security notes (Phase 1)
- Authentication authority is **server-side** (express-session + SQLite store).
  The frontend never decides who is logged in.
- Passwords are bcrypt-hashed; plaintext is never stored.
- RBAC is enforced in `middleware/permissions.js` on every protected route —
  a hidden sidebar item is UX only, not security.
- Cookies are `HttpOnly`, `SameSite=Lax`. `secure` is `false` because this
  phase is plain HTTP on a local LAN; switch to HTTPS + `secure: true` before
  any non-LAN deployment.
- The SQLite database (`database/kahe360.db`) lives outside `/public` and is
  never served as a static file.
- Google Sign-In on the login page is a **visual placeholder** — it shows a
  toast and does not perform real OAuth.

## Project docs (source of truth)
- `docs/MASTER_SPEC.md`
- `docs/UI_LOCKS.md`
- `docs/RBAC_MATRIX.md`

Read these before extending the project — they're kept up to date automatically
as approved decisions are made; you don't need to maintain them by hand.

## Stop condition for this phase
Login, Auth, RBAC, SQLite, Home, and Local/LAN test mode are complete. Per the
project brief, no further modules (e.g. Command Center) will be built until
explicitly approved.
