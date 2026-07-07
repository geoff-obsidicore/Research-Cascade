# Consequence classification (AFR-11)

Every action the engine can take is classified by consequence. This is **not a
description that can drift from behaviour** — the source of truth is
`src/safety/policy.ts`, and the approval gate (AFR-12) reads it directly.

## Tiers

- **low** — reversible reads/writes to the local knowledge store.
- **high** — destructive or scope-changing to research state; requires a human.
- **critical** — irreversible or external effect. **None exist in this engine**
  (it has no shell, network egress, or spend), so the honest ceiling is `high`.

## Tools

All 17 knowledge tools (`store_plan`, `store_finding`, `get_findings`,
`add_entity`, `add_link`, `query_graph`, `store_hypothesis`, `get_hypotheses`,
`cascade_init`, `get_status`, `update_status`, `get_metrics`, `store_checkpoint`,
`record_metric`, `create_note`, `search_notes`) and `get_actions` are **low**.
Queuing a `steer` is **low**; `apply_steer` (enacting a queued high-consequence
steer) is **high** — a human-only action.

## Steer events

| Steer | Tier | Why |
|---|---|---|
| `narrow`, `broaden`, `add_question`, `approve` | low | Additive or reversible; auto-apply on `get_status` |
| `drop_hypothesis` | high | Archives a hypothesis — needs approval |
| `reject` | high | Tombstones a finding — needs approval |
| `redirect` | high | Rewrites a cascade's primary question — needs approval |

Unknown tool or steer types **default-deny** (treated as `high`, never
auto-applied) — AFR-14.

## Enforcement

- Low-consequence steers auto-apply when `get_status` runs.
- High-consequence steers stay **pending** and are surfaced under
  `awaiting_approval`; a human enacts them with `apply_steer <id>` (AFR-12).
- Destructive effects are **reversible**: `reject` sets a `rejected` tombstone
  (finding hidden from retrieval, weight 0) rather than deleting it, preserving
  the audit trail and allowing recovery.
