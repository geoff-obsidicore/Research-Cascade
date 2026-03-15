/**
 * Knowledge Graph — Entity CRUD + Recursive CTE Traversal
 *
 * Edge-table pattern with SQLite recursive CTEs.
 * Performance: 10K edges <50ms, 100K 50-500ms.
 * ALWAYS ≤3 hop depth limit.
 */

import { getDb } from '../db/index.js';

export interface Entity {
  id: number;
  name: string;
  entityType: string;
  properties: Record<string, any>;
  communityId: number | null;
  betweenness: number;
  tier: 'peripheral' | 'working' | 'core';
  accessCount: number;
  importance: number;
  lastAccessed: string;
  createdAt: string;
}

export interface Edge {
  id: number;
  sourceId: number;
  targetId: number;
  relationType: string;
  weight: number;
  properties: Record<string, any>;
  activationCount: number;
  lastActivated: string;
  createdAt: string;
}

export interface TraversalResult {
  entity: Entity;
  depth: number;
  path: string[];
  edgeType: string;
}

// --- Entity CRUD ---

export function upsertEntity(
  name: string,
  entityType: string,
  properties: Record<string, any> = {},
  tier: Entity['tier'] = 'working',
  importance: number = 0.5,
): number {
  const db = getDb();
  const propsJson = JSON.stringify(properties);

  db.prepare(`INSERT INTO kg_entities (name, entity_type, properties, tier, importance)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(name, entity_type) DO UPDATE SET
      properties = json_patch(properties, excluded.properties),
      importance = MAX(importance, excluded.importance),
      last_accessed = datetime('now'),
      access_count = access_count + 1`)
    .run(name, entityType, propsJson, tier, importance);

  return (db.prepare('SELECT id FROM kg_entities WHERE name = ? AND entity_type = ?').get(name, entityType) as any).id;
}

export function getEntity(name: string, entityType: string): Entity | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM kg_entities WHERE name = ? AND entity_type = ?').get(name, entityType) as any;
  if (!row) return null;

  // Touch access count
  db.prepare('UPDATE kg_entities SET access_count = access_count + 1, last_accessed = datetime(\'now\') WHERE id = ?').run(row.id);

  return rowToEntity(row);
}

export function getEntityById(id: number): Entity | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM kg_entities WHERE id = ?').get(id) as any;
  return row ? rowToEntity(row) : null;
}

