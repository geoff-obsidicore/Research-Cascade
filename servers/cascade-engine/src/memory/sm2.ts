/**
 * SM-2 Spaced Repetition Scheduler
 *
 * Schedules knowledge retrieval testing to strengthen important memories.
 * Based on SuperMemo SM-2 algorithm with ease factor ≥ 1.3.
 *
 * Integration: After consolidation, schedule retrieval tests for key findings.
 * Before each round, check which items are due for review.
 */

import { getDb } from '../db/index.js';

export interface SM2Item {
  itemId: string;
  itemType: 'finding' | 'entity' | 'hypothesis';
  easeFactor: number;
  intervalDays: number;
  repetitions: number;
  nextReview: string;
  lastReviewed: string | null;
  retrievalSuccessRate: number;
}

/**
 * Schedule a new item for spaced repetition.
 */
export function scheduleItem(
  itemId: string,
  itemType: SM2Item['itemType'],
): void {
  const db = getDb();

  db.prepare(`INSERT INTO sm2_schedule (item_id, item_type, ease_factor, interval_days, repetitions, next_review)
    VALUES (?, ?, 2.5, 1.0, 0, datetime('now'))
    ON CONFLICT(item_id) DO NOTHING`)
    .run(itemId, itemType);
}

/**
 * Get items due for review.
 */
export function getDueItems(limit: number = 10): SM2Item[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM sm2_schedule
    WHERE next_review <= datetime('now')
    ORDER BY next_review ASC
    LIMIT ?`)
    .all(limit) as any[];

  return rows.map(rowToSM2Item);
}

/**
 * Record a review result and update SM-2 parameters.
 *
 * @param itemId The item reviewed
 * @param quality 0-5 quality score (0-2 = failure, 3-5 = success)
 */
export function recordReview(itemId: string, quality: number): SM2Item | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM sm2_schedule WHERE item_id = ?').get(itemId) as any;
  if (!row) return null;

  const item = rowToSM2Item(row);
  const q = Math.max(0, Math.min(5, Math.round(quality)));

  // SM-2 algorithm
  let newEF = item.easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  newEF = Math.max(1.3, newEF); // Minimum ease factor

  let newInterval: number;
  let newReps: number;

  if (q < 3) {
    // Failed — reset
    newReps = 0;
    newInterval = 1;
  } else {
    // Success
    newReps = item.repetitions + 1;
    if (newReps === 1) {
      newInterval = 1;
    } else if (newReps === 2) {
      newInterval = 6;
    } else {
      newInterval = item.intervalDays * newEF;
    }
  }

  // Update success rate
  const totalReviews = item.repetitions + 1;
  const successes = item.retrievalSuccessRate * item.repetitions + (q >= 3 ? 1 : 0);
  const newSuccessRate = successes / totalReviews;

  db.prepare(`UPDATE sm2_schedule SET
    ease_factor = ?,
    interval_days = ?,
    repetitions = ?,
    next_review = datetime('now', '+' || CAST(? AS TEXT) || ' days'),
    last_reviewed = datetime('now'),
    retrieval_success_rate = ?
    WHERE item_id = ?`)
    .run(newEF, newInterval, newReps, Math.round(newInterval), newSuccessRate, itemId);

  return {
    ...item,
    easeFactor: newEF,
    intervalDays: newInterval,
    repetitions: newReps,
    retrievalSuccessRate: newSuccessRate,
  };
}

/**
 * Get review statistics for reporting.
 */
export function getReviewStats(): {
  totalScheduled: number;
  dueNow: number;
  avgEaseFactor: number;
  avgSuccessRate: number;
} {
  const db = getDb();

  const total = (db.prepare('SELECT COUNT(*) as n FROM sm2_schedule').get() as any).n;
  const due = (db.prepare("SELECT COUNT(*) as n FROM sm2_schedule WHERE next_review <= datetime('now')").get() as any).n;
  const avgEF = (db.prepare('SELECT AVG(ease_factor) as v FROM sm2_schedule').get() as any)?.v || 2.5;
  const avgSR = (db.prepare('SELECT AVG(retrieval_success_rate) as v FROM sm2_schedule WHERE repetitions > 0').get() as any)?.v || 0;

  return {
    totalScheduled: total,
    dueNow: due,
    avgEaseFactor: Math.round(avgEF * 100) / 100,
    avgSuccessRate: Math.round(avgSR * 100) / 100,
  };
}

// --- Helpers ---

function rowToSM2Item(row: any): SM2Item {
  return {
    itemId: row.item_id,
    itemType: row.item_type,
    easeFactor: row.ease_factor,
    intervalDays: row.interval_days,
    repetitions: row.repetitions,
    nextReview: row.next_review,
    lastReviewed: row.last_reviewed,
    retrievalSuccessRate: row.retrieval_success_rate,
  };
}
