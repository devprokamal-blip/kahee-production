// modules/talent/lib/uploadGuard.js
// Upload security for the public registration (Emergency Registration V0).
//   * extension, declared MIME type AND file signature (magic bytes) must all agree;
//   * CV: PDF only, <= 5 MB. Supporting documents: PDF / JPG / PNG, <= 5 MB each, <= 5 files, <= 10 MB in total;
//   * PDFs carrying active content (JavaScript, launch actions, embedded files, XFA, rich media) are refused;
//   * the stored name is random (32 hex + extension of the DETECTED type) — the original name is metadata only;
//   * storage is private: outside public/, directory 0700, files 0600, written exclusively (never overwritten).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MB = 1024 * 1024;
const LIMITS = Object.freeze({ fileBytes: 5 * MB, supportingFiles: 5, supportingTotalBytes: 10 * MB });

const TYPES = Object.freeze({
  pdf: { ext: ['.pdf'], mime: ['application/pdf'], contentType: 'application/pdf', stored: 'pdf' },
  jpg: { ext: ['.jpg', '.jpeg'], mime: ['image/jpeg', 'image/pjpeg'], contentType: 'image/jpeg', stored: 'jpg' },
  png: { ext: ['.png'], mime: ['image/png'], contentType: 'image/png', stored: 'png' },
});
const ALLOWED = Object.freeze({ CV: ['pdf'], SUPPORTING: ['pdf', 'jpg', 'png'] });

// Active-content markers in a PDF. Names are matched in the raw bytes; this is conservative by design.
const PDF_ACTIVE = /\/(JavaScript|JS|Launch|EmbeddedFile|EmbeddedFiles|RichMedia|XFA|SubmitForm|ImportData)\b/;

class UploadRejected extends Error {
  constructor(field, reason, status = 400) { super(reason); this.name = 'UploadRejected'; this.field = field; this.reason = reason; this.status = status; }
}

function detectType(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf[0] === 0x89 && buf.subarray(1, 8).toString('latin1') === 'PNG\r\n\x1a\n') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  return null;
}

/** Keep only a safe display name: no path, no control characters, bounded length. Metadata only. */
function safeOriginalName(name) {
  const base = String(name || '').split(/[\\/]/).pop().normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim();
  const cut = base.length > 200 ? base.slice(base.length - 200) : base;
  return cut || 'dokumen';
}

/** Validate one multer memory file for a document kind. Returns the normalised descriptor or throws UploadRejected. */
function inspectFile(file, kind, field) {
  if (!file || !file.buffer || file.size === 0) throw new UploadRejected(field, 'EMPTY_FILE');
  if (file.size > LIMITS.fileBytes) throw new UploadRejected(field, 'FILE_TOO_LARGE', 413);
  const ext = path.extname(String(file.originalname || '')).toLowerCase();
  const detected = detectType(file.buffer);
  const allowed = ALLOWED[kind];
  const byExt = allowed.find((t) => TYPES[t].ext.includes(ext));
  if (!byExt) throw new UploadRejected(field, 'EXTENSION_NOT_ALLOWED');
  if (!TYPES[byExt].mime.includes(String(file.mimetype || '').toLowerCase())) throw new UploadRejected(field, 'MIME_MISMATCH');
  if (detected !== byExt) throw new UploadRejected(field, 'SIGNATURE_MISMATCH');
  if (detected === 'pdf') {
    const text = file.buffer.toString('latin1');
    if (PDF_ACTIVE.test(text)) throw new UploadRejected(field, 'ACTIVE_CONTENT');
    if (!/%%EOF\s*$/.test(text.slice(-1024))) throw new UploadRejected(field, 'MALFORMED_PDF');
  }
  return {
    kind,
    type: detected,
    contentType: TYPES[detected].contentType,
    storageKey: `${crypto.randomBytes(16).toString('hex')}.${TYPES[detected].stored}`,
    originalFilename: safeOriginalName(file.originalname),
    sizeBytes: file.size,
    sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
    buffer: file.buffer,
  };
}

/** Validate the whole upload set. files = multer `req.files` from upload.fields([...]). */
function inspectUploads(files) {
  const cv = (files && files.cv) || [];
  const supporting = (files && files.supporting) || [];
  if (cv.length !== 1) throw new UploadRejected('cv', cv.length ? 'TOO_MANY_FILES' : 'REQUIRED');
  if (supporting.length > LIMITS.supportingFiles) throw new UploadRejected('supporting', 'TOO_MANY_FILES');
  const total = supporting.reduce((s, f) => s + f.size, 0);
  if (total > LIMITS.supportingTotalBytes) throw new UploadRejected('supporting', 'TOTAL_TOO_LARGE', 413);
  return [inspectFile(cv[0], 'CV', 'cv'), ...supporting.map((f) => inspectFile(f, 'SUPPORTING', 'supporting'))];
}

function storageDir() {
  return process.env.KAHE_TW_UPLOAD_DIR || path.join(__dirname, '..', '..', '..', 'uploads', 'talent-registration');
}

function ensureStorage() {
  const dir = storageDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Write exclusively; returns the absolute paths written (for cleanup on rollback). */
function writeFiles(docs) {
  const dir = ensureStorage();
  const written = [];
  try {
    for (const d of docs) {
      const p = path.join(dir, d.storageKey);
      fs.writeFileSync(p, d.buffer, { flag: 'wx', mode: 0o600 });
      written.push(p);
    }
  } catch (err) {
    removeFiles(written);
    throw err;
  }
  return written;
}

function removeFiles(paths) {
  for (const p of paths) { try { fs.unlinkSync(p); } catch (_) { /* already gone */ } }
}

module.exports = { LIMITS, ALLOWED, UploadRejected, detectType, safeOriginalName, inspectFile, inspectUploads,
  storageDir, ensureStorage, writeFiles, removeFiles };
