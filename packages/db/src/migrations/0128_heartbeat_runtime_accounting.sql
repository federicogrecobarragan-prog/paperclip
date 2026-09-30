ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "runtime_accounted_at" timestamp with time zone;
