/**
 * Advanced Graph Queries
 *
 * Includes the "money query" (hybrid vector + graph + FTS),
 * bridge detection, and community-boundary analysis.
 */

import { getDb } from '../db/index.js';

/**
 * Find entities that bridge two communities (high betweenness).
 * These are the most valuable for cross-domain reasoning.
 */
export function findBridgeEntities(minBetweenness: number = 0.1, limit: number = 10): any[] {
  const db = getDb();
  return db.prepare(`SELECT e.*, COUNT(DISTINCT e2.community_id) as communities_bridged
    FROM kg_entities e
    JOIN kg_edges ed ON ed.source_id = e.id
    JOIN kg_entities e2 ON e2.id = ed.target_id
    WHERE e.betweenness >= ?
    AND e.community_id IS NOT NULL
    AND e2.community_id IS NOT NULL
    AND e.community_id != e2.community_id
    GROUP BY e.id
    ORDER BY e.betweenness DESC
    LIMIT ?`)
    .all(minBetweenness, limit);
}

/**
 * Find entities with high degree (potential hubs).
 * Guards against hub-and-spoke collapse with max edge alert.
 */
export function findHubs(maxEdges: number = 50): {
  hubs: any[];
  overconnected: any[];
} {
  const db = getDb();

  const hubs = db.prepare(`SELECT e.id, e.name, e.entity_type, e.tier,
    (SELECT COUNT(*) FROM kg_edges WHERE source_id = e.id) +
    (SELECT COUNT(*) FROM kg_edges WHERE target_id = e.id) as degree
    FROM kg_entities e
    ORDER BY degree DESC LIMIT 20`)
    .all() as any[];

  const overconnected = hubs.filter(h => h.degree > maxEdges);

  return { hubs, overconnected };
}

/**
 * Find entities that are semantically similar but topologically distant.
 * These are Luhmann's "surprises" — the most valuable latent connections.
 * (Requires embedding data — returns candidates for LLM analysis)
 */
export function findLatentBridgeCandidates(minHops: number = 4): any[] {
  const db = getDb();

  // Find pairs with no short path between them
  // This is approximate — full shortest path on all pairs is too expensive
  // Instead, find entities in different communities with no direct edges
  return db.prepare(`SELECT
    e1.id as entity1_id, e1.name as entity1_name, e1.entity_type as entity1_type,
    e2.id as entity2_id, e2.name as entity2_name, e2.entity_type as entity2_type,
    e1.community_id as community1, e2.community_id as community2
    FROM kg_entities e1
    JOIN kg_entities e2 ON e1.id < e2.id
    WHERE e1.community_id IS NOT NULL
    AND e2.community_id IS NOT NULL
    AND e1.community_id != e2.community_id
    AND e1.tier IN ('working', 'core')
    AND e2.tier IN ('working', 'core')
    AND NOT EXISTS (
      SELECT 1 FROM kg_edges
      WHERE (source_id = e1.id AND target_id = e2.id)
      OR (source_id = e2.id AND target_id = e1.id)
    )
    ORDER BY e1.importance + e2.importance DESC
    LIMIT 20`)
    .all();
}

/**
 * Compute structural entropy H_SI = -Σ(d_v/2m) × log2(d_v/2m)
 * Fast proxy for graph complexity — O(n).
 */
