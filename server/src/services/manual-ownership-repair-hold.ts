import { inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { conflict } from "../errors.js";

type HeartbeatRunRepairState = Pick<
  typeof heartbeatRuns.$inferSelect,
  "id" | "errorCode" | "resultJson"
>;

function readManualRepairRequired(value: unknown) {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).manualRepairRequired === true,
  );
}

export function hasManualOwnershipRepairHold(
  run: Pick<HeartbeatRunRepairState, "errorCode" | "resultJson"> | null | undefined,
) {
  return (
    run?.errorCode === "process_ownership_unverified" &&
    readManualRepairRequired(run.resultJson)
  );
}

export async function listManualOwnershipRepairHoldRunIds(
  db: Db,
  runIds: Array<string | null | undefined>,
) {
  const uniqueRunIds = [...new Set(runIds.filter((id): id is string => Boolean(id)))];
  if (uniqueRunIds.length === 0) return [];

  const runs = await db
    .select({
      id: heartbeatRuns.id,
      errorCode: heartbeatRuns.errorCode,
      resultJson: heartbeatRuns.resultJson,
    })
    .from(heartbeatRuns)
    .where(inArray(heartbeatRuns.id, uniqueRunIds));

  return runs.filter(hasManualOwnershipRepairHold).map((run) => run.id);
}

export async function lockManualOwnershipRepairHoldRunIds(
  db: Db,
  runIds: Array<string | null | undefined>,
) {
  const uniqueRunIds = [...new Set(runIds.filter((id): id is string => Boolean(id)))].sort();
  if (uniqueRunIds.length === 0) return [];

  // The first read is intentional: callers can cheaply fail on an established
  // hold, while the row lock and second read close the read/modify TOCTOU for a
  // hold that becomes durable between the decision and the claim write.
  const alreadyHeld = await listManualOwnershipRepairHoldRunIds(db, uniqueRunIds);
  if (alreadyHeld.length > 0) return alreadyHeld;

  await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(inArray(heartbeatRuns.id, uniqueRunIds))
    .orderBy(heartbeatRuns.id)
    .for("update");

  return listManualOwnershipRepairHoldRunIds(db, uniqueRunIds);
}

export async function assertNoManualOwnershipRepairHold(
  db: Db,
  runIds: Array<string | null | undefined>,
  operation: string,
) {
  const heldRunIds = await lockManualOwnershipRepairHoldRunIds(db, runIds);
  if (heldRunIds.length === 0) return;

  throw conflict(
    "Issue claims are held pending audited manual ownership repair",
    {
      reason: "manual_ownership_repair_pending",
      operation,
      heldRunIds,
      requiredAction: "board_admin_force_release",
    },
  );
}
