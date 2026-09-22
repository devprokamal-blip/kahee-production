// modules/talent/lib/registrationV0.js
// Emergency Registration V0 — server-side validation, normalisation, duplicate signal, persistence, intake list.
// The server is the authority; the browser form only mirrors these rules for convenience.
// Collected: profile, experience & skills, availability, CV + optional supporting documents, consent.
// Never collected: NIK, BPJS, bank account, payroll or medical data, job family. Unknown fields are REFUSED.
const { withTransaction } = require('../../../database/db');
const { formatDisplayId, wibYear } = require('./identity');
const { writeFiles, removeFiles } = require('./uploadGuard');

const CONSENT_VERSION = 'EMERG-V0-2026-09-22';
const SOURCE_TYPE = 'EMERGENCY_V0';

const ENUMS = Object.freeze({
  education_level: ['SD', 'SMP', 'SMA_SMK', 'D1', 'D2', 'D3', 'D4_S1', 'S2', 'S3'],
  total_experience: ['LT_1', '1_3', '3_5', '5_10', 'GT_10'],
  previous_industry: ['OIL_GAS', 'PETROCHEMICAL', 'POWER', 'MINING', 'CONSTRUCTION', 'INFRASTRUCTURE', 'MANUFACTURING', 'OTHER'],
  skills: ['CIVIL', 'MECHANICAL', 'PIPING', 'ELECTRICAL', 'INSTRUMENT', 'HSE', 'QA_QC', 'WELDING', 'OPERATOR', 'LOGISTICS',
    'ADMINISTRATION', 'DRIVER', 'MANDARIN', 'OTHER'],
  current_work_status: ['EMPLOYED', 'NOT_EMPLOYED', 'FRESH_GRADUATE'],
  preferred_work_type: ['SITE', 'OFFICE'],
  yes_no: ['YES', 'NO'],
  country_code: ['62', '60', '65', '63', '66', '84', '86', '91', '971', '966'],
});

const FIELDS = ['full_name', 'whatsapp_country_code', 'whatsapp_number', 'email', 'current_city', 'birth_date',
  'education_level', 'major', 'linkedin_url', 'has_work_experience', 'total_experience', 'latest_position',
  'latest_company', 'previous_industry', 'has_epc_experience', 'skills', 'other_skills', 'current_work_status',
  'available_start_date', 'preferred_work_type', 'preferred_locations', 'willing_out_of_town', 'willing_shift',
  'consent', 'company_website'];

class RegistrationInvalid extends Error {
  constructor(fields) { super('VALIDATION_FAILED'); this.name = 'RegistrationInvalid'; this.fields = fields; }
}

// ---- normalisation ---------------------------------------------------------------------------------------
function cleanText(v) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') return null;   // wrong type
  return v.normalize('NFC').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeWhatsapp(countryCode, number) {
  let d = String(number || '').replace(/[^0-9]/g, '');
  if (countryCode === '62') {
    if (d.startsWith('62')) d = d.slice(2);
    if (d.startsWith('0')) d = d.slice(1);
  } else if (d.startsWith('0')) d = d.slice(1);
  return { national: d, normalized: `${countryCode}${d}` };
}

function normalizeEmail(e) { return String(e || '').trim().toLowerCase(); }

