import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { __setTestDb } from '../../db/index.js';

let db: Database.Database;

function setupTestDb(): Database.Database {
  const testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  testDb.pragma('foreign_keys = ON');
  const schemaPath = join(__dirname, '..', '..', 'db', 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  testDb.exec(schema);
  return testDb;
}

describe('SM-2 Spaced Repetition', () => {
  beforeEach(() => {
    db = setupTestDb();
    __setTestDb(db);
  });

  afterEach(() => {
    db.close();
    __setTestDb(null);
  });

  it('should schedule a new item', async () => {
    const { scheduleItem, getReviewStats } = await import('../sm2.js');
    scheduleItem('finding-1', 'finding');

    const stats = getReviewStats();
    expect(stats.totalScheduled).toBe(1);
  });

  it('should not duplicate schedules', async () => {
    const { scheduleItem, getReviewStats } = await import('../sm2.js');
    scheduleItem('finding-1', 'finding');
    scheduleItem('finding-1', 'finding');

    const stats = getReviewStats();
    expect(stats.totalScheduled).toBe(1);
  });

  it('should increase interval on successful review', async () => {
    const { scheduleItem, recordReview } = await import('../sm2.js');
    scheduleItem('finding-1', 'finding');

    const after = recordReview('finding-1', 4); // Good recall
    expect(after).toBeTruthy();
    expect(after!.repetitions).toBe(1);
    expect(after!.intervalDays).toBeGreaterThanOrEqual(1);
  });

  it('should reset on failed review', async () => {
    const { scheduleItem, recordReview } = await import('../sm2.js');
    scheduleItem('finding-1', 'finding');

    // First success
    recordReview('finding-1', 4);
    // Then failure
    const after = recordReview('finding-1', 1);
    expect(after!.repetitions).toBe(0);
    expect(after!.intervalDays).toBe(1);
  });

  it('should enforce minimum ease factor of 1.3', async () => {
    const { scheduleItem, recordReview } = await import('../sm2.js');
    scheduleItem('finding-1', 'finding');

    // Many poor reviews
    for (let i = 0; i < 10; i++) {
      recordReview('finding-1', 3); // Barely passing
    }

    const item = recordReview('finding-1', 3);
    expect(item!.easeFactor).toBeGreaterThanOrEqual(1.3);
  });
});
