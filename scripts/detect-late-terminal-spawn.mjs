import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { matchesRecordedProcessBirth, readProcessBirth } from '../server/dist/services/run-spawn-guard.js';

export async function detectLateTerminalSpawns(runs, birth = readProcessBirth) {
  const findings = [];
  for (const run of runs) {
    if (['queued','running','scheduled_retry'].includes(run.status) || !run.processPid) continue;
    const started = new Date(run.processStartedAt), finished = new Date(run.finishedAt);
    if (!(run.processStartedAt && run.finishedAt && started > finished)) continue;
    const actual = await birth(run.processPid);
    findings.push({ id: run.id, status: run.status, pid: run.processPid,
      matchingLiveProcess: matchesRecordedProcessBirth(started, actual) });
  }
  return findings;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: node scripts/detect-late-terminal-spawn.mjs <run-snapshot.json>');
  const input=JSON.parse(readFileSync(file,'utf8'));
  const rows=Array.isArray(input) ? input : input.runs;
  if (!Array.isArray(rows)) throw new Error('Expected a run array or { runs: [] } snapshot');
  const findings=await detectLateTerminalSpawns(rows);
  console.log(JSON.stringify({ snapshotRows:rows.length, findings, completeHistoryVerified:false },null,2));
  process.exitCode=findings.some(row=>row.matchingLiveProcess) ? 1 : 0;
}
