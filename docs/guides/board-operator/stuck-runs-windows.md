---
title: Runs stuck "running" on Windows
summary: Recognize and clear a run whose process tree died but whose row never finished
---

On Windows a kill reaches only the PID the run recorded. Its descendants
(`cmd.exe` wrapper → `node codex.js` → `codex.exe`) survive, and the run row can
stay `running` forever. This page is how to recognize that and clear it.

## Recognize the symptom

Three things are true at once:

1. The board shows an agent `running`, often for hours, with no new output.
2. The run's `processPid` is **dead**.
3. Either orphaned descendants are still alive, or everything is dead and the
   row is *still* `running`.

Check the row, then the PID:

```bash
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/heartbeat-runs/<runId>"
```

```powershell
# Is the recorded pid alive?
Get-Process -Id <processPid> -ErrorAction SilentlyContinue

# What survived it? Orphans keep the dead pid as their parent.
Get-CimInstance Win32_Process -Filter "ParentProcessId=<processPid>" |
  Select-Object ProcessId, Name, CreationDate
```

A `codex.exe` whose grandparent is gone, created at the run's
`processStartedAt`, is this bug.

## Confirm the work is not live before killing anything

The run log's last line tells you whether the turn finished:

```bash
tail -2 "<instanceRoot>/data/run-logs/<companyId>/<agentId>/<runId>.ndjson"
```

A final `{"type":"turn.completed",...}` means the turn ended and the agent
already reported its result — the orphans are holding nothing. **Without that
line, do not kill them:** the turn may still be doing real work, and you would
destroy it.

## Clear it

Kill the orphans by their own PIDs — never a blanket `codex.exe` sweep, which
would take down healthy runs belonging to other agents:

```powershell
taskkill /PID <descendantPid> /T /F
```

**Killing the orphans does not finish the row.** Measured on
`10dcb04e` and `22010ff0` (2026-09-23): with the whole process tree dead, both
rows stayed `running`. The server keeps an in-memory handle for the run, and the
reaper skips any row that still has one. To finish the row you also need one of:

- `POST /api/heartbeat-runs/<runId>/cancel` **as the board actor** — an agent
  key gets `403 Board access required`; or
- a server restart, which drops the in-memory handles and lets the reaper
  finalize the row on its next pass.

## Why it happens

Windows has no process groups to signal, so the terminate path could only reach
the wrapper PID. The descendants outlived it holding the run's stdout/stderr
pipes, so `close` never fired, the in-memory handle was never released, and the
reaper skipped the row for good.

The fix (LAC-1352) closes all three: Windows terminations now kill the whole
tree; the reaper treats a handle whose PIDs are all dead as stale, sweeps any
orphans it can prove the run owns, and finalizes the row; and the codex adapter
arms cleanup on `turn.completed` instead of waiting out the full inactivity
timeout. This page stays useful for rows stranded before that fix shipped.
