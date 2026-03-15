/**
 * Steering — Human redirects cascade mid-research
 *
 * Steer events are appended to the database and picked up on the next iteration.
 * Types: redirect, narrow, broaden, add_question, drop_hypothesis, approve, reject
 *
 * "Ralph Loop": instruction → NDJSON injection → agent pivots on next iteration
 */

import { getDb } from '../db/index.js';

export type SteerType = 'redirect' | 'narrow' | 'broaden' | 'add_question' | 'drop_hypothesis' | 'approve' | 'reject';

export interface SteerEvent {
  id: number;
  cascadeId: string;
  eventType: SteerType;
  instruction: string;
  targetId?: string;
  applied: boolean;
  createdAt: string;
}

/**
 * Submit a steering event.
 */
export function submitSteer(
  cascadeId: string,
  eventType: SteerType,
  instruction: string,
  targetId?: string,
): number {
  const db = getDb();

  const result = db.prepare(`INSERT INTO steer_events (cascade_id, event_type, instruction, target_id)
    VALUES (?, ?, ?, ?)`).run(cascadeId, eventType, instruction, targetId);

  return Number(result.lastInsertRowid);
}

/**
 * Get pending (unapplied) steer events for a cascade.
 */
export function getPendingSteers(cascadeId: string): SteerEvent[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM steer_events
    WHERE cascade_id = ? AND applied = 0
    ORDER BY created_at ASC`).all(cascadeId) as any[];

  return rows.map(rowToSteerEvent);
}

/**
 * Apply a steer event and take action.
 * Returns a description of what changed.
 */
export function applySteer(eventId: number): string {
  const db = getDb();
  const event = db.prepare('SELECT * FROM steer_events WHERE id = ?').get(eventId) as any;
  if (!event) return 'Steer event not found.';
  if (event.applied) return 'Steer event already applied.';

  let result: string;

  switch (event.event_type as SteerType) {
    case 'redirect':
      // Change the cascade's primary question
      db.prepare('UPDATE cascades SET question = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(event.instruction, event.cascade_id);
      result = `Redirected cascade to: "${event.instruction}"`;
      break;

    case 'narrow':
      // Add a scope constraint to the plan
      result = `Narrowed scope: "${event.instruction}". Agent should focus on this aspect.`;
      break;

    case 'broaden':
      result = `Broadened scope: "${event.instruction}". Agent should explore wider.`;
      break;

    case 'add_question':
      // Create a new thread for the question
      db.prepare(`INSERT INTO threads (id, cascade_id, question, type, status)
        VALUES (?, ?, ?, 'discovery', 'pending')`)
        .run(`steer-${eventId}`, event.cascade_id, event.instruction);
      result = `Added research question: "${event.instruction}"`;
      break;

    case 'drop_hypothesis':
      if (event.target_id) {
        db.prepare("UPDATE hypotheses SET status = 'archived', updated_at = datetime('now') WHERE id = ?")
          .run(event.target_id);
        result = `Archived hypothesis ${event.target_id}: "${event.instruction}"`;
      } else {
        result = 'No target hypothesis specified.';
      }
      break;

    case 'approve':
      if (event.target_id) {
        db.prepare("UPDATE findings SET quarantined = 0, human_reviewed = 1, retrieval_weight = 1.0 WHERE id = ?")
          .run(event.target_id);
        result = `Approved finding ${event.target_id}`;
      } else {
        result = 'No target finding specified.';
      }
      break;

    case 'reject':
      if (event.target_id) {
        db.prepare('DELETE FROM findings WHERE id = ?').run(event.target_id);
        result = `Rejected and removed finding ${event.target_id}`;
      } else {
        result = 'No target finding specified.';
      }
      break;

    default:
      result = `Unknown steer type: ${event.event_type}`;
  }

  // Mark as applied
  db.prepare('UPDATE steer_events SET applied = 1 WHERE id = ?').run(eventId);

  return result;
}

/**
 * Apply all pending steer events for a cascade.
 * Called at the start of each cascade iteration.
 */
export function applyAllPendingSteers(cascadeId: string): string[] {
  const pending = getPendingSteers(cascadeId);
  return pending.map(event => applySteer(event.id));
}

// --- Helpers ---

function rowToSteerEvent(row: any): SteerEvent {
  return {
    id: row.id,
    cascadeId: row.cascade_id,
    eventType: row.event_type,
    instruction: row.instruction,
    targetId: row.target_id,
    applied: row.applied === 1,
    createdAt: row.created_at,
  };
}