export function searchEntities(query: string, limit: number = 20): Entity[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM kg_entities
    WHERE name LIKE ? OR entity_type LIKE ?
    ORDER BY importance DESC, access_count DESC LIMIT ?`)
    .all(`%${query}%`, `%${query}%`, limit) as any[];

  return rows.map(rowToEntity);
}

export function getEntitiesByTier(tier: Entity['tier']): Entity[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM kg_entities WHERE tier = ? ORDER BY importance DESC')
    .all(tier) as any[];
  return rows.map(rowToEntity);
}

// --- Edge CRUD ---

export function upsertEdge(
  sourceId: number,
  targetId: number,
  relationType: string,
  weight: number = 1.0,
  properties: Record<string, any> = {},
): number {
  const db = getDb();

  db.prepare(`INSERT INTO kg_edges (source_id, target_id, relation_type, weight, properties)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_id, target_id, relation_type) DO UPDATE SET
      weight = MAX(weight, excluded.weight),
      activation_count = activation_count + 1,
      last_activated = datetime('now')`)
    .run(sourceId, targetId, relationType, weight, JSON.stringify(properties));

  return (db.prepare('SELECT id FROM kg_edges WHERE source_id = ? AND target_id = ? AND relation_type = ?')
    .get(sourceId, targetId, relationType) as any).id;
}

export function getEdgesFrom(entityId: number): Edge[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM kg_edges WHERE source_id = ? ORDER BY weight DESC')
    .all(entityId) as any[];
  return rows.map(rowToEdge);
}

export function getEdgesTo(entityId: number): Edge[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM kg_edges WHERE target_id = ? ORDER BY weight DESC')
    .all(entityId) as any[];
  return rows.map(rowToEdge);
}

// --- Graph Traversal ---

/**
 * Traverse the graph from a starting entity using recursive CTE.
 * ALWAYS bounded to maxHops ≤ 3.
 */
export function traverse(
  startId: number,
  maxHops: number = 2,
  minWeight: number = 0.0,
  relationFilter?: string,
): TraversalResult[] {
  const db = getDb();
  const hops = Math.min(maxHops, 3); // HARD LIMIT

  const startEntity = db.prepare('SELECT name FROM kg_entities WHERE id = ?').get(startId) as any;
  if (!startEntity) return [];

  let relationClause = '';
  const params: any[] = [startId, startEntity.name, hops, minWeight];

  if (relationFilter) {
    relationClause = 'AND e.relation_type = ?';
    params.push(relationFilter);
  }

  const sql = `
    WITH RECURSIVE graph_walk(entity_id, depth, path, visited) AS (
      SELECT ?, 0, ?, ',' || CAST(? AS TEXT) || ','
      UNION ALL
      SELECT e.target_id, gw.depth + 1,
        gw.path || ' -[' || e.relation_type || ']-> ' || tgt.name,
        gw.visited || CAST(e.target_id AS TEXT) || ','
      FROM graph_walk gw
      JOIN kg_edges e ON e.source_id = gw.entity_id
      JOIN kg_entities tgt ON tgt.id = e.target_id
      WHERE gw.depth < ?
        AND e.weight >= ?
        AND gw.visited NOT LIKE '%,' || CAST(e.target_id AS TEXT) || ',%'
        ${relationClause}
    )
    SELECT DISTINCT
      ent.*, gw.depth, gw.path
    FROM graph_walk gw
    JOIN kg_entities ent ON ent.id = gw.entity_id
    WHERE gw.depth > 0
    ORDER BY gw.depth, ent.importance DESC`;

  // Fix params order: startId, startName, startId (for visited), hops, minWeight, [relationFilter]
  const queryParams = [startId, startEntity.name, startId, hops, minWeight];
  if (relationFilter) queryParams.push(relationFilter);

  const rows = db.prepare(sql).all(...queryParams) as any[];

  // Increment activation counts for traversed edges
  db.prepare(`UPDATE kg_edges SET activation_count = activation_count + 1, last_activated = datetime('now')
    WHERE source_id = ?`).run(startId);

  return rows.map((row: any) => ({
    entity: rowToEntity(row),
    depth: row.depth,
    path: row.path.split(' -> '),
    edgeType: '',
  }));
}

/**
 * Find orphan entities (no incoming or outgoing edges).
 */
export function findOrphans(): Entity[] {
  const db = getDb();
  const rows = db.prepare(`SELECT e.* FROM kg_entities e
    WHERE NOT EXISTS (SELECT 1 FROM kg_edges WHERE source_id = e.id)
    AND NOT EXISTS (SELECT 1 FROM kg_edges WHERE target_id = e.id)`)
    .all() as any[];
  return rows.map(rowToEntity);
}

/**
 * Get graph statistics.
 */
export function getGraphStats(): {
  entityCount: number;
  edgeCount: number;
  avgDegree: number;
  tierCounts: Record<string, number>;
  communityCounts: number;
  orphanCount: number;
} {
  const db = getDb();

  const entityCount = (db.prepare('SELECT COUNT(*) as n FROM kg_entities').get() as any).n;
  const edgeCount = (db.prepare('SELECT COUNT(*) as n FROM kg_edges').get() as any).n;
  const avgDegree = entityCount > 0 ? (2 * edgeCount) / entityCount : 0;

  const tierRows = db.prepare('SELECT tier, COUNT(*) as n FROM kg_entities GROUP BY tier').all() as any[];
  const tierCounts: Record<string, number> = {};
  for (const row of tierRows) tierCounts[row.tier] = row.n;

  const communityCounts = (db.prepare('SELECT COUNT(DISTINCT community_id) as n FROM kg_entities WHERE community_id IS NOT NULL').get() as any).n;
  const orphanCount = (db.prepare(`SELECT COUNT(*) as n FROM kg_entities e
    WHERE NOT EXISTS (SELECT 1 FROM kg_edges WHERE source_id = e.id)
    AND NOT EXISTS (SELECT 1 FROM kg_edges WHERE target_id = e.id)`).get() as any).n;

  return { entityCount, edgeCount, avgDegree, tierCounts, communityCounts, orphanCount };
}

// --- Helpers ---

function rowToEntity(row: any): Entity {
  return {
    id: row.id,
    name: row.name,
    entityType: row.entity_type,
    properties: JSON.parse(row.properties || '{}'),
    communityId: row.community_id,
    betweenness: row.betweenness,
    tier: row.tier,
    accessCount: row.access_count,
    importance: row.importance,
    lastAccessed: row.last_accessed,
    createdAt: row.created_at,
  };
}

function rowToEdge(row: any): Edge {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    relationType: row.relation_type,
    weight: row.weight,
    properties: JSON.parse(row.properties || '{}'),
    activationCount: row.activation_count,
    lastActivated: row.last_activated,
    createdAt: row.created_at,
  };
}
