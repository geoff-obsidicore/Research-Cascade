/**
 * Cascade Engine — Core FSM Loop
 *
 * Implements the research cascade state machine:
 *   IDENTIFY → SCREEN → EVALUATE → CONSOLIDATE → MATURE → PRUNE → SYNTHESIZE → OBSERVE → (loop|done)
 *
 * The AGENT orchestrates. This engine TRACKS STATE.
 * The engine provides methods that MCP tools call; the LLM decides when/how to call them.
 */

import { getDb, generateId, withTransaction } from '../db/index.js';

// --- Types ---

export type CascadePhase =
  | 'identify'    // Decompose question, generate search queries
  | 'screen'      // Filter by relevance, NCD dedup, trust scoring
  | 'evaluate'    // Deep fetch, GRADE evidence, Kalman confidence fusion
  | 'consolidate' // Interleaved replay, retrieval testing, graph update
  | 'mature'      // Clonal selection, affinity maturation
  | 'prune'       // Activity-decay + CD47 protection
  | 'synthesize'  // MDL compression, produce round summary
  | 'observe';    // Lyapunov stability, entropy convergence, stopping check

export interface CascadeRoundState {
  cascadeId: string;
  roundIndex: number;
  phase: CascadePhase;
  stepIndex: number;
  explorationBudget: number;
  searchQueries: string[];
  findingsThisRound: number;
  startedAt: string;
}

export interface StopCondition {
  name: string;
  met: boolean;
  value: number;
  threshold: number;
  description: string;
}

export const PHASE_ORDER: CascadePhase[] = [
  'identify', 'screen', 'evaluate', 'consolidate',
  'mature', 'prune', 'synthesize', 'observe',
];

// --- Engine Functions ---

/**
 * Initialize a new round of research.
 * Sets up the round state and calculates exploration budget.
 */
export function initRound(cascadeId: string): CascadeRoundState {
  const db = getDb();
  const cascade = db.prepare('SELECT * FROM cascades WHERE id = ?').get(cascadeId) as any;
  if (!cascade) throw new Error(`Cascade ${cascadeId} not found`);

  const roundIndex = cascade.current_round;
  const explorationBudget = Math.max(0, 1 - roundIndex / cascade.max_rounds);

  const state: CascadeRoundState = {
    cascadeId,
    roundIndex,
    phase: 'identify',
    stepIndex: 0,
    explorationBudget,
    searchQueries: [],
    findingsThisRound: 0,
    startedAt: new Date().toISOString(),
  };

  // Create checkpoint for round start
  db.prepare(`INSERT INTO cascade_checkpoints (task_id, round_index, step_index, step_name, status, state_snapshot)
    VALUES (?, ?, 0, 'round_init', 'done', ?)
    ON CONFLICT(task_id, round_index, step_index) DO UPDATE SET status = 'done'`)
    .run(cascadeId, roundIndex, JSON.stringify(state));

  return state;
}

/**
 * Advance to the next phase in the cascade loop.
 * Returns the new phase, or null if the round is complete.
 */
export function advancePhase(state: CascadeRoundState): CascadePhase | null {
  const currentIdx = PHASE_ORDER.indexOf(state.phase);
  if (currentIdx < 0 || currentIdx >= PHASE_ORDER.length - 1) return null;

  const nextPhase = PHASE_ORDER[currentIdx + 1];
  state.phase = nextPhase;
  state.stepIndex++;

  // Checkpoint
  const db = getDb();
  db.prepare(`INSERT INTO cascade_checkpoints (task_id, round_index, step_index, step_name, status, state_snapshot)
    VALUES (?, ?, ?, ?, 'running', ?)
    ON CONFLICT(task_id, round_index, step_index) DO UPDATE SET
      status = 'running', state_snapshot = excluded.state_snapshot`)
    .run(state.cascadeId, state.roundIndex, state.stepIndex, nextPhase, JSON.stringify(state));

  return nextPhase;
}

/**
 * Mark current phase as complete.
 */
export function completePhase(state: CascadeRoundState): void {
  const db = getDb();
  db.prepare(`UPDATE cascade_checkpoints SET status = 'done', completed_at = datetime('now')
    WHERE task_id = ? AND round_index = ? AND step_index = ?`)
    .run(state.cascadeId, state.roundIndex, state.stepIndex);
}

/**
 * Resume from the last successful checkpoint.
 */
