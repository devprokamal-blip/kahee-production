#!/bin/bash
# tools/parity/run-golden.sh [suite...] — Golden Payroll Parity: run the UNMODIFIED A3 suite on
# SQLite and the ported suite on PostgreSQL, then compare the complete final business state.
# Needs KAHE_A3_ROOT (extracted A3 package, `npm ci` done) and TEST_DATABASE_ADMIN_URL.
HERE="$(cd "$(dirname "$0")/../.." && pwd)"; OUT="${KAHE_PARITY_OUT:-/tmp/kahe-parity}"; mkdir -p "$OUT"; export KAHE_PARITY_OUT="$OUT"
SUITES="${@:-phase0 phase0b phase1a phase1b phase2a phase2b phase2c phase2d phase2e phase2f phase2g phase2h phase2i e2e phase3a phase3b}"
for s in $SUITES; do
  rm -f "$OUT/$s".*; : > "$OUT/$s.keep"
  (cd "$KAHE_A3_ROOT" && node -r "$HERE/tools/parity/a3-keep-db.js" tests/$s.test.js > "$OUT/$s.a3.log" 2>&1)
  (cd "$HERE" && KAHE_PARITY_GAPLESS_IDS=1 KAHE_TEST_KEEP_DB="$OUT/$s.keep" node tests/$s.test.js > "$OUT/$s.pg.log" 2>&1)
  A=$(grep -oE "[0-9]+ passed, [0-9]+ failed" "$OUT/$s.a3.log" | tail -1); P=$(grep -oE "[0-9]+ passed, [0-9]+ failed" "$OUT/$s.pg.log" | tail -1)
  DB=$(head -1 "$OUT/$s.keep")
  node "$HERE/tools/parity/dump-state.js" sqlite "$OUT/$s.test.db" "$OUT/$s.a3.json" && node "$HERE/tools/parity/dump-state.js" pg "$DB" "$OUT/$s.pg.json" \
    && R=$(node "$HERE/tools/parity/compare-state.js" "$OUT/$s.a3.json" "$OUT/$s.pg.json")
  node "$HERE/tools/parity/dump-bank-export.js" sqlite "$OUT/$s.test.db" "$OUT/$s.a3.bank.json" && node "$HERE/tools/parity/dump-bank-export.js" pg "$DB" "$OUT/$s.pg.bank.json" \
    && B=$(node "$HERE/tools/parity/compare-bank-export.js" "$OUT/$s.a3.bank.json" "$OUT/$s.pg.bank.json")
  echo "$s | A3 $A | PG $P | $R | bank $B" >> "$OUT/golden.log"
  for d in $(cat "$OUT/$s.keep"); do node -e "const {Client}=require('$HERE/node_modules/pg');(async()=>{const c=new Client({connectionString:process.env.TEST_DATABASE_ADMIN_URL});await c.connect();await c.query('DROP DATABASE IF EXISTS $d WITH (FORCE)');await c.end()})()"; done
done
echo DONE >> "$OUT/golden.log"
