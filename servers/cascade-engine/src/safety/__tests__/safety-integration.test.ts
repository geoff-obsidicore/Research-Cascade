/**
 * Integration tests for the operational-safety hardening: reversible tombstones
 * (AFR-12), real-time anomaly interventions (AFR-17), and the action log (AFR-16).
 * Uses the same in-memory-DB pattern as the e2e suite.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { __setTestDb } from '../../db/index.js';
import { applySteer } from '../../hitl/steering.js';
import { checkInterventions } from '../../hitl/interventions.js';
import { reviewQuarantined } from '../../trust/ingestion.js';
import { logAction, getRecentActions } from '../audit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function setupTestDb(): Database.Database {
  const testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  testDb.exec(readFileSync(join(__dirname, '..', '..', 'db', 'schema.sql'), 'utf-8'));
  return testDb;
}

let db: Database.Database;

function seedCascade(id: string, tokensUsed = 0, budget = 100_000): void {
  db.prepare(`INSERT INTO cascades (id, question, status, tokens_used, token_budget)
    VALUES (?, 'q', 'investigating', ?, ?)`).run(id, tokensUsed, budget);
}
function seedFinding(id: string, cascadeId: string, quarantined = 0): void {
  db.prepare(`INSERT INTO findings (id, cascade_id, claim, confidence, quarantined, cascade_round)
    VALUES (?, ?, ?, 0.6, ?, 0)`).run(id, cascadeId, `claim ${id}`, quarantined);
}

describe('operational safety hardening', () => {
  beforeEach(() => { db = setupTestDb(); __setTestDb(db); });
  afterEach(() => { __setTestDb(null); db.close(); });

  it('reject steer tombstones a finding rather than DELETE-ing it (AFR-12)', () => {
    seedCascade('c1');
    seedFinding('f1', 'c1');
    const steerId = Number(db.prepare(`INSERT INTO steer_events (cascade_id, event_type, instruction, target_id)
      VALUES ('c1','reject','poisoned source','f1')`).run().lastInsertRowid);

    applySteer(steerId);

    const row = db.prepare('SELECT rejected, quarantined, retrieval_weight FROM findings WHERE id = ?').get('f1') as any;
    expect(row).toBeTruthy();          // survived — not destroyed
    expect(row.rejected).toBe(1);
    expect(row.quarantined).toBe(1);
    expect(row.retrieval_weight).toBe(0);
  });

  it('reviewQuarantined(false) tombstones rather than deletes', () => {
    seedCascade('c2');
    seedFinding('f2', 'c2', 1);
    reviewQuarantined('f2', false);
    const row = db.prepare('SELECT rejected FROM findings WHERE id = ?').get('f2') as any;
    expect(row).toBeTruthy();
    expect(row.rejected).toBe(1);
  });

  it('budget_overrun raises a blocking intervention (AFR-17)', () => {
    seedCascade('c3', 100_000, 100_000); // used == budget
    const budget = checkInterventions('c3').find((i) => i.category === 'budget_overrun');
    expect(budget).toBeTruthy();
    expect(budget!.level).toBe('blocking');
  });

  it('quarantine_spike raises a blocking intervention above 50% (AFR-17)', () => {
    seedCascade('c4');
    for (let i = 0; i < 4; i++) seedFinding(`q${i}`, 'c4', 1); // quarantined
    for (let i = 0; i < 2; i++) seedFinding(`a${i}`, 'c4', 0); // clean
    const spike = checkInterventions('c4').find((i) => i.category === 'quarantine_spike'); // 4/6
    expect(spike).toBeTruthy();
    expect(spike!.level).toBe('blocking');
  });

  it('action_log records and replays tool actions, newest first (AFR-16)', () => {
    logAction('store_finding', 'ok', { cascadeId: 'c5' });
    logAction('apply_steer', 'blocked', { cascadeId: 'c5', detail: 'engine halted' });
    const rows = getRecentActions(10, 'c5');
    expect(rows.length).toBe(2);
    expect(rows[0].tool).toBe('apply_steer');
    expect(rows[0].consequence).toBe('high');
    expect(rows[0].status).toBe('blocked');
    expect(rows[1].tool).toBe('store_finding');
  });
});
