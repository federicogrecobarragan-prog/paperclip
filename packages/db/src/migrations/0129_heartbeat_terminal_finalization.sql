ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "terminal_finalization_json" jsonb,
  ADD COLUMN IF NOT EXISTS "terminal_finalization_attempted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "terminal_finalized_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "budget_enforced_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_runtime_state"
  ADD COLUMN IF NOT EXISTS "session_generation" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "agent_task_sessions"
  ADD COLUMN IF NOT EXISTS "session_generation" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_pending_terminal_finalization_idx"
  ON "heartbeat_runs" ("terminal_finalization_attempted_at" ASC NULLS FIRST, "id")
  WHERE "terminal_finalization_json" IS NOT NULL AND "terminal_finalized_at" IS NULL;
