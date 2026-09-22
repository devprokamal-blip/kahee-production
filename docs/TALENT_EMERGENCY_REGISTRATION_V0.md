# Talent & Worker V1 — Emergency Registration V0 (public P01–P04)

Status: **implemented — awaiting acceptance (2026-09-22).** Full CP2 not started. Built on CP1 (accepted and locked).
Purpose: let KAHE accept real candidate registrations now, through the approved P01–P04 flow, without building
P05+ yet. V0 data is **not disposable**: every row is `source_type = EMERGENCY_V0`, `status = NEW`,
`migration_status = PENDING`, ready to be adopted by Full CP2–CP4 without the candidate registering again.

## Routes
| Route | Access | Purpose |
|---|---|---|
| `/register` → `/register/profile` | public | P01 Profile |
| `/register/experience-skills` | public | P02 Experience & Skills |
| `/register/availability-cv` | public | P03 Availability & CV |
| `/register/success` | public | P04 Confirmation (shows only the candidate's own receipt) |
| `GET /api/public/tw/register/health` | public, rate-limited | readiness: `{ service, status }` only |
| `GET /api/public/tw/register/form-token` | public, rate-limited | signed single-use form token |
| `POST /api/public/tw/register/submit` | public, rate-limited, token in `X-TW-Form-Token` | multipart: `data` (JSON), `cv` (1), `supporting` (0–5) |
| `/tw/emergency-intake` | `tw_emergency_intake:VIEW` + scope ALL | EMERGENCY REGISTRATION INTAKE V0 page (not P05) |
| `GET /api/tw/emergency-intake/registrations` | `tw_emergency_intake:VIEW` + scope ALL | list (search, paging), field-level security applied |
| `GET /api/tw/emergency-intake/export.csv` | `tw_emergency_intake:EXPORT` + scope ALL | CSV, audited as `EXPORT_CSV` before it is sent |

The public API is mounted before the portal-wide write serializer: a slow mobile upload never holds the portal's
write queue; each registration is one self-contained insert transaction.

## Data (TW0002, schema `talent`)
`talent.registration` (profile, experience & skills, availability, consent, duplicate signal) and
`talent.registration_document` (metadata of the stored CV / supporting files). A registration is not a worker
identity: `worker_uuid` stays NULL until verification (a later checkpoint) links or creates the one `talent.worker`;
`registration_id` (KAHE-TAL-YYYY-NNNNNN from `talent.seq_tal`, CP1 format) becomes that worker's REGISTRATION display ID.
Database guarantees: enums and lengths as CHECKs, exactly one PDF CV per registration (deferred constraint trigger +
partial unique index), rows undeletable (triggers), runtime role INSERT/SELECT only. Not collected: NIK, BPJS, bank
account, payroll, medical data, job family. `talent.audit_event` gains exactly one event type: `EXPORT_CSV`.
Rollback: `TW0002_emergency_registration_v0.down.sql` — refuses while any registration or EXPORT_CSV event exists.

## Validation (server is authoritative; unknown fields are refused)
Name 3–120 letters/spaces/.'’-; WhatsApp: country code allow-list (+62 default), Indonesian mobile `8xxxxxxxx`
(normalised to `62…`); email syntax (stored as typed + lower-cased copy); city 2–80; birth date valid, age 17–70
(WIB); education enum; optional major ≤100 and http(s) profile URL ≤200; work experience YES/NO (details required/kept
only for YES); industry enum (optional); EPC YES/NO — NO is accepted; skills ≥1 from 14 codes, free-text
"Keahlian Lainnya" 2–200 (adds OTHER); work status enum; start date today…+366 days; work type SITE/OFFICE ≥1;
≤10 preferred locations; out-of-town and shift YES/NO; consent statement required (records accuracy + processing,
version `EMERG-V0-2026-09-22`, timestamp). Text is NFC-normalised, control characters removed, whitespace collapsed.
Errors are codes per field; input is never echoed.

## Upload security
CV: exactly one, PDF only, ≤5 MB. Supporting: ≤5 files, PDF/JPG/PNG, ≤5 MB each, ≤10 MB total. Extension, declared
MIME and magic bytes must agree; PDFs must end with `%%EOF` and must not contain active content (`/JavaScript`, `/JS`,
`/Launch`, `/EmbeddedFile(s)`, `/RichMedia`, `/XFA`, `/SubmitForm`, `/ImportData`); unexpected file fields are refused.
Files are held in memory, validated, then written with a random name (`<32 hex>.<detected type>`, exclusive create,
mode 0600, directory 0700) under `uploads/talent-registration/` (outside `public/`, git-ignored; override
`KAHE_TW_UPLOAD_DIR`). The original file name is sanitised metadata only. A failed transaction removes written files.
There is no download route in V0.

## Anti-abuse
Rate limits keyed on the validated client IP (`req.ip` under `KAHE_TRUST_PROXY`; the TCP peer in direct mode — a
client-forged `X-Forwarded-For` is never used, see `docs/DEPLOYMENT_INTERNET_V0.md`): submissions 20 / 15 min, tokens 60 / 15 min
(`KAHE_TW_REG_SUBMIT_MAX`, `KAHE_TW_REG_TOKEN_MAX`, `KAHE_TW_REG_SUBMIT_WINDOW_MS`). Form token: HMAC-signed, sent in a
custom header (cross-site pages cannot read or send it), minimum age 3 s (`KAHE_TW_REG_MIN_FILL_MS`), maximum 2 h,
single use (unique nonce). Hidden honeypot field. Duplicates: same normalised WhatsApp or e-mail sets
`possible_duplicate` + `duplicate_signals` — never merged, never disclosed to the applicant. Errors are generic codes;
no stack traces.

## Intake V0 permissions
`tw_emergency_intake` (VIEW, EXPORT) — Workforce Manager and HRD Officer only; Operations Director and all other roles:
none. Data scope ALL required. Columns: registration_id, full_name, whatsapp, email, current_city, latest_position,
registered_at, status, possible_duplicate — through CP1 field-level security. CSV: UTF-8 BOM, formula-neutralised
cells, `no-store`, no file content, audit payload metadata only.

## Tests
`npm run test:talent-registration-v0` (51). CP1 suite remains 91 (version-pinned expectations updated for TW0002).

## Internet deployment
Trusted proxy, HTTPS/session cookies, proxy body limit, private storage, backup runbook, readiness endpoint and the
scoped P01–P04 CSP: `docs/DEPLOYMENT_INTERNET_V0.md` (hardening tests: `npm run test:talent-hardening-v0`).