export function resumeFromCheckpoint(cascadeId: string): CascadeRoundState | null {
  const db = getDb();

  // Find the last completed checkpoint
  const last = db.prepare(`SELECT * FROM cascade_checkpoints
    WHERE task_id = ? AND status = 'done'
    ORDER BY round_index DESC, step_index DESC LIMIT 1`)
    .get(cascadeId) as any;

  if (!last?.state_snapshot) return null;

  const state: CascadeRoundState = JSON.parse(last.state_snapshot);

  // Advance past the completed step
  const nextPhase = advancePhase(state);
  if (!nextPhase) {
    // Round was complete — start new round
    return initRound(cascadeId);
  }

  return state;
}

/**
 * Generate search queries for the IDENTIFY phase.
 * Uses UCB to balance exploration vs exploitation across threads.
 */
export function generateSearchPlan(cascadeId: string): { explorationQueries: string[]; exploitationQueries: string[] } {
  const db = getDb();
  const cascade = db.prepare('SELECT * FROM cascades WHERE id = ?').get(cascadeId) as any;
  if (!cascade) throw new Error(`Cascade ${cascadeId} not found`);

  const plan = cascade.plan_json ? JSON.parse(cascade.plan_json) : null;
  const questions = plan?.questions || [cascade.question];
  const budget = Math.max(0, 1 - cascade.current_round / cascade.max_rounds);

  // Get existing threads for UCB calculation
  const threads = db.prepare('SELECT * FROM threads WHERE cascade_id = ?').all(cascadeId) as any[];
  const totalVisits = threads.reduce((s: number, t: any) => s + (t.ucb_visits || 0), 0) || 1;

  // UCB scoring for existing threads
  const C = 1.414; // Exploration constant
  for (const thread of threads) {
    const visits = thread.ucb_visits || 1;
    const reward = thread.ucb_reward || 0;
    thread.ucb_score = reward / visits + C * Math.sqrt(Math.log(totalVisits) / visits);
  }

  // Split budget: exploration gets novel queries, exploitation deepens existing
  const explorationCount = Math.ceil(questions.length * budget);
  const exploitationCount = Math.max(1, questions.length - explorationCount);

  return {
    explorationQueries: questions.slice(0, explorationCount),
    exploitationQueries: threads
      .sort((a: any, b: any) => (b.ucb_score || 0) - (a.ucb_score || 0))
      .slice(0, exploitationCount)
      .map((t: any) => t.question),
  };
}

/**
 * Create a research thread (a sub-question being investigated).
 */
export function createThread(
  cascadeId: string,
  question: string,
  type: 'technical' | 'discovery' | 'classification' | 'validation',
  agentName?: string,
  modelUsed?: string,
): string {
  const db = getDb();
  const id = generateId();

  db.prepare(`INSERT INTO threads (id, cascade_id, question, type, status, agent_name, model_used, started_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, datetime('now'))`)
    .run(id, cascadeId, question, type, agentName, modelUsed);

  return id;
}

/**
 * Complete a thread and update its UCB values.
 */
export function completeThread(threadId: string, reward: number): void {
  const db = getDb();

  db.prepare(`UPDATE threads SET
    status = 'done', completed_at = datetime('now'),
    ucb_visits = ucb_visits + 1,
    ucb_reward = ucb_reward + ?
    WHERE id = ?`)
    .run(reward, threadId);
}

/**
 * Get round summary for synthesis.
 */
export function getRoundSummary(cascadeId: string, roundIndex: number): {
  findings: any[];
  hypotheses: any[];
  newEntities: number;
  newEdges: number;
} {
  const db = getDb();

  const findings = db.prepare(`SELECT id, claim, confidence, trust_composite, grade_level
    FROM findings WHERE cascade_id = ? AND cascade_round = ? AND quarantined = 0
    ORDER BY confidence DESC`)
    .all(cascadeId, roundIndex);

  const hypotheses = db.prepare(`SELECT id, statement, affinity, status
    FROM hypotheses WHERE cascade_id = ?
    ORDER BY affinity DESC`)
    .all(cascadeId);

  // Approximate new entities/edges this round (by timestamp)
  const newEntities = (db.prepare(`SELECT COUNT(*) as n FROM kg_entities
    WHERE created_at >= (SELECT MIN(created_at) FROM cascade_checkpoints WHERE task_id = ? AND round_index = ?)`).get(cascadeId, roundIndex) as any)?.n || 0;
  const newEdges = (db.prepare(`SELECT COUNT(*) as n FROM kg_edges
    WHERE created_at >= (SELECT MIN(created_at) FROM cascade_checkpoints WHERE task_id = ? AND round_index = ?)`).get(cascadeId, roundIndex) as any)?.n || 0;

  return { findings, hypotheses, newEntities, newEdges };
}
