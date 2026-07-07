# Dependency policy — vet before you connect (AFR-09)

## Runtime dependencies (3)

| Package | Version | License | Why it's trusted |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | pinned | MIT | The official MCP SDK. Only the **stdio** transport is used; its HTTP-transport transitive deps (express/hono/etc.) are never loaded at runtime. |
| `better-sqlite3` | pinned | MIT | Widely-used synchronous SQLite binding; the engine's only storage layer. |
| `zod` | pinned | MIT | Input schema validation on every tool. |

Dev-only: `typescript`, `vitest`, `@types/*` — build and test, never shipped
(`package.json.files` ships `dist/**` + `schema.sql` only).

## Pinning

- **All dependencies — runtime and dev — are pinned to exact versions** in
  `package.json` (no caret ranges), and the full tree is locked in
  `package-lock.json` (committed). Installs are reproducible, and a manifest-level
  scanner sees no range that admits a vulnerable version.
- The MCP server registered in `.mcp.json` runs the **local built** engine
  (`servers/cascade-engine/dist/index.js`) — no third-party MCP servers are
  connected, so there is no external server to vet.

## Scanning (AFR-10)

- `npm audit` and `osv-scanner` are run on the lockfile; both are **clean** as of
  the last hardening pass. Re-run before every release:
  ```
  npm audit
  osv-scanner --lockfile=package-lock.json
  ```
- Because the engine is stdio-only, several historically-flagged transitive deps
  (the SDK's HTTP-transport chain) are unreachable at runtime; they are still kept
  patched via the lockfile rather than relied upon.

## Updating

Bump deliberately: change the exact version, run `npm install`, `npm run build`,
`npm test`, then `npm audit` + `osv-scanner`. Never `npm audit fix --force`
without reviewing the diff.
