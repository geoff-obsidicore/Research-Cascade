/**
 * Action consequence policy (AFR-11) and steer approval gating (AFR-12).
 *
 * Every engine tool and every steer event carries a consequence tier:
 *   low      — reversible reads/writes to the local knowledge store
 *   high     — destructive or scope-changing to research state (needs approval)
 *   critical — irreversible / external effect (none exist in this engine today)
 *
 * The engine has no shell, network egress, or spend, so nothing here is
 * `critical`; the honest ceiling is `high`. This map is the single source of
 * truth the approval gate reads — it is not documentation that can drift from
 * behaviour.
 */

export type Consequence = 'low' | 'high' | 'critical';

/** Consequence of invoking each MCP tool. */
export const TOOL_CONSEQUENCE: Record<string, Consequence> = {
  store_plan: 'low',
  store_finding: 'low',
  get_findings: 'low',
  add_entity: 'low',
  add_link: 'low',
  query_graph: 'low',
  store_hypothesis: 'low',
  get_hypotheses: 'low',
  cascade_init: 'low',
  get_status: 'low',
  update_status: 'low',
  get_metrics: 'low',
  store_checkpoint: 'low',
  record_metric: 'low',
  create_note: 'low',
  search_notes: 'low',
  steer: 'low',        // queuing a steer is low; ENACTING a high one is gated below
  apply_steer: 'high', // human-only: enacts a queued high-consequence steer
  get_actions: 'low',
};

/**
 * Consequence of ENACTING each steer event type. `redirect` rewrites a
 * cascade's primary question, `reject` tombstones a finding, `drop_hypothesis`
 * archives a hypothesis — all mutate research state and require a human.
 */
export const STEER_CONSEQUENCE: Record<string, Consequence> = {
  approve: 'low',
  narrow: 'low',
  broaden: 'low',
  add_question: 'low',
  drop_hypothesis: 'high',
  reject: 'high',
  redirect: 'high',
};

export function toolConsequence(tool: string): Consequence {
  return TOOL_CONSEQUENCE[tool] ?? 'high'; // default-deny unknown tools (AFR-14)
}

export function steerConsequence(type: string): Consequence {
  return STEER_CONSEQUENCE[type] ?? 'high'; // default-deny unknown steers (AFR-14)
}

/**
 * A queued steer may be enacted automatically only if it is low-consequence.
 * High/critical steers stay pending until a human calls `apply_steer`.
 */
export function steerAutoApplies(type: string): boolean {
  return steerConsequence(type) === 'low';
}
