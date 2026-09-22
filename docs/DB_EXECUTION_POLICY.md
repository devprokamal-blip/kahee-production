# Database Execution Policy for the Payroll Calculation Engine

> **DB-M1 note:** the five rules below are unchanged and still binding on PostgreSQL. What changed is the mechanism named in them:
> `busy_timeout` → PostgreSQL `lock_timeout` (5 s); `SQLITE_BUSY` → SQLSTATE `40001` / `40P01` / `55P03`; `SQLITE_BUSY_EXHAUSTED` → `DB_BUSY_EXHAUSTED`;
> `withTransaction` / `withRetry` are asynchronous (`await`) and pin one pooled connection per transaction. A lost connection is never retried.

_Written during Phase 0B (2026-09-14), before the engine exists, because these
rules constrain how the engine may be built — they are not a later
optimisation. Any engine implementation that violates them should be rejected
in review._

## Why this document exists

`node:sqlite` is synchronous and single-writer. Before Phase 0B, `busy_timeout`
was 0: a second writer failed immediately rather than waiting. That is now
fixed (5000 ms + a bounded application retry, see `database/init-db.js`), but
the fix only makes *short* writes safe. A payroll run is not a short write, and
no timeout value makes one giant transaction across thousands of employees
acceptable.

## The five rules

### 1. No single transaction across the whole run

A run over thousands of employees must NOT be wrapped in one
`withTransaction`. Holding the write lock for the duration would make every
concurrent timesheet save, approval, and configuration change fail — and a
crash at 90% would roll back everything with nothing to show for it.

**Instead:** one transaction per bounded chunk of employees (start at 50–200
and measure). Each chunk commits independently.

### 2. Chunk boundaries are explicit and durable

The run must record its own progress — which employees are done, which chunk
is next — in the database, inside the same transaction that writes those
employees' results. Progress tracked only in memory is lost on restart and
invites double-payment.

```
withTransaction(db, () => {
  writeLinesFor(chunk);          // the financial rows
  markChunkComplete(runId, n);   // the progress marker — SAME transaction
});
```

Never write results in one transaction and progress in another.

### 3. Idempotency: a re-run must not double-pay

`UNIQUE(run_id, employee_id)` on `payroll_run_lines` is the structural
guarantee (see the original audit §D). The engine must additionally:

- treat "line already exists for this employee in this run" as **skip**, not
  as an error and not as a second insert;
- derive nothing from wall-clock time or insertion order.

An interrupted run resumed from its last completed chunk must produce exactly
the same result as an uninterrupted one.

### 4. Restartability

A run that dies mid-way stays in `Calculated` (or `Draft`) with its completed
chunks intact. Resuming continues from the first incomplete chunk. A run may
only advance to `Finalized` when every eligible employee has a line — that
completeness check is a validation gate, not an assumption.

### 5. Retry wraps the whole unit of work, never a fragment

`withRetry(fn)` re-executes `fn` from the start. `fn` must therefore be the
entire `withTransaction` call for one chunk:

```
withRetry(() => withTransaction(db, () => processChunk(chunk)));   // correct
withTransaction(db, () => withRetry(() => partialWrite()));        // WRONG
```

The wrong form retries half a transaction, which is precisely how partial
financial state gets created — the failure mode Phase 0's B4 work closed.

## Failure behaviour

- Transient lock contention: SQLite waits up to `BUSY_TIMEOUT_MS`, then
  `withRetry` retries up to `MAX_WRITE_ATTEMPTS` with exponential backoff
  (25/50/100 ms).
- Exhaustion: throws `SQLITE_BUSY_EXHAUSTED` with the original cause attached.
  The run stops cleanly on a chunk boundary; completed chunks remain committed
  and the run is resumable. It must never hang, and never silently skip
  employees.
- Non-contention errors are not retried at all — they fail fast.

## What Phase 0B verified

Two competing writers now resolve instead of failing instantly; a permanently
held lock fails cleanly after bounded attempts rather than hanging; rollback
and atomicity from Phase 0 are unchanged. See `tests/phase0b.test.js`.

## What is still unverified

Chunked execution, progress durability, and restartability cannot be tested
until the engine's run/period tables exist (Phase 2A/2C). The test gates for
those phases are listed in `docs/PAYROLL_ENGINE_REAUDIT.md` §F.
