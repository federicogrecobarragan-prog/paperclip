ALTER TABLE "agent_task_sessions"
  DROP CONSTRAINT IF EXISTS "agent_task_sessions_last_run_id_heartbeat_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_task_sessions"
  ADD CONSTRAINT "agent_task_sessions_last_run_id_heartbeat_runs_id_fk"
  FOREIGN KEY ("last_run_id") REFERENCES "public"."heartbeat_runs"("id")
  ON DELETE set null ON UPDATE no action;
