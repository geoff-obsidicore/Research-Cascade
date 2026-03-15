# Research Cascade — Project Conventions

## Tech Stack
- **Runtime:** Node.js ≥22 LTS, TypeScript 5.8, ES2022 modules
- **Database:** SQLite via better-sqlite3 (synchronous, WAL mode). DB at `~/.cascade-engine/knowledge.db`
- **MCP SDK:** @modelcontextprotocol/sdk (stdio transport)
- **Tests:** Vitest with in-memory SQLite via `__setTestDb()`
- **Community detection:** Python 3 + igraph (Leiden clustering)

## Architecture
```
servers/cascade-engine/src/
  index.ts          — MCP server entry (15 tools, stdio)
  db/               — SQLite schema + wrapper (WAL, PRAGMAs, migrations)
  cascade/          — FSM engine, quality gates, checkpoints, search planning
  graph/            — KG entities, edges, recursive CTE traversal, structural entropy
  trust/            — 6-signal scoring, injection patterns, sandboxed ingestion
  control/          — PID controller, Kalman filter, Lyapunov stability
  memory/           — NCD dedup, Weibull tiers, SM-2 spaced repetition, consolidation
  hitl/             — Interventions, steering events, ANSI dashboard
```

## Reference Documents
- `spec/MASTER_SPEC.md` — Full architecture spec with schemas, algorithms, implementation order
- `spec/Research Cascade Memory Plan.md` — Complete research record (11 prompts, cross-model synthesis)

## Commands
- `npm run build` — Compile TypeScript to dist/
- `npm run typecheck` — Type-check without emitting
- `npm test` — Run all Vitest tests
- `npm run dev` — Watch mode compilation
- `python scripts/community_detection.py` — Run Leiden clustering on KG

## Code Conventions
1. NEVER `console.log()` in MCP server code — corrupts stdio JSON-RPC. Use `console.error()` only.
2. All DB operations use synchronous better-sqlite3 — no async/await for DB calls.
3. Content-addressable IDs via SHA-256 truncated to 16 hex chars for findings.
4. Graph traversals ALWAYS bounded to ≤3 hops. No exceptions.
5. Idempotent upserts everywhere — `INSERT ... ON CONFLICT DO UPDATE`.
6. Trust scoring is fail-closed: if scoring fails, finding goes to quarantine.
7. Schema uses `IF NOT EXISTS` — safe to re-run migrations.
8. Tests use `__setTestDb()` with in-memory SQLite, not the real DB.
9. PID math is manually verified — do not change control/pid.ts formulas without re-verifying.
10. Windows paths: use `path.join()`, never manual slashes. MCP stdio needs `cmd /c node`.

## Workflow
- Typecheck + test after every change: `npm run typecheck && npm test`
- Atomic commits per component
- Read spec/MASTER_SPEC.md before modifying any algorithm

## NEVER
- NEVER touch the real DB in tests — always use `__setTestDb()` with `:memory:`
- NEVER remove the 3-hop limit on graph traversal
- NEVER use async SQLite operations (race conditions with JSONL state)
- NEVER commit node_modules/ or dist/
- NEVER skip trust scoring for incoming findings
