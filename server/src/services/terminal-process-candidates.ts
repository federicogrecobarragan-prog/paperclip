import { and, asc, eq, gt, isNotNull, notInArray, sql } from "drizzle-orm";
import { agents, heartbeatRuns, type Db } from "@paperclipai/db";

export const TERMINAL_PROCESS_BATCH_SIZE = 250;

/** Historical prompts/results are not process ownership evidence. Keep them in PostgreSQL. */
export function terminalProcessCandidatePage(db: Db, executionStatuses: string[], afterId?: string) {
  return db.select({
    run: {
      id: heartbeatRuns.id,
      processPid: heartbeatRuns.processPid,
      processGroupId: heartbeatRuns.processGroupId,
      processStartedAt: heartbeatRuns.processStartedAt,
      contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object(
        'paperclipEnvironment', jsonb_build_object(
          'driver', ${heartbeatRuns.contextSnapshot}->'paperclipEnvironment'->>'driver'
        )
      )`,
    },
    adapterType: agents.adapterType,
  }).from(heartbeatRuns)
    .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
    .where(and(
      notInArray(heartbeatRuns.status, executionStatuses),
      isNotNull(heartbeatRuns.processPid),
      afterId ? gt(heartbeatRuns.id, afterId) : undefined,
    ))
    .orderBy(asc(heartbeatRuns.id))
    .limit(TERMINAL_PROCESS_BATCH_SIZE);
}
