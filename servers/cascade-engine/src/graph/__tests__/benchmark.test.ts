/**
 * Graph Performance Benchmark
 *
 * Verify recursive CTE traversal performance at scale:
 * - 10K edges: <50ms (agent memory sweet spot)
 * - 100K edges: <500ms (upper practical limit)
 *
 * Also tests structural entropy and phase transition detection at scale.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { __setTestDb } from '../../db/index.js';
import { upsertEntity, upsertEdge, traverse, getGraphStats } from '../entities.js';
import { computeStructuralEntropy, checkPhaseTransition } from '../queries.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db: Database.Database;

function setupTestDb(): Database.Database {
  const testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  testDb.pragma('cache_size = -64000');
  testDb.pragma('temp_store = MEMORY');
  const schemaPath = join(__dirname, '..', '..', 'db', 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  testDb.exec(schema);
  return testDb;
}

/**
 * Seed a random graph with N entities and M edges.
 * Returns array of entity IDs.
 */
function seedGraph(entityCount: number, edgeCount: number): number[] {
  const entityIds: number[] = [];
  const types = ['concept', 'tool', 'technique', 'paper', 'person'];
  const relations = ['relates_to', 'supports', 'uses', 'part_of', 'causes'];

  // Batch insert entities
  const insertEntity = db.prepare(
    `INSERT INTO kg_entities (name, entity_type, properties, tier, importance)
     VALUES (?, ?, '{}', 'working', ?)`
  );

  const insertEdge = db.prepare(
    `INSERT OR IGNORE INTO kg_edges (source_id, target_id, relation_type, weight)
     VALUES (?, ?, ?, ?)`
  );

  const entityTransaction = db.transaction(() => {
    for (let i = 0; i < entityCount; i++) {
      const result = insertEntity.run(
        `entity_${i}`,
        types[i % types.length],
        Math.random() * 0.5 + 0.5,
      );
      entityIds.push(Number(result.lastInsertRowid));
    }
  });

  const edgeTransaction = db.transaction(() => {
    for (let i = 0; i < edgeCount; i++) {
      const source = entityIds[Math.floor(Math.random() * entityIds.length)];
      const target = entityIds[Math.floor(Math.random() * entityIds.length)];
      if (source !== target) {
        insertEdge.run(
          source, target,
          relations[i % relations.length],
          Math.random() * 0.5 + 0.5,
        );
      }
    }
  });

  entityTransaction();
  edgeTransaction();

  return entityIds;
}

describe('Graph Performance Benchmarks', () => {
  beforeEach(() => {
    db = setupTestDb();
    __setTestDb(db);
  });

  afterEach(() => {
    __setTestDb(null);
    db.close();
  });

  it('should traverse 10K edges in <50ms (≤3 hops)', () => {
    const entityCount = 1000;
    const edgeCount = 10000;
    const entityIds = seedGraph(entityCount, edgeCount);

    const stats = getGraphStats();
    expect(stats.edgeCount).toBeGreaterThan(5000); // Some dupes filtered by UNIQUE constraint

    // Pick a well-connected starting node
    const startId = entityIds[0];

    // Warm up
    traverse(startId, 2, 0.0);

    // Benchmark
    const start = performance.now();
    const results = traverse(startId, 3, 0.0);
    const elapsed = performance.now() - start;

    console.error(`  10K edges: ${results.length} nodes reached in ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(50);
  });

  it('should traverse 100K edges in <500ms (≤3 hops)', () => {
    const entityCount = 5000;
    const edgeCount = 100000;
    const entityIds = seedGraph(entityCount, edgeCount);

    const stats = getGraphStats();
    console.error(`  Graph: ${stats.entityCount} entities, ${stats.edgeCount} edges, avg degree ${stats.avgDegree.toFixed(1)}`);

    const startId = entityIds[0];

    // Warm up
    traverse(startId, 2, 0.0);

    // Benchmark
    const start = performance.now();
    const results = traverse(startId, 3, 0.0);
    const elapsed = performance.now() - start;

    console.error(`  100K edges: ${results.length} nodes reached in ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(500);
  });

  it('should compute structural entropy efficiently at 10K edges', () => {
    seedGraph(1000, 10000);

    const start = performance.now();
    const result = computeStructuralEntropy();
    const elapsed = performance.now() - start;

    console.error(`  Structural entropy (10K): H=${result.entropy.toFixed(3)}, avg_degree=${result.avgDegree.toFixed(2)}, GC=${result.giantComponentFraction.toFixed(2)} in ${elapsed.toFixed(1)}ms`);

    expect(result.entropy).toBeGreaterThan(0);
    expect(result.avgDegree).toBeGreaterThan(1);
    expect(elapsed).toBeLessThan(200);
  });

  it('should detect phase transition with sufficient edges', () => {
    // Pre-percolation: sparse graph
    seedGraph(100, 30);
    const sparse = checkPhaseTransition();
    console.error(`  Sparse graph (30 edges): ${sparse.phase}, avg_degree=${sparse.indicators.avgDegree.toFixed(2)}`);

    // Reset
    __setTestDb(null);
    db.close();
    db = setupTestDb();
    __setTestDb(db);

    // Post-percolation: dense graph
    seedGraph(100, 500);
    const dense = checkPhaseTransition();
    console.error(`  Dense graph (500 edges): ${dense.phase}, avg_degree=${dense.indicators.avgDegree.toFixed(2)}`);

    // Dense graph should have higher avg degree
    expect(dense.indicators.avgDegree).toBeGreaterThan(sparse.indicators.avgDegree);
  });

  it('should handle hub detection at scale', async () => {
    seedGraph(1000, 10000);

    const start = performance.now();
    const { findHubs } = await import('../queries.js');
    const { hubs, overconnected } = findHubs(50);
    const elapsed = performance.now() - start;

    console.error(`  Hub detection (10K): ${hubs.length} hubs found, ${overconnected.length} overconnected, in ${elapsed.toFixed(1)}ms`);

    expect(hubs.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(200);
  });
});
