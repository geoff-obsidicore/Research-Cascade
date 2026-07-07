# Security & operational safety

Research-Cascade is a **local-first** MCP server. Understanding its trust
boundary is the key to reading everything below.

## Trust boundary

- The `cascade-engine` server speaks MCP over **stdio** to a single local client
  (Claude Code / OpenClaw). It is not a network service and ships no auth — it
  assumes the local user is trusted. **Do not expose it over a network transport
  without adding authentication.**
- The engine's 17 knowledge tools **only read and write a local SQLite database**
  (`~/.cascade-engine/knowledge.db`). It makes **no outbound network calls, runs
  no shell, and spends no money.** Web search / fetch are *host* tools the agent
  prompts reference; this repo neither defines nor grants them.
- Its realistic attack surface is therefore **memory poisoning** of the knowledge
  base (a malicious source getting a fabricated finding admitted), not code or
  command execution.

## Credentials (AFR-05)

The engine handles **no API keys or secrets**. Its only environment inputs are
`CASCADE_DB_PATH`, `CASCADE_HALT`, `HOME`/`USERPROFILE`, and `NODE_ENV`. Model
credentials live in the **host** (Claude Code / OpenClaw), are supplied via the
environment, and are revocable there. `.env` is git-ignored and the repo is
secret-scanned (gitleaks-clean). There is no shared production secret in this
codebase; use a per-project, revocable model key at the host.

## Defenses already in the engine

- **SQL-injection-safe graph traversal** — user strings are never interpolated
  into the recursive CTE; edges are pre-filtered into a temp table and
  `relation_filter` is whitelisted (`src/index.ts`, `query_graph`).
- **Input length caps** on every tool field (`src/index.ts`, `MAX_*`).
- **DB-path guard** refusing system directories (`src/db/index.ts`).
- **Fail-closed trust scoring** — findings are admitted / quarantined / rejected
  by a trust pipeline; injection patterns and content are sanitized
  (`src/trust/`). Quarantine has reduced retrieval weight and a TTL.

## Operational controls (AFR hardening)

| Control | Where |
|---|---|
| AFR-04 Minimum scope — per-role tool allowlists | `agents/*.md` frontmatter, `docs/agent-registry.md` |
| AFR-11 Consequence classification (enforced) | `src/safety/policy.ts`, `docs/consequence-classification.md` |
| AFR-12 Approval gate on high-consequence steers; reversible tombstones | `src/index.ts` (`get_status`, `apply_steer`), `src/hitl/steering.ts` |
| AFR-16 Action log (replayable) | `src/safety/audit.ts`, `cascade-engine actions` |
| AFR-17 Real-time anomaly interventions (budget/quarantine) + circuit breaker | `src/hitl/interventions.ts`, `src/control/circuit-breaker.ts` |
| AFR-20 Kill-switch + per-cascade abort | `src/safety/killswitch.ts`, `cascade-engine halt/resume/abort` |
| AFR-09 Dependency vetting & pinning | `docs/dependency-policy.md` |
| AFR-25 Incident runbook | `docs/incident-runbook.md` |
| AFR-01 Agent registry with owner | `docs/agent-registry.md` |

## Kill-switch (AFR-20)

Halt every tool call immediately:

```
cascade-engine halt "reason"     # writes a HALT sentinel next to the DB
cascade-engine resume            # clears it
```

or set `CASCADE_HALT=1`. While halted, every tool returns a refusal. To stop a
single run without halting the engine: `cascade-engine abort <cascade-id>`.

## Reporting a vulnerability

Email **geoff@obsidicore.com** with a description and reproduction. Please do not
open a public issue for undisclosed vulnerabilities.
