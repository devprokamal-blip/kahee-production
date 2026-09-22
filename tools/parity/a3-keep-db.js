// tools/parity/a3-keep-db.js — preload (-r) for the UNMODIFIED A3 suites. They delete their
// SQLite file when they finish; this copies it aside first so its final business state can be
// compared with PostgreSQL. It changes nothing about how the A3 suite runs.
const fs = require('fs'); const path = require('path');
const OUT = process.env.KAHE_PARITY_OUT; const real = fs.unlinkSync;
fs.unlinkSync = function unlinkSync(p) {
  if (OUT && /\.test\.db$/.test(String(p)) && fs.existsSync(p) && fs.statSync(p).size > 0) {
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(p + s)) fs.copyFileSync(p + s, path.join(OUT, path.basename(p) + s));
  }
  return real.apply(this, arguments);
};
