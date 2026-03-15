/**
 * Memory Tier Management — Weibull Decay + Graph-Aware Promotion
 *
 * Tiers:
 *   Core       — k=0.8 (Lindy effect — survives longer over time)
 *   Working    — k=1.0 (standard exponential decay)
 *   Peripheral — k=1.3 (fades fast)
 *
 * Composite score: 0.4×weibull + 0.3×min(1, access/10) + 0.3×importance×confidence
 *
 * Promotion: Working→Core when access≥10 AND composite≥0.7
 * Demotion: Working→Peripheral when composite<0.15
 * Graph-aware: peripheral connected to ≥2 core entities → promoted (spreading activation)
 */

import { getDb } from '../db/index.js';

export interface TierConfig {
  k: number;      // Weibull shape parameter
  lambda: number;  // Weibull scale parameter (days)
}

const TIER_PARAMS: Record<string, TierConfig> = {
  core:       { k: 0.8, lambda: 90 },  // Lindy: decays slower over time
  working:    { k: 1.0, lambda: 30 },  // Standard exponential
  peripheral: { k: 1.3, lambda: 14 },  // Fades fast
};

/**
 * Compute Weibull survival probability.
 * S(t) = exp(-(t/λ)^k)
 */
export function weibullSurvival(ageDays: number, tier: string): number {
  const params = TIER_PARAMS[tier] || TIER_PARAMS.working;
  return Math.exp(-Math.pow(ageDays / params.lambda, params.k));
}

/**
 * Compute composite score for an entity.
 */
export function computeComposite(
  ageDays: number,
  tier: string,
  accessCount: number,
  importance: number,
  confidence: number = 1.0,
): number {
  const weibull = weibullSurvival(ageDays, tier);
  const accessScore = Math.min(1, accessCount / 10);
  const qualityScore = importance * confidence;

  return 0.4 * weibull + 0.3 * accessScore + 0.3 * qualityScore;
}

/**
 * Run tier promotion/demotion cycle across all entities.
 * Returns counts of changes made.
 */
export function runTierCycle(): {
  promoted: number;
  demoted: number;
  graphPromoted: number;
} {
  const db = getDb();
  let promoted = 0;
  let demoted = 0;
  let graphPromoted = 0;

  const entities = db.prepare(`SELECT id, tier, access_count, importance, last_accessed, created_at
    FROM kg_entities`).all() as any[];

  const updateTier = db.prepare('UPDATE kg_entities SET tier = ? WHERE id = ?');

  const transaction = db.transaction(() => {
    for (const entity of entities) {
      const ageDays = daysSince(entity.created_at);
      const composite = computeComposite(ageDays, entity.tier, entity.access_count, entity.importance);

      // Standard promotion/demotion
      if (entity.tier === 'working' && entity.access_count >= 10 && composite >= 0.7) {
        updateTier.run('core', entity.id);
        promoted++;
      } else if (entity.tier === 'working' && composite < 0.15) {
        updateTier.run('peripheral', entity.id);
        demoted++;
      } else if (entity.tier === 'core' && composite < 0.3) {
        updateTier.run('working', entity.id);
        demoted++;
      }
    }

    // Graph-aware promotion: peripheral connected to ≥2 core entities
    const graphCandidates = db.prepare(`SELECT p.id FROM kg_entities p
      WHERE p.tier = 'peripheral'
      AND (
        SELECT COUNT(DISTINCT c.id) FROM kg_entities c
        JOIN kg_edges e ON (e.source_id = c.id AND e.target_id = p.id)
          OR (e.target_id = c.id AND e.source_id = p.id)
        WHERE c.tier = 'core'
      ) >= 2`).all() as any[];

    for (const candidate of graphCandidates) {
      updateTier.run('working', candidate.id);
      graphPromoted++;
    }
  });

  transaction();

  // Log the cycle
  db.prepare(`INSERT INTO consolidation_log (trigger_type, items_processed, items_promoted, items_demoted)
    VALUES ('round_boundary', ?, ?, ?)`).run(entities.length, promoted + graphPromoted, demoted);

  return { promoted, demoted, graphPromoted };
}

/**
 * Apply CD47 protection — mark active/cited entities as immune from pruning.
 */
export function applyCD47Protection(cascadeId: string): number {
  const db = getDb();

  // Protect entities referenced in non-quarantined findings
  const result = db.prepare(`UPDATE kg_entities SET tier = MAX(tier, 'working')
    WHERE id IN (
      SELECT ec.entity_id FROM kg_entity_chunks ec
      JOIN findings f ON ec.chunk_id = f.id
      WHERE f.cascade_id = ? AND f.quarantined = 0 AND f.cd47_protected = 1
    )`).run(cascadeId);

  return result.changes;
}

/**
 * Prune low-value entities (archive, never delete).
 * Only prunes peripheral entities with composite below threshold.
 */
export function prunePeripheral(
  threshold: number = 0.05,
  maxPrune: number = 50,
): { archived: string[]; skippedProtected: number } {
  const db = getDb();
  const archived: string[] = [];
  let skippedProtected = 0;

  const candidates = db.prepare(`SELECT id, name, entity_type, access_count, importance, created_at
    FROM kg_entities WHERE tier = 'peripheral'
    ORDER BY importance ASC, access_count ASC
    LIMIT ?`).all(maxPrune) as any[];

  const transaction = db.transaction(() => {
    for (const entity of candidates) {
      const ageDays = daysSince(entity.created_at);
      const composite = computeComposite(ageDays, 'peripheral', entity.access_count, entity.importance);

      if (composite >= threshold) continue;

      // Check CD47 protection — connected to active findings
      const hasActiveLinks = (db.prepare(`SELECT COUNT(*) as n FROM kg_edges
        WHERE (source_id = ? OR target_id = ?) AND activation_count > 0`)
        .get(entity.id, entity.id) as any).n > 0;

      if (hasActiveLinks) {
        skippedProtected++;
        continue;
      }

      // Archive: move to a special "archived" property, don't delete
      db.prepare(`UPDATE kg_entities SET
        tier = 'peripheral',
        properties = json_set(properties, '$.archived', 1, '$.archived_at', datetime('now'))
        WHERE id = ?`).run(entity.id);
      archived.push(entity.name);
    }
  });

  transaction();
  return { archived, skippedProtected };
}

// --- Helpers ---

function daysSince(dateStr: string): number {
  const then = new Date(dateStr).getTime();
  const now = Date.now();
  return (now - then) / (1000 * 60 * 60 * 24);
}
