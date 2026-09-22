# UI Locks

These are approved and LOCKED. Do not redesign, regenerate, redraw, replace,
crop incorrectly, stretch, recolor, or materially alter without explicit
user approval. Code adapts to the design — not the other way around.

## Actual application assets (used as-is, real image files)
| Asset | File | Used in |
|---|---|---|
| KAHE 360° master logo | `public/assets/kahe360-logo.png` (1568×532) | Login topbar/footer, Home sidebar/hero |
| Home hero (wide) | `public/assets/home-hero-wide.png` (1568×532) | Home page hero banner, `display:block; width:100%; height:auto;` to preserve aspect ratio |

Rule: the logo is never recreated in CSS/text/SVG/AI — always the master file.
Hero image is never redrawn, regenerated, or stretched.

## Visual references (recreated as real HTML/CSS, not shipped as images)
| Reference | Source file | Recreated in |
|---|---|---|
| LOGIN MASTER | `01_LOGIN_MASTER_2K_LOCKED.png` | `public/login.html` + `public/login.css` |
| HOME MASTER | `02_HOME_MASTER_2K_LOCKED.png` | `public/index.html` + `public/styles.css` |

Locked structural decisions taken from these references:
- Login: two-column layout — left hero copy + badge row, right glass sign-in
  panel; topbar brand lockup + ID/EN toggle; footer with logo + legal strap.
- Home: left sidebar (logo + full module nav) + top header (project selector,
  live status, date/time, shift, notifications, profile, ID/EN) + hero banner +
  5-card KPI row + two rows of dashboard panels (Workforce Today, Current
  Operational Gap, Action Required, Manpower Control / Readiness Funnel,
  Ready-By Status, Service Health, Wuhuan Commitments, Upcoming Resource Demand).

## Locked palette
Deep navy / royal blue background (`--navy-950/900/800`), controlled cyan
accent (`--cyan-400`), controlled gold accent (`--gold-500/600`). Status colors:
green = healthy, amber = warning, red = critical, blue = informational.
No heavy glow, no gaming-style UI.

## Change log
- 2026-09-12: Phase 1 initial build. Login + Home locked as above.
- 2026-09-14: HRD & Kontrak module added (`public/hrd-kontrak.html`). Follows
  the same inner-page shell as the other 16 module pages (e.g.
  `talenta-kesiapan.html`): topbar + `page-header` + KPI bar + panels — the
  hero banner is NOT repeated (it is Home-only, per the structural decision
  already established across every other module page). No existing locked
  asset or page was altered.
- 2026-09-14: Timesheet & Absensi module added (`public/timesheet-absensi.html`).
  Same inner-page shell pattern. Approval panel for pending overtime uses the
  same `.action-pk` visual language already established for Home's Action
  Required panel. Table adds Workfront + Shift columns (locked in the
  brainstorm session before build) so the data can later feed Operasi Tenaga
  Kerja's per-workfront and shift-split panels once a planning counterpart
  exists. No existing locked asset or page was altered.
- 2026-09-14: Payroll Configuration module added (`public/payroll-config.html`).
  Same inner-page shell pattern, but the page body is a single panel with a
  new `.pcfg-tabs`/`.pcfg-panel` tab system (6 tabs, one per domain) rather
  than the stacked-panels layout used elsewhere — locked as the pattern for
  any future "one page, many config domains" module. Reuses `.pk-kpi-bar`,
  `.hrd-table`, `.modal-overlay`/`.form-field`, and `.status-badge` from
  earlier modules; only the tab bar itself is new CSS. No existing locked
  asset or page was altered.
- 2026-09-20: Attendance A2 — new page `public/jadwal-kerja.html` (Jadwal & Pola
  Kerja) built from the existing shell, tab and modal conventions; sidebar entry
  added for module `attendance_config`. Timesheet & Absensi table gained
  schedule/expectation columns; no page was redesigned.
- 2026-09-20: Attendance A3 — new page `public/koreksi-absensi.html` (Koreksi &
  Audit Absensi) built from the same approved shell, tab and modal conventions as
  the A2 page; sidebar entry added for module `attendance_correction`. Panels the
  actor may not read are hidden rather than erroring. No existing page redesigned.

## Talent & Worker V1 — KAHE GROUP INDONESIA light shell (separate bounded context)
| Asset | File | Used in |
|---|---|---|
| KAHE GROUP INDONESIA master logo | `public/tw-assets/kahe-group-indonesia-logo.png` (2172×724, sha256 `68bd292b8728c0407f3cd5f8603a1a0beb952c68f4d21922fbe166f948940ed5`, byte-identical to the uploaded master) | Talent shell header |

Rule: used exactly as supplied — never cropped from mockups, redrawn, recreated in CSS/SVG, regenerated, recoloured
or resized out of proportion (`height` set, `width: auto`). The KAHE 360° logo rule above is unchanged.

UI reference: `KAHE_TALENT_WORKER_V1_MOCKUP_MASTER.zip` (P01–P16). P01–P04 use the public registration shell (CP2).
P05–P16 use ONE light internal shell (`modules/talent/views/app-shell.html`, `public/tw-assets/tw-shell.css|js`):
white header (logo · "KAHE Talent Management System" · ID|EN · user), navy sidebar with exactly 9 canonical items —
HOME, DASHBOARD, CANDIDATE REGISTRATION, TALENT POOL, VERIFICATION & SCREENING, DEPLOYMENT & ASSIGNMENT CONTROL,
CONTRACT & PLACEMENT, REPORTS & ANALYTICS, SETTINGS. Historical labels (Talent Bank, Recruitment, Workforce
Planning) are not used. Worker Passport is a detail view, not a sidebar item. Light palette: page `#edf2fa`,
navy ink `#0a2463`, primary `#1152d6`, sidebar `#0b3285 → #061c4e`. The dark KAHE 360 portal palette and files are
unchanged.

- 2026-09-22: Talent & Worker V1 CP1 — light shell foundation (navigation, header, empty states, Home with access
  summary and Worker Passport integration status). No portal page changed. Awaiting acceptance.

## Talent Emergency Registration V0 — public registration shell (P01–P04)
`modules/talent/views/register.html` + `public/tw-assets/register.css|js`: white top bar with the KAHE GROUP INDONESIA
master logo (unchanged file, see above), ID|EN; left pitch column ("BANGUN KARIER ANDA / BERSAMA KAHE GROUP", four
benefits); right white card with 3-step stepper; P04 confirmation card with registration number, name, date and status
"PROFIL DITERIMA — MENUNGGU REVIEW". The mockups' photographic background is NOT shipped (no approved hero asset;
nothing cropped from screenshots) — the stage uses the brand navy gradient until a hero image is approved.
The internal EMERGENCY REGISTRATION INTAKE V0 page is a plain list styled with the light Talent shell stylesheet; it is
not in the canonical sidebar and is not P05.
- 2026-09-22: Emergency Registration V0 public shell added. No portal page and no CP1 shell file changed.
