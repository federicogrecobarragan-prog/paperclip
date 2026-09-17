ALTER TABLE "agent_task_sessions"
  DROP CONSTRAINT IF EXISTS "agent_task_sessions_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_task_sessions"
  ADD CONSTRAINT "agent_task_sessions_agent_id_agents_id_fk"
  FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id")
  ON DELETE cascade ON UPDATE no action;