export function computeStructuralEntropy(): {
  entropy: number;
  avgDegree: number;
  giantComponentFraction: number;
} {
  const db = getDb();

  const entityCount = (db.prepare('SELECT COUNT(*) as n FROM kg_entities').get() as any).n;
  const edgeCount = (db.prepare('SELECT COUNT(*) as n FROM kg_edges').get() as any).n;

  if (entityCount === 0 || edgeCount === 0) {
    return { entropy: 0, avgDegree: 0, giantComponentFraction: 0 };
  }

  const m2 = 2 * edgeCount; // sum of degrees
  const avgDegree = m2 / entityCount;

  // Get degree distribution
  const degrees = db.prepare(`SELECT
    (SELECT COUNT(*) FROM kg_edges WHERE source_id = e.id) +
    (SELECT COUNT(*) FROM kg_edges WHERE target_id = e.id) as degree
    FROM kg_entities e`)
    .all() as any[];

  // H_SI = -Σ(d_v/2m) × log2(d_v/2m)
  let entropy = 0;
  for (const { degree } of degrees) {
    if (degree > 0) {
      const p = degree / m2;
      entropy -= p * Math.log2(p);
    }
  }

  // Giant component fraction — approximate via BFS from highest-degree node
  const giantComponentFraction = estimateGiantComponentFraction(db, entityCount);

  return { entropy, avgDegree, giantComponentFraction };
}

/**
 * Approximate giant component fraction by BFS from the highest-degree node.
 */
function estimateGiantComponentFraction(db: any, totalNodes: number): number {
  if (totalNodes === 0) return 0;

  // Start from highest-degree node
  const start = db.prepare(`SELECT e.id,
    (SELECT COUNT(*) FROM kg_edges WHERE source_id = e.id) +
    (SELECT COUNT(*) FROM kg_edges WHERE target_id = e.id) as degree
    FROM kg_entities e ORDER BY degree DESC LIMIT 1`).get() as any;

  if (!start) return 0;

  // BFS via recursive CTE (bounded)
  const reachable = db.prepare(`WITH RECURSIVE component(id) AS (
    SELECT ?
    UNION
    SELECT CASE WHEN e.source_id = c.id THEN e.target_id ELSE e.source_id END
    FROM component c
    JOIN kg_edges e ON e.source_id = c.id OR e.target_id = c.id
    WHERE CASE WHEN e.source_id = c.id THEN e.target_id ELSE e.source_id END NOT IN (SELECT id FROM component)
  )
  SELECT COUNT(*) as n FROM component`)
    .get(start.id) as any;

  return reachable.n / totalNodes;
}

/**
 * Check phase transition indicators.
 * Pre-threshold → maximize breadth. Post-threshold → exploit structure.
 */
export function checkPhaseTransition(): {
  phase: 'pre_percolation' | 'near_threshold' | 'post_percolation';
  indicators: Record<string, number>;
  recommendation: string;
} {
  const { entropy, avgDegree, giantComponentFraction } = computeStructuralEntropy();

  const indicators = {
    avgDegree,
    giantComponentFraction,
    entropy,
  };

  if (avgDegree < 0.8 || giantComponentFraction < 0.3) {
    return {
      phase: 'pre_percolation',
      indicators,
      recommendation: 'Graph is sparse. Maximize breadth — every new edge moves toward criticality. Focus on exploration.',
    };
  }

  if (avgDegree >= 0.8 && avgDegree <= 1.5 && giantComponentFraction >= 0.3 && giantComponentFraction <= 0.7) {
    return {
      phase: 'near_threshold',
      indicators,
      recommendation: 'Near percolation threshold! Adjacent possible growing combinatorially. Balance exploration and exploitation.',
    };
  }

  return {
    phase: 'post_percolation',
    indicators,
    recommendation: 'Post-percolation. Exploit structure — target community-boundary contradictions as research frontiers.',
  };
}

/**
 * Find contradictions in the graph — edges where both 'supports' and 'contradicts' exist.
 */
export function findContradictions(): any[] {
  const db = getDb();
  return db.prepare(`SELECT
    e1.source_id, s.name as source_name,
    e1.target_id, t.name as target_name,
    e1.relation_type as rel1, e1.weight as w1,
    e2.relation_type as rel2, e2.weight as w2
    FROM kg_edges e1
    JOIN kg_edges e2 ON e1.source_id = e2.source_id AND e1.target_id = e2.target_id
    JOIN kg_entities s ON s.id = e1.source_id
    JOIN kg_entities t ON t.id = e1.target_id
    WHERE e1.relation_type = 'supports' AND e2.relation_type = 'contradicts'`)
    .all();
}
