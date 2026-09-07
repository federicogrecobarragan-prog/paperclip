# Durable terminal finalization — WIP checkpoint, 2026-09-07

Status: **NOT APPROVED FOR DEPLOYMENT**. This checkpoint preserves unfinished
implementation work after independent review LAC-1313 rejected a5d7dea004 for
crash windows after terminal persistence and after runtime accounting commit.
No production database, deployment, checkout, or service was changed.

## Implemented, not yet acceptance-tested

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

## Validation evidence and limitations

An intermediate server `tsc --noEmit --pretty false` completed successfully
(tool session 64433). It predates the final stream/start/reset/attempt changes
and does NOT validate the complete checkpoint. A final server typecheck was
started as session 53258 and completed exit 0 (PASS), including the final
stream/start/reset/attempt changes. `git diff --check` also passed. This validates
types/format only, not crash durability, security end-to-end, or database behavior.
After that typecheck, the streaming unit run found an ANSI sequence spanning a
newline could consume part of a secret key. The helper now validates complete
CSI framing before stripping controls. The final focused run passed 14/14 using
pnpm 9.15.4; the full typecheck was not repeated after that seven-line guard.
No new PostgreSQL acceptance test was run or added for this durable change.
Previously green a5 tests are NOT evidence that this WIP is correct.

Use pnpm 9.15.4 via the existing corepack shim, never global pnpm 11:
`C:\Users\Popo\AppData\Local\Temp\midoria-pnpm9` prepended to PATH.

## Required next work before any publication or deployment

1. Complete source review and run final typecheck/migration checks. Inspect every
   terminal producer, including direct scheduled-retry SQL updates, early setup
   failures, reaper and queued cancellation gates. Some paths still run legacy
   immediate cleanup; verify they neither bypass durable intent nor rewrite
   newer state. The error/cancel test-deferral hooks need explicit crash tests;
   do not mistake a swallowed exception or same-instance retry for process loss.
2. Verify the intent boundary rejects malformed version-1 payloads and reports
   corrupt/unsupported rows visibly while allowing other rows to progress.
   Check that security sanitization cannot silently remove required intent keys.
3. Review issue-release post-commit actions: the phase flag commits with the SQL
   promotion, while existing recovery/escalation/publication work follows it.
   Prove startup queued-run recovery covers committed promotions without hiding
   any required post-commit action. Preserve optional summaries as best effort
   only where that matches the original contract.
4. PostgreSQL discriminants with a genuinely new service instance after each
   boundary: terminal CAS; accounting commit; budget hook before completion
   marker; repeated hook failure; two concurrent reconcilers plus third replay.
   Require one cost event, exact totals, one hard approval/incident/activity,
   paused scope, completed wakeup, cleared owned locks and final markers.
5. Old run A pending while newer B succeeds or clears its session: account both
   once without rewinding B. Cover manual global reset, task-specific reset
   during execution, another task unaffected, concurrent new-run start,
   paused/terminated agents, missing session rows and missing agents.
6. Preserve a new executionRunId while clearing old checkoutRunId; do not
   promote deferred wakes created after the old terminal boundary. Test 101
   poison/pending rows to verify bounded scan fairness across iterations.
7. Test known zero usage, subscription usage with zero billed cost, unknown
   usage, old legacy rows with preexisting costs, and UTC-month rollover.
8. Test terminal fallback under NUL/surrogates with intent intact. Add real-PG
   invalid-contract tests for Number.MAX_VALUE USD and 2**31 token/cost values
   against the separate root security fix; no orphaned running rows or illegal
   cost events may remain.
9. Run real adapter stream tests with adversarial split credentials in file
   logs, excerpts, live events and diagnostics, including failure and cancel.
   Confirm there are no unsanitized alternate sinks and no late-output reopen.
10. Reconcile with the Windows candidate's identity-verified tree-kill changes;
    do not restore PID-only orphan cleanup. Obtain new independent signatures
    for the final combined SHA. Do not reuse a5 signatures or claim all green.

Rollback remains code-only with additive schema retained. No down migration,
historical rewrite, backup rotation or production restart is authorized by this
checkpoint document.
