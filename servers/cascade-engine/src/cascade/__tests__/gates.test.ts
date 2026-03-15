import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { __setTestDb } from '../../db/index.js';
import { evaluateStoppingGates } from '../gates.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db: Database.Database;

function setupTestDb(): Database.Database {
  const testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  const schemaPath = join(__dirname, '..', '..', 'db', 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  testDb.exec(schema);
  return testDb;
}

describe('Quality Gates', () => {
  beforeEach(() => {
    db = setupTestDb();
    __setTestDb(db);
  });

  afterEach(() => {
    __setTestDb(null);
    db.close();
  });

  it('should detect max rounds reached', () => {
    db.prepare(`INSERT INTO cascades (id, question, status, current_round, max_rounds, token_budget, tokens_used)
      VALUES ('test1', 'test question', 'investigating', 5, 5, 500000, 100)`).run();

    const result = evaluateStoppingGates('test1');
    expect(result.shouldStop).toBe(true);
    expect(result.gates.find(g => g.gate === 'max_rounds')?.passed).toBe(false);
  });

  it('should detect token budget exhausted', () => {
    db.prepare(`INSERT INTO cascades (id, question, status, current_round, max_rounds, token_budget, tokens_used)
      VALUES ('test2', 'test question', 'investigating', 1, 5, 1000, 2000)`).run();

    const result = evaluateStoppingGates('test2');
    expect(result.shouldStop).toBe(true);
    expect(result.gates.find(g => g.gate === 'token_budget')?.passed).toBe(false);
  });

  it('should continue when within budget', () => {
    db.prepare(`INSERT INTO cascades (id, question, status, current_round, max_rounds, token_budget, tokens_used)
      VALUES ('test3', 'test question', 'investigating', 1, 5, 500000, 100)`).run();

    const result = evaluateStoppingGates('test3');
    const roundGate = result.gates.find(g => g.gate === 'max_rounds');
    const tokenGate = result.gates.find(g => g.gate === 'token_budget');
    expect(roundGate?.passed).toBe(true);
    expect(tokenGate?.passed).toBe(true);
  });

  it('should detect diminishing returns', () => {
    db.prepare(`INSERT INTO cascades (id, question, status, current_round, max_rounds, token_budget, tokens_used)
      VALUES ('test4', 'test', 'investigating', 2, 5, 500000, 100)`).run();

    for (let i = 0; i < 10; i++) {
      db.prepare(`INSERT INTO findings (id, cascade_id, claim, confidence, cascade_round)
        VALUES (?, 'test4', ?, 0.7, 0)`).run(`f0-${i}`, `Claim ${i} round 0`);
    }
    for (let i = 0; i < 2; i++) {
      db.prepare(`INSERT INTO findings (id, cascade_id, claim, confidence, cascade_round)
        VALUES (?, 'test4', ?, 0.7, 1)`).run(`f1-${i}`, `Claim ${i} round 1`);
    }

    const result = evaluateStoppingGates('test4');
    const dimGate = result.gates.find(g => g.gate === 'diminishing_returns');
    expect(dimGate).toBeDefined();
    expect(dimGate?.passed).toBe(false);
  });
});