function todayWib(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
function isIsoDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function addYears(iso, n) { const [y, m, d] = iso.split('-').map(Number); return `${String(y + n).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function addDays(iso, n) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .,'’-]*$/u;
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const FREE_TEXT_RE = /^[^<>{}\\]*$/u;

/**
 * Validate + normalise the submitted JSON. Returns the row to insert (without identifiers) or throws RegistrationInvalid
 * with { field: CODE } — codes only, never echoing input back.
 */
function validateRegistration(input, { now = new Date() } = {}) {
  const errors = {};
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RegistrationInvalid({ _form: 'INVALID' });
  for (const k of Object.keys(input)) if (!FIELDS.includes(k)) errors[k] = 'UNKNOWN_FIELD';

  const text = (name, { required = false, min = 1, max, re } = {}) => {
    const v = cleanText(input[name]);
    if (v === null) { errors[name] = 'INVALID'; return null; }
    if (!v) { if (required) errors[name] = 'REQUIRED'; return null; }
    if (v.length < min) { errors[name] = 'TOO_SHORT'; return null; }
    if (max && v.length > max) { errors[name] = 'TOO_LONG'; return null; }
    if (re && !re.test(v)) { errors[name] = 'INVALID'; return null; }
    return v;
  };
  const oneOf = (name, list, { required = true } = {}) => {
    const v = input[name];
    if (v === undefined || v === null || v === '') { if (required) errors[name] = 'REQUIRED'; return null; }
    if (typeof v !== 'string' || !list.includes(v)) { errors[name] = 'INVALID'; return null; }
    return v;
  };
  const yesNo = (name) => { const v = oneOf(name, ENUMS.yes_no); return v === null ? null : (v === 'YES' ? 1 : 0); };
  const date = (name) => {
    const v = input[name];
    if (v === undefined || v === null || v === '') { errors[name] = 'REQUIRED'; return null; }
    if (typeof v !== 'string' || !isIsoDate(v)) { errors[name] = 'INVALID'; return null; }
    return v;
  };
  const list = (name, { allowed, required = false, max, itemMax }) => {
    const v = input[name];
    if (v === undefined || v === null) { if (required) errors[name] = 'REQUIRED'; return []; }
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) { errors[name] = 'INVALID'; return []; }
    const items = [...new Set(v.map((x) => cleanText(x)).filter(Boolean))];
    if (required && !items.length) { errors[name] = 'REQUIRED'; return []; }
    if (max && items.length > max) { errors[name] = 'TOO_MANY'; return []; }
    if (allowed && items.some((x) => !allowed.includes(x))) { errors[name] = 'INVALID'; return []; }
    if (itemMax && items.some((x) => x.length > itemMax || !FREE_TEXT_RE.test(x))) { errors[name] = 'INVALID'; return []; }
    return items;
  };

  // honeypot: humans never see or fill this field
  if (input.company_website !== undefined && cleanText(input.company_website)) errors._form = 'REJECTED';

  // P01 profile
  out.full_name = text('full_name', { required: true, min: 3, max: 120, re: NAME_RE });
  const cc = oneOf('whatsapp_country_code', ENUMS.country_code);
  const rawNumber = cleanText(input.whatsapp_number);
  if (rawNumber === null || !rawNumber) errors.whatsapp_number = rawNumber === null ? 'INVALID' : 'REQUIRED';
  else if (!/^[0-9 ()+-]{6,20}$/.test(rawNumber)) errors.whatsapp_number = 'INVALID';
  else if (cc) {
    const w = normalizeWhatsapp(cc, rawNumber);
    if (!/^[0-9]{6,13}$/.test(w.national) || (cc === '62' && !/^8[0-9]{7,11}$/.test(w.national))) errors.whatsapp_number = 'INVALID';
    else { out.whatsapp_country_code = cc; out.whatsapp_number = w.national; out.whatsapp_normalized = w.normalized; }
  }
  const email = text('email', { required: true, min: 5, max: 254 });
  if (email) {
    const n = normalizeEmail(email);
    if (!EMAIL_RE.test(n)) errors.email = 'INVALID';
    else { out.email = email; out.email_normalized = n; }
  }
  out.current_city = text('current_city', { required: true, min: 2, max: 80, re: FREE_TEXT_RE });
  const birth = date('birth_date');
  if (birth) {
    const today = todayWib(now);
    if (birth > addYears(today, -17)) errors.birth_date = 'TOO_YOUNG';
    else if (birth < addYears(today, -70)) errors.birth_date = 'OUT_OF_RANGE';
    else out.birth_date = birth;
  }
  out.education_level = oneOf('education_level', ENUMS.education_level);
  out.major = text('major', { max: 100, re: FREE_TEXT_RE });
  const li = text('linkedin_url', { max: 200 });
  if (li) {
    let ok = false;
    try { const u = new URL(li); ok = (u.protocol === 'https:' || u.protocol === 'http:') && Boolean(u.hostname) && !u.username && !u.password; } catch (_) { ok = false; }
    if (!ok) errors.linkedin_url = 'INVALID'; else out.linkedin_url = li;
  } else out.linkedin_url = null;

  // P02 experience & skills
  out.has_work_experience = yesNo('has_work_experience');
  if (out.has_work_experience === 1) {
    out.total_experience = oneOf('total_experience', ENUMS.total_experience);
    out.latest_position = text('latest_position', { max: 100, re: FREE_TEXT_RE });
    out.latest_company = text('latest_company', { max: 100, re: FREE_TEXT_RE });
  } else {
    // fresh graduates / no experience: experience details are not kept even if the browser sent them
    out.total_experience = null; out.latest_position = null; out.latest_company = null;
  }
  out.previous_industry = oneOf('previous_industry', ENUMS.previous_industry, { required: false });
  out.has_epc_experience = yesNo('has_epc_experience');   // NO is a valid answer: non-EPC candidates may register
  let skills = list('skills', { allowed: ENUMS.skills, max: ENUMS.skills.length });
  out.other_skills = text('other_skills', { min: 2, max: 200, re: FREE_TEXT_RE });
  if (out.other_skills && !skills.includes('OTHER')) skills = [...skills, 'OTHER'];
  if (skills.includes('OTHER') && !out.other_skills && !errors.other_skills) errors.other_skills = 'REQUIRED';
  if (!skills.length && !errors.skills) errors.skills = 'REQUIRED';
  out.skills = ENUMS.skills.filter((s) => skills.includes(s));   // canonical order

  // P03 availability
  out.current_work_status = oneOf('current_work_status', ENUMS.current_work_status);
  const start = date('available_start_date');
  if (start) {
    const today = todayWib(now);
    if (start < today) errors.available_start_date = 'IN_PAST';
    else if (start > addDays(today, 366)) errors.available_start_date = 'OUT_OF_RANGE';
    else out.available_start_date = start;
  }
  out.preferred_work_type = list('preferred_work_type', { allowed: ENUMS.preferred_work_type, required: true, max: 2 });
  out.preferred_work_type = ENUMS.preferred_work_type.filter((s) => out.preferred_work_type.includes(s));
  out.preferred_locations = list('preferred_locations', { max: 10, itemMax: 60 });
  out.willing_out_of_town = yesNo('willing_out_of_town');
  out.willing_shift = yesNo('willing_shift');

  // consent — one statement covering data accuracy AND processing for recruitment/placement
  if (input.consent !== true) errors.consent = 'REQUIRED';

  if (Object.keys(errors).length) throw new RegistrationInvalid(errors);
  out.consent_accuracy = 1;
  out.consent_processing = 1;
  out.consent_version = CONSENT_VERSION;
  return out;
}

// ---- persistence ------------------------------------------------------------------------------------------
/**
 * Insert one registration + its documents atomically, then write the files, then commit.
 * Returns ONLY what the candidate may see: registration_id, full_name, registered_at (WIB), status.
 */
async function createRegistration(db, row, docs, { nonce, now = new Date() }) {
  let written = [];
  try {
    return await withTransaction(db, async () => {
      const n = Number((await db.prepare(`SELECT nextval('talent.seq_tal') AS n`).get()).n);
      const registrationId = formatDisplayId('REGISTRATION', n, wibYear(now));
      const dup = await db.prepare(`SELECT
          EXISTS (SELECT 1 FROM talent.registration WHERE whatsapp_normalized = ?) AS phone,
          EXISTS (SELECT 1 FROM talent.registration WHERE email_normalized = ?) AS email`).get(row.whatsapp_normalized, row.email_normalized);
      const signals = [...(dup.phone ? ['PHONE'] : []), ...(dup.email ? ['EMAIL'] : [])];
      const reg = await db.prepare(`INSERT INTO talent.registration (registration_id, source_type, status, migration_status,
          full_name, whatsapp_country_code, whatsapp_number, whatsapp_normalized, email, email_normalized, current_city,
          birth_date, education_level, major, linkedin_url, has_work_experience, total_experience, latest_position,
          latest_company, previous_industry, has_epc_experience, skills, other_skills, current_work_status,
          available_start_date, preferred_work_type, preferred_locations, willing_out_of_town, willing_shift,
          consent_accuracy, consent_processing, consent_version, consent_at, submission_nonce, possible_duplicate, duplicate_signals)
        VALUES (?, '${SOURCE_TYPE}', 'NEW', 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?::date, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::text[], ?, ?, ?::date,
          ?::text[], ?::text[], ?, ?, ?, ?, ?, ?::timestamptz, ?, ?, ?::text[])
        RETURNING registration_uuid, registration_id, created_at`).get(
        registrationId, row.full_name, row.whatsapp_country_code, row.whatsapp_number, row.whatsapp_normalized, row.email,
        row.email_normalized, row.current_city, row.birth_date, row.education_level, row.major, row.linkedin_url,
        row.has_work_experience, row.total_experience, row.latest_position, row.latest_company, row.previous_industry,
        row.has_epc_experience, row.skills, row.other_skills, row.current_work_status, row.available_start_date,
        row.preferred_work_type, row.preferred_locations, row.willing_out_of_town, row.willing_shift,
        row.consent_accuracy, row.consent_processing, row.consent_version, now.toISOString(), nonce,
        signals.length ? 1 : 0, signals);
      for (const d of docs) {
        await db.prepare(`INSERT INTO talent.registration_document (registration_uuid, document_kind, storage_key,
            original_filename, content_type, size_bytes, sha256) VALUES (?::uuid, ?, ?, ?, ?, ?, ?)`).run(
          reg.registration_uuid, d.kind, d.storageKey, d.originalFilename, d.contentType, d.sizeBytes, d.sha256);
      }
      written = writeFiles(docs);   // inside the transaction: a failed write rolls the rows back
      return { registration_id: reg.registration_id, full_name: row.full_name, registered_at: formatWib(now), status: 'PROFILE_RECEIVED' };
    });
  } catch (err) {
    removeFiles(written);           // commit failed after the files were written: leave no orphan file
    throw err;
  }
}

function formatWib(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} WIB`;
}

// ---- intake list (EMERGENCY REGISTRATION INTAKE V0 — not P05) ------------------------------------------
// Maps registration columns to field_catalog codes so the CP1 field-level security decides what is returned.
const LIST_FIELDS = Object.freeze([
  ['registration_id', 'registration_id'], ['full_name', 'full_name'], ['whatsapp', 'phone'], ['email', 'email'],
  ['current_city', 'domicile_city'], ['latest_position', 'latest_position'], ['registered_at', 'registered_at'],
  ['status', 'registration_status'], ['possible_duplicate', 'duplicate_flag'],
]);

async function listRegistrations(db, { limit = 50, offset = 0, q = '' } = {}) {
  const lim = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const off = Math.max(Number.parseInt(offset, 10) || 0, 0);
  const term = cleanText(typeof q === 'string' ? q : '') || '';
  const where = term ? `WHERE registration_id ILIKE ? OR full_name ILIKE ? OR email_normalized ILIKE ? OR whatsapp_normalized LIKE ?` : '';
  const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const params = term ? [like, like, like, `%${term.replace(/[^0-9]/g, '') || '§'}%`] : [];
  const total = Number((await db.prepare(`SELECT count(*)::int AS n FROM talent.registration ${where}`).get(...params)).n);
  const rows = await db.prepare(`SELECT registration_id, full_name, '+' || whatsapp_normalized AS whatsapp, email, current_city,
      latest_position, created_at, status, possible_duplicate FROM talent.registration ${where}
      ORDER BY created_at DESC, registration_id DESC LIMIT ${lim} OFFSET ${off}`).all(...params);
  return { total, limit: lim, offset: off, rows };
}

function toCatalogRecord(r) {
  return { registration_id: r.registration_id, full_name: r.full_name, phone: r.whatsapp, email: r.email,
    domicile_city: r.current_city, latest_position: r.latest_position, registered_at: formatWib(new Date(`${String(r.created_at).replace(' ', 'T')}Z`)),
    registration_status: r.status, duplicate_flag: Number(r.possible_duplicate) === 1 ? 'YES' : 'NO' };
}

module.exports = { CONSENT_VERSION, SOURCE_TYPE, ENUMS, FIELDS, RegistrationInvalid, cleanText, normalizeWhatsapp,
  normalizeEmail, todayWib, validateRegistration, createRegistration, listRegistrations, LIST_FIELDS, toCatalogRecord, formatWib };
