# Agent registry (AFR-01)

Every agent that runs as part of Research-Cascade, with a single named owner.

**Owner / steward:** Geoff "Lava" Lavagnino — geoff@obsidicore.com (Obsidicore LLC).

| Agent | Kind | Model | Scope (tools it may use) | Reaches | Blast radius |
|---|---|---|---|---|---|
| `cascade-engine` | MCP server | n/a | Its own 17 knowledge tools + `apply_steer`, `get_actions` | Local SQLite DB only | Memory poisoning of the local knowledge base; no shell/network/spend |
| `research-planner` | Claude Code subagent | sonnet | `cascade_init`, `store_plan`, `get_status`, `store_hypothesis`, `record_metric` | Engine (planning tools) | Cannot fetch or write findings; plan-only |
| `deep-investigator` | Claude Code subagent | opus | `WebSearch`, `WebFetch` + `store_finding`, `get_findings`, `add_entity`, `add_link`, `store_hypothesis`, `store_checkpoint`, `record_metric`, `get_status` | Web (read) + engine | Can admit findings (mitigated by trust pipeline); no destructive tools |
| `cross-validator` | Claude Code subagent | sonnet | `WebSearch`, `WebFetch` + `get_findings`, `get_hypotheses`, `store_finding`, `store_hypothesis`, `record_metric`, `steer` | Web (read) + engine | May *queue* a steer (e.g. flag for review); cannot approve/enact it |
| `synthesis-writer` | Claude Code subagent | opus | `get_findings`, `get_hypotheses`, `query_graph`, `search_notes`, `create_note`, `get_metrics`, `record_metric`, `get_status` | Engine only | No web, no destructive tools; read + note-write only |

## Notes

- **Least privilege (AFR-04):** the allowlists above are enforced by the `tools:`
  frontmatter in each `agents/*.md` file (Claude Code honors these). Only the two
  investigative roles get web access; only `cross-validator` can *queue* a steer,
  and no subagent can *approve* a high-consequence steer — that is a human action
  via `apply_steer` (AFR-12).
- The tool names assume the engine is mounted under the MCP alias `cascade-engine`
  (see `.mcp.json`). Under a different host/alias, adjust the `mcp__<alias>__*`
  names accordingly.
- **Decommissioning (AFR-03):** to retire a role, delete its `agents/*.md` file;
  to retire the engine, remove it from `.mcp.json` and delete the local DB
  (`cascade-engine reset`).
