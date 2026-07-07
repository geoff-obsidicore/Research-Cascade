# Incident runbook (AFR-25)

One page. What to do when a cascade misbehaves — a poisoned knowledge base, a
runaway loop, unexpected spend, or a suspected prompt-injection.

**Owner / on-call:** Geoff "Lava" Lavagnino — geoff@obsidicore.com.

## 1. Contain (do this first)

- **Stop everything now:** `cascade-engine halt "incident <date>"` — every tool
  call is refused until you `resume`. (Or set `CASCADE_HALT=1`.)
- **Stop one run:** `cascade-engine abort <cascade-id>` — refuses further writes
  to that cascade only.
- If the host agent itself is looping, stop the MCP client (Claude Code / Ctrl-C);
  the engine holds no background work of its own.

## 2. Assess

- `cascade-engine actions [cascade-id]` — the recent tool-action log (AFR-16):
  what ran, its consequence tier, and what was blocked.
- `cascade-engine status <id>` — round, tokens vs budget, quarantined counts.
- A `budget_overrun` or `quarantine_spike` blocking intervention in `get_status`
  is the engine's own anomaly signal (AFR-17).

## 3. Decide

The owner decides: resume, roll back, or wipe. For anything touching data outside
the local DB, escalate before resuming (the engine itself reaches nothing else).

## 4. Recover

- **Bad findings:** they are tombstoned, not deleted (`rejected = 1`). Inspect
  with SQL; restore a wrongly-rejected finding by clearing `rejected` /
  re-approving via `reviewQuarantined`.
- **Corrupt or poisoned DB beyond repair:** `cascade-engine reset` (deletes the
  local knowledge DB and starts fresh). The DB is a rebuildable cache, not a
  system of record.
- **Resume:** `cascade-engine resume` once contained.

## 5. Report & review (AFR-28)

Write up what happened, which control caught it (or should have), and what gets
tightened. Email the owner. Re-run a Runworthy scan after significant changes
(AFR-29).
