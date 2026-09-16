# Durable terminal finalization — publication record, 2026-09-15

Status: **IMPLEMENTATION COMPLETE; INDEPENDENT REVIEW REQUIRED**. LAC-1324
closes the implementation gaps found by LAC-1313 and LAC-1314. Publication is
to the existing PR branch only; LAC-1255 remains the independent quality gate.
This record does not authorize merge or deployment. No production database,
deployment, checkout, permission, or repository setting was changed.

## Implemented

- Additive migration 0129: terminal intent JSON, finalization/budget markers,
  last-attempt timestamp and pending index; global/task session generations.
- New terminal status writes attach a minimal versioned intent in the same SQL
  update. Existing terminal rows with null intent are not backfilled/replayed.
  Sanitized terminal fallback retains its intent.
- Accounting remains protected by runtimeAccountedAt. Mutable runtime session
  decoration is separate from additive counters. Budget completion is recorded
  only after evaluateCostEvent returns; cost occurrence uses terminal time.
- Database phases claim a completed flag in the same transaction as their write.
  Session clear uses a tombstone. Manual global/task resets increment their own
  generation atomically with clearing, preserving task-specific reset semantics.
- A transaction advisory lock coordinates starts, phase projections and resets.
  SQL predicates protect newer runs, generations and paused/terminated agents.
- Indexed bounded reconciliation runs at scheduler startup and periodically.
  Persisted attempt timestamps rotate unsuccessful rows instead of starving
  newer pending rows behind one permanently failing first batch.
- Issue release claims its phase in its existing transaction and limits deferred
  wakes to those requested no later than the source run's finish.
- Cancellation awaits termination before its cancellable-status CAS, retaining
  ownership on failure. Windows tree termination itself belongs to the separate
  Windows candidate and is NOT delivered by this checkpoint alone.
- Stateful stream redaction helper integrated into all onLog sinks. Buffered
  output is flushed before normal/error log closure and control-plane cancel.
  The helper and its unit tests are owned by the parallel security agent.
- Budget evaluation now uses the event's original accounting window, including
  delayed recovery across a UTC month boundary; historical hard-stop violations
  remain actionable rather than silently becoming zero current-month spend.

## Acceptance coverage

The completed PostgreSQL suite exercises new service instances after terminal
commit and accounting commit, two concurrent reconcilers, and a third replay.
It asserts exactly-once ledger totals and cost events, hard-stop incident,
approval and activity idempotency, wake completion, lock release, paused scope,
session recovery, and every durable phase marker. The existing five accounting
fault boundaries remain covered independently.

Additional PostgreSQL discriminants cover:

- old run A replayed after newer run B and global/task session generations,
  including a cleared task tombstone and an unrelated task;
- an old checkout cleared without overwriting a newer `executionRunId`, while a
  deferred wake requested after the terminal boundary stays deferred;
- 101 malformed pending journals ahead of one valid row, proving bounded-scan
  rotation rather than starvation, with a visible warning for invalid journals;
- known-zero, subscription-included, unknown and legacy pre-journal accounting,
  plus delayed hard-budget evaluation in the original UTC month;
- real PostgreSQL rejection of `2**31` token counts and `Number.MAX_VALUE` USD
  without a cost event or orphaned running agent;
- an opaque credential split across adapter chunks, asserting the terminal row,
  persisted log and live-event sinks never receive the canary.

The stream helper's focused suite covers every secret split offset, one-byte
writes, stdout/stderr independence, completion/error/cancel flush idempotency,
ANSI/OSC ambiguity, NUL/lone-surrogate removal, hostile inputs and memory/output
bounds. Persistence safety tests cover NUL-split secret keys and exact ledger
ranges. Route tests reject legacy/non-enum `triggerDetail` values before service
invocation while accepting the supported enum.

Final local commands and their results are recorded in the LAC-1324 delivery
comment together with the pushed SHA and GitHub Actions URLs. CI and PostgreSQL
workflow results belong to that immutable SHA; older a5 signatures are not
reused. The next action is independent review/QA through LAC-1255.

Rollback remains code-only with additive schema retained. No down migration,
historical rewrite, backup rotation, production restart, merge, or deployment is
authorized by this record.
