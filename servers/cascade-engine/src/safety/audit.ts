/**
 * Action log (AFR-16) — a replayable record of every tool invocation.
 *
 * The engine already keeps a *content* audit trail (ingestion_audit_log,
 * consolidation_log, metrics). This is the complementary *behaviour* trail:
 * which tool ran, against which cascade, and whether it succeeded, was blocked
 * by the kill-switch, or errored. Written by the tool guard in index.ts so no
 * handler can forget to log. Logging never throws — a broken audit must not
 * take down a tool call.
 */

import { getDb } from '../db/index.js';
import { toolConsequence } from './policy.js';

export type ActionStatus = 'ok' | 'error' | 'blocked';

export function logAction(
  tool: string,
  status: ActionStatus,
  opts: { cascadeId?: string; detail?: string } = {},
): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO action_log (tool, consequence, cascade_id, status, detail)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(tool, toolConsequence(tool), opts.cascadeId ?? null, status, opts.detail ?? null);
  } catch {
    /* audit logging is best-effort — never break the tool call */
  }
}

/** Recent actions, newest first — the replay surface (CLI `actions`). */
export function getRecentActions(limit = 50, cascadeId?: string): any[] {
  const db = getDb();
  if (cascadeId) {
    return db
      .prepare(`SELECT * FROM action_log WHERE cascade_id = ? ORDER BY id DESC LIMIT ?`)
      .all(cascadeId, limit);
  }
  return db.prepare(`SELECT * FROM action_log ORDER BY id DESC LIMIT ?`).all(limit);
}
