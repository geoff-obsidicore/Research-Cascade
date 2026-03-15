/**
 * Step-Level Checkpointing
 *
 * Every step is checkpointed independently — crash loses only the current step.
 * Idempotent upserts via content-addressable keys + ON CONFLICT DO UPDATE.
 * Buffer in SQLite, commit to JSONL only after step completes.
 */

import { getDb } from '../db/index.js';
import { CascadeRoundState, CascadePhase, PHASE_ORDER } from './engine.js';

export interface Checkpoint {
  taskId: string;
  roundIndex: number;
  stepIndex: number;
  stepName: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  stateSnapshot?: string;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
}

/**
 * Save a checkpoint for the current step.
 */
export function saveCheckpoint(
  state: CascadeRoundState,
  status: Checkpoint['status'],
  errorMessage?: string,
): void {
  const db = getDb();
  const idempotencyKey = `${state.cascadeId}:${state.roundIndex}:${state.stepIndex}:${state.phase}`;

  db.prepare(`INSERT INTO cascade_checkpoints
    (task_id, round_index, step_index, step_name, status, state_snapshot, idempotency_key, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, round_index, step_index) DO UPDATE SET
      status = excluded.status,
      state_snapshot = COALESCE(excluded.state_snapshot, state_snapshot),
      error_message = excluded.error_message,
      completed_at = CASE WHEN excluded.status IN ('done','failed','skipped') THEN datetime('now') ELSE completed_at END`)
    .run(
      state.cascadeId, state.roundIndex, state.stepIndex,
      state.phase, status, JSON.stringify(state),
      idempotencyKey, errorMessage,
    );
}

/**
 * Get all checkpoints for a cascade, organized by round.
 */
export function getCheckpoints(cascadeId: string): Record<number, Checkpoint[]> {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM cascade_checkpoints
    WHERE task_id = ? ORDER BY round_index, step_index`)
    .all(cascadeId) as any[];

  const byRound: Record<number, Checkpoint[]> = {};
  for (const row of rows) {
    if (!byRound[row.round_index]) byRound[row.round_index] = [];
    byRound[row.round_index].push({
      taskId: row.task_id,
      roundIndex: row.round_index,
      stepIndex: row.step_index,
      stepName: row.step_name,
      status: row.status,
      stateSnapshot: row.state_snapshot,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    });
  }
  return byRound;
}

/**
 * Find the last successful checkpoint to resume from.
 */
export function findResumePoint(cascadeId: string): {
  roundIndex: number;
  phase: CascadePhase;
  state: CascadeRoundState | null;
} | null {
  const db = getDb();

  const last = db.prepare(`SELECT * FROM cascade_checkpoints
    WHERE task_id = ? AND status = 'done'
    ORDER BY round_index DESC, step_index DESC LIMIT 1`)
    .get(cascadeId) as any;

  if (!last) return null;

  const state = last.state_snapshot ? JSON.parse(last.state_snapshot) as CascadeRoundState : null;
  const phaseIdx = PHASE_ORDER.indexOf(last.step_name as CascadePhase);
  const nextPhase = phaseIdx >= 0 && phaseIdx < PHASE_ORDER.length - 1
    ? PHASE_ORDER[phaseIdx + 1]
    : 'identify'; // Start new round

  return {
    roundIndex: phaseIdx >= PHASE_ORDER.length - 1 ? last.round_index + 1 : last.round_index,
    phase: nextPhase,
    state,
  };
}

/**
 * Check idempotency cache for a previously computed result.
 */
export function checkIdempotency(key: string): any | null {
  const db = getDb();

  // Clean expired entries
  db.prepare("DELETE FROM idempotency_cache WHERE expires_at IS NOT NULL AND expires_at < datetime('now')").run();

  const cached = db.prepare('SELECT result_json FROM idempotency_cache WHERE key = ?').get(key) as any;
  return cached ? JSON.parse(cached.result_json) : null;
}

/**
 * Store a result in the idempotency cache.
 */
export function cacheIdempotent(key: string, result: any, ttlMinutes: number = 60): void {
  const db = getDb();

  db.prepare(`INSERT INTO idempotency_cache (key, result_json, expires_at)
    VALUES (?, ?, datetime('now', '+' || ? || ' minutes'))
    ON CONFLICT(key) DO UPDATE SET
      result_json = excluded.result_json,
      expires_at = excluded.expires_at`)
    .run(key, JSON.stringify(result), ttlMinutes);
}

/**
 * Get a compact progress summary for the cascade.
 */
export function getProgressSummary(cascadeId: string): {
  totalRounds: number;
  completedRounds: number;
  currentPhase: string;
  completedSteps: number;
  failedSteps: number;
  lastActivity: string;
} {
  const db = getDb();

  const cascade = db.prepare('SELECT current_round, max_rounds FROM cascades WHERE id = ?').get(cascadeId) as any;
  if (!cascade) throw new Error(`Cascade ${cascadeId} not found`);

  const stats = db.prepare(`SELECT
    COUNT(CASE WHEN status = 'done' THEN 1 END) as completed,
    COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
    MAX(COALESCE(completed_at, created_at)) as last_activity
    FROM cascade_checkpoints WHERE task_id = ?`)
    .get(cascadeId) as any;

  const currentStep = db.prepare(`SELECT step_name FROM cascade_checkpoints
    WHERE task_id = ? AND status IN ('running','pending')
    ORDER BY round_index DESC, step_index DESC LIMIT 1`)
    .get(cascadeId) as any;

  return {
    totalRounds: cascade.max_rounds,
    completedRounds: cascade.current_round,
    currentPhase: currentStep?.step_name || 'idle',
    completedSteps: stats?.completed || 0,
    failedSteps: stats?.failed || 0,
    lastActivity: stats?.last_activity || 'never',
  };
}
