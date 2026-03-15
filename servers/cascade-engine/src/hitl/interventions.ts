/**
 * HITL Intervention Taxonomy
 *
 * BLOCKING: Round 0 hypothesis (always), hypothesis drift >0.6, round boundaries (15min timeout)
 * ADVISORY: trust <0.4 (2min), circuit breaker open (1min), confidence <0.5 (3min)
 * SILENT: search planning (log only)
 *
 * Each intervention point has a timeout — if no human response, auto-proceeds.
 */

import { getDb } from '../db/index.js';

export type InterventionLevel = 'blocking' | 'advisory' | 'silent';

export interface Intervention {
  id: string;
  cascadeId: string;
  level: InterventionLevel;
  category: string;
  description: string;
  context: Record<string, any>;
  timeoutMinutes: number;
  createdAt: string;
  resolvedAt?: string;
  resolution?: 'approved' | 'rejected' | 'timeout' | 'redirected';
  humanComment?: string;
}

interface InterventionRule {
  category: string;
  level: InterventionLevel;
  timeoutMinutes: number;
  check: (cascadeId: string, context: any) => { triggered: boolean; description: string; context: Record<string, any> };
}

const RULES: InterventionRule[] = [
  // BLOCKING: Round 0 hypothesis — always require human approval
  {
    category: 'initial_hypothesis',
    level: 'blocking',
    timeoutMinutes: 15,
    check: (cascadeId, ctx) => {
      const db = getDb();
      const cascade = db.prepare('SELECT current_round FROM cascades WHERE id = ?').get(cascadeId) as any;
      if (!cascade || cascade.current_round > 0) return { triggered: false, description: '', context: {} };

      const hyps = db.prepare('SELECT id, statement, affinity FROM hypotheses WHERE cascade_id = ? AND status = \'proposed\'')
        .all(cascadeId) as any[];

      if (hyps.length === 0) return { triggered: false, description: '', context: {} };

      return {
        triggered: true,
        description: `Round 0: ${hyps.length} initial hypotheses need approval before research begins.`,
        context: { hypotheses: hyps },
      };
    },
  },

  // BLOCKING: Hypothesis drift — affinity changed > 0.6 from original
  {
    category: 'hypothesis_drift',
    level: 'blocking',
    timeoutMinutes: 15,
    check: (cascadeId, _ctx) => {
      const db = getDb();
      const drifted = db.prepare(`SELECT id, statement, affinity FROM hypotheses
        WHERE cascade_id = ? AND ABS(affinity - 0.5) > 0.6 AND status = 'testing'`)
        .all(cascadeId) as any[];

      if (drifted.length === 0) return { triggered: false, description: '', context: {} };

      return {
        triggered: true,
        description: `${drifted.length} hypotheses have drifted significantly. Review before proceeding.`,
        context: { drifted },
      };
    },
  },

  // ADVISORY: Low trust findings
  {
    category: 'low_trust',
    level: 'advisory',
    timeoutMinutes: 2,
    check: (cascadeId, _ctx) => {
      const db = getDb();
      const lowTrust = db.prepare(`SELECT id, claim, trust_composite FROM findings
        WHERE cascade_id = ? AND trust_composite < 0.4 AND quarantined = 0 AND human_reviewed = 0
        ORDER BY trust_composite ASC LIMIT 5`)
        .all(cascadeId) as any[];

      if (lowTrust.length === 0) return { triggered: false, description: '', context: {} };

      return {
        triggered: true,
        description: `${lowTrust.length} findings have low trust scores (<0.4).`,
        context: { lowTrustFindings: lowTrust },
      };
    },
  },

  // ADVISORY: Low overall confidence
  {
    category: 'low_confidence',
    level: 'advisory',
    timeoutMinutes: 3,
    check: (cascadeId, _ctx) => {
      const db = getDb();
      const avgConf = (db.prepare('SELECT AVG(confidence) as v FROM findings WHERE cascade_id = ? AND quarantined = 0')
        .get(cascadeId) as any)?.v;

      if (!avgConf || avgConf >= 0.5) return { triggered: false, description: '', context: {} };

      return {
        triggered: true,
        description: `Average confidence is ${(avgConf * 100).toFixed(1)}% — below 50% threshold.`,
        context: { avgConfidence: avgConf },
      };
    },
  },
];

/**
 * Check all intervention rules and return any that are triggered.
 */
export function checkInterventions(cascadeId: string, context: any = {}): Intervention[] {
  const triggered: Intervention[] = [];

  for (const rule of RULES) {
    const result = rule.check(cascadeId, context);
    if (result.triggered) {
      triggered.push({
        id: `${cascadeId}-${rule.category}-${Date.now()}`,
        cascadeId,
        level: rule.level,
        category: rule.category,
        description: result.description,
        context: result.context,
        timeoutMinutes: rule.timeoutMinutes,
        createdAt: new Date().toISOString(),
      });
    }
  }

  return triggered;
}

/**
 * Check if there are any blocking interventions that must be resolved.
 */
export function hasBlockingInterventions(cascadeId: string): boolean {
  const interventions = checkInterventions(cascadeId);
  return interventions.some(i => i.level === 'blocking');
}

/**
 * Format interventions for display.
 */
export function formatInterventions(interventions: Intervention[]): string {
  if (interventions.length === 0) return 'No interventions needed.';

  const lines: string[] = [];

  const blocking = interventions.filter(i => i.level === 'blocking');
  const advisory = interventions.filter(i => i.level === 'advisory');
  const silent = interventions.filter(i => i.level === 'silent');

  if (blocking.length > 0) {
    lines.push('== BLOCKING (requires approval) ==');
    for (const i of blocking) {
      lines.push(`  [${i.category}] ${i.description} (timeout: ${i.timeoutMinutes}min)`);
    }
  }

  if (advisory.length > 0) {
    lines.push('-- ADVISORY (auto-proceeds after timeout) --');
    for (const i of advisory) {
      lines.push(`  [${i.category}] ${i.description} (timeout: ${i.timeoutMinutes}min)`);
    }
  }

  if (silent.length > 0) {
    lines.push('.. SILENT (logged only) ..');
    for (const i of silent) {
      lines.push(`  [${i.category}] ${i.description}`);
    }
  }

  return lines.join('\n');
}
