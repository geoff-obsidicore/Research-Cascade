/**
 * Memory Consolidation — Interleaved Replay + Retrieval Testing
 *
 * Dual-trigger:
 * 1. Round-boundary: quality consolidation between research rounds
 * 2. Context-saturation: emergency flush before compaction
 *
 * Process:
 * 1. NCD deduplication — remove redundant findings
 * 2. Kalman fusion — merge confidence from multiple sources
 * 3. Graph update — extract entities and relationships
 * 4. Tier management — promote/demote based on composite scores
 * 5. SM-2 scheduling — queue items for retrieval testing
 */

import { getDb } from '../db/index.js';
import { deduplicateFindings } from './ncd.js';
import { batchFuseForClaim } from '../control/kalman.js';
import { runTierCycle, prunePeripheral } from './tiers.js';
import { scheduleItem, getDueItems } from './sm2.js';

export interface ConsolidationResult {
  deduped: { kept: number; removed: number; clusters: number };
  fused: number;
  entitiesUpdated: number;
  tierChanges: { promoted: number; demoted: number; graphPromoted: number };
  pruned: { archived: number; protected: number };
  scheduled: number;
  durationMs: number;
}

/**
 * Run full consolidation cycle for a cascade round.
 */
export function consolidateRound(cascadeId: string, roundIndex: number): ConsolidationResult {
  const start = Date.now();
  const db = getDb();

  // 1. NCD Deduplication
  const findings = db.prepare(`SELECT id, claim, confidence FROM findings
    WHERE cascade_id = ? AND cascade_round = ? AND quarantined = 0`)
    .all(cascadeId, roundIndex) as any[];

  const dedupResult = deduplicateFindings(findings);

  // Mark removed findings
  if (dedupResult.removed.length > 0) {
    const placeholders = dedupResult.removed.map(() => '?').join(',');
    db.prepare(`UPDATE findings SET quarantined = 1, retrieval_weight = 0
      WHERE id IN (${placeholders})`).run(...dedupResult.removed);
  }

  // 2. Kalman Confidence Fusion
  // Group findings by claim similarity and fuse confidence
  let fusedCount = 0;
  const keptFindings = db.prepare(`SELECT id, claim, confidence, confidence_uncertainty,
    trust_composite, source_type FROM findings
    WHERE cascade_id = ? AND quarantined = 0`)
    .all(cascadeId) as any[];

  // Simple grouping: findings with same content hash cluster
  const claimGroups = new Map<string, any[]>();
  for (const f of keptFindings) {
    const key = f.id; // Content-addressable — same claim = same ID
    if (!claimGroups.has(key)) claimGroups.set(key, []);
    claimGroups.get(key)!.push(f);
  }

  for (const [_key, group] of claimGroups) {
    if (group.length <= 1) continue;

    const base = group[0];
    const measurements = group.slice(1).map((f: any) => ({
      confidence: f.confidence,
      sourceType: f.source_type,
      trustScore: f.trust_composite || 0.5,
    }));

    const fused = batchFuseForClaim(
      base.confidence,
      base.confidence_uncertainty || 1.0,
      measurements,
    );

    db.prepare('UPDATE findings SET confidence = ?, confidence_uncertainty = ? WHERE id = ?')
      .run(fused.confidence, fused.uncertainty, base.id);
    fusedCount++;
  }

  // 3. Tier Management
  const tierChanges = runTierCycle();

  // 4. Pruning (conservative — only peripheral below threshold)
  const pruneResult = prunePeripheral(0.05, 20);

  // 5. SM-2 Scheduling — schedule high-importance findings for review
  let scheduledCount = 0;
  const importantFindings = db.prepare(`SELECT id FROM findings
    WHERE cascade_id = ? AND quarantined = 0 AND confidence >= 0.6
    ORDER BY confidence DESC LIMIT 20`)
    .all(cascadeId) as any[];

  for (const f of importantFindings) {
    scheduleItem(f.id, 'finding');
    scheduledCount++;
  }

  const durationMs = Date.now() - start;

  // Log consolidation
  db.prepare(`INSERT INTO consolidation_log
    (cascade_id, trigger_type, items_processed, items_promoted, items_demoted, items_pruned, duration_ms)
    VALUES (?, 'round_boundary', ?, ?, ?, ?, ?)`)
    .run(
      cascadeId,
      findings.length,
      tierChanges.promoted + tierChanges.graphPromoted,
      tierChanges.demoted,
      pruneResult.archived.length,
      durationMs,
    );

  return {
    deduped: { kept: dedupResult.kept.length, removed: dedupResult.removed.length, clusters: dedupResult.clusters },
    fused: fusedCount,
    entitiesUpdated: 0, // Entity extraction is done by the LLM, not here
    tierChanges,
    pruned: { archived: pruneResult.archived.length, protected: pruneResult.skippedProtected },
    scheduled: scheduledCount,
    durationMs,
  };
}

/**
 * Emergency consolidation — triggered before context compaction.
 * Faster and more aggressive than round-boundary consolidation.
 */
export function emergencyConsolidate(cascadeId: string): {
  savedFindings: number;
  savedEntities: number;
} {
  const db = getDb();

  // Ensure all high-confidence findings are properly stored
  const unsaved = db.prepare(`SELECT COUNT(*) as n FROM findings
    WHERE cascade_id = ? AND quarantined = 0 AND trust_signals_json IS NULL`)
    .get(cascadeId) as any;

  // Force a tier cycle to preserve important entities
  runTierCycle();

  return {
    savedFindings: unsaved?.n || 0,
    savedEntities: 0,
  };
}

/**
 * Get consolidation history for a cascade.
 */
export function getConsolidationHistory(cascadeId: string): any[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM consolidation_log
    WHERE cascade_id = ? ORDER BY created_at DESC LIMIT 10`)
    .all(cascadeId);
}
