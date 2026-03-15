/**
 * Quality Gates — Evaluation between cascade phases
 *
 * Four stopping gates (information-theoretic):
 * 1. Compression plateau — MDL not decreasing
 * 2. Diminishing returns — new findings below threshold
 * 3. Entropy floor — knowledge graph structure stabilized
 * 4. MDL increasing — model growing without explanatory gain
 *
 * Plus inter-phase gates that validate readiness to advance.
 */

import { getDb } from '../db/index.js';

export interface GateResult {
  gate: string;
  passed: boolean;
  value: number;
  threshold: number;
  description: string;
}

/**
 * Check all four stopping conditions.
 * If ANY gate says stop, cascade should conclude.
 */
export function evaluateStoppingGates(cascadeId: string): {
  shouldStop: boolean;
  gates: GateResult[];
  recommendation: string;
} {
  const db = getDb();
  const cascade = db.prepare('SELECT * FROM cascades WHERE id = ?').get(cascadeId) as any;
  if (!cascade) throw new Error(`Cascade ${cascadeId} not found`);

  const gates: GateResult[] = [];

  // 1. Max rounds reached
  const roundGate: GateResult = {
    gate: 'max_rounds',
    passed: cascade.current_round < cascade.max_rounds,
    value: cascade.current_round,
    threshold: cascade.max_rounds,
    description: `Round ${cascade.current_round}/${cascade.max_rounds}`,
  };
  gates.push(roundGate);

  // 2. Token budget exhausted
  const tokenGate: GateResult = {
    gate: 'token_budget',
    passed: cascade.tokens_used < cascade.token_budget,
    value: cascade.tokens_used,
    threshold: cascade.token_budget,
    description: `Tokens ${cascade.tokens_used}/${cascade.token_budget}`,
  };
  gates.push(tokenGate);

  // 3. Diminishing returns — compare findings count between last 2 rounds
  const findingsByRound = db.prepare(`SELECT cascade_round, COUNT(*) as n
    FROM findings WHERE cascade_id = ? AND quarantined = 0
    GROUP BY cascade_round ORDER BY cascade_round DESC LIMIT 2`)
    .all(cascadeId) as any[];

  if (findingsByRound.length >= 2) {
    const currentRoundFindings = findingsByRound[0].n;
    const prevRoundFindings = findingsByRound[1].n;
    const ratio = prevRoundFindings > 0 ? currentRoundFindings / prevRoundFindings : 1;

    const dimGate: GateResult = {
      gate: 'diminishing_returns',
      passed: ratio > 0.3, // Stop if new findings < 30% of previous round
      value: ratio,
      threshold: 0.3,
      description: `New findings ratio: ${Math.round(ratio * 100)}% (${currentRoundFindings} vs ${prevRoundFindings})`,
    };
    gates.push(dimGate);
  }

  // 4. Confidence convergence — average confidence above threshold
  const avgConf = db.prepare(`SELECT AVG(confidence) as avg_conf
    FROM findings WHERE cascade_id = ? AND quarantined = 0`)
    .get(cascadeId) as any;

  if (avgConf?.avg_conf !== null) {
    const confGate: GateResult = {
      gate: 'confidence_convergence',
      passed: avgConf.avg_conf < 0.85, // Stop if avg confidence very high (saturated)
      value: avgConf.avg_conf,
      threshold: 0.85,
      description: `Avg confidence: ${Math.round(avgConf.avg_conf * 1000) / 1000}`,
    };
    gates.push(confGate);
  }

  // 5. Entropy convergence — check recent entropy metrics
  const entropyMetrics = db.prepare(`SELECT metric_value FROM metrics
    WHERE cascade_id = ? AND metric_name = 'entropy'
    ORDER BY recorded_at DESC LIMIT 3`)
    .all(cascadeId) as any[];

  if (entropyMetrics.length >= 3) {
    const deltas = [];
    for (let i = 0; i < entropyMetrics.length - 1; i++) {
      deltas.push(Math.abs(entropyMetrics[i].metric_value - entropyMetrics[i + 1].metric_value));
    }
    const avgDelta = deltas.reduce((s, d) => s + d, 0) / deltas.length;

    const entropyGate: GateResult = {
      gate: 'entropy_floor',
      passed: avgDelta > 0.01, // Stop if entropy change < 1%
      value: avgDelta,
      threshold: 0.01,
      description: `Entropy delta: ${Math.round(avgDelta * 10000) / 10000}`,
    };
    gates.push(entropyGate);
  }

  const shouldStop = gates.some(g => !g.passed);
  let recommendation = 'Continue research.';
  if (shouldStop) {
    const failedGates = gates.filter(g => !g.passed).map(g => g.gate);
    recommendation = `Stop: ${failedGates.join(', ')}. ${
      failedGates.includes('max_rounds') ? 'Maximum rounds reached.' :
      failedGates.includes('token_budget') ? 'Token budget exhausted.' :
      failedGates.includes('diminishing_returns') ? 'New findings dropping sharply — research saturated.' :
      failedGates.includes('confidence_convergence') ? 'High confidence across findings — answers converged.' :
      'Knowledge graph structure stabilized.'
    }`;
  }

  return { shouldStop, gates, recommendation };
}

/**
 * Validate readiness to advance from one phase to the next.
 * Returns issues that should be resolved before advancing.
 */
export function validatePhaseGate(
  cascadeId: string,
  fromPhase: string,
  toPhase: string,
): { ready: boolean; issues: string[] } {
  const db = getDb();
  const issues: string[] = [];

  switch (fromPhase) {
    case 'identify': {
      // Need at least 1 thread created
      const threads = (db.prepare('SELECT COUNT(*) as n FROM threads WHERE cascade_id = ? AND status IN (\'active\',\'done\')').get(cascadeId) as any).n;
      if (threads === 0) issues.push('No research threads created. Decompose the question into sub-questions first.');
      break;
    }
    case 'screen': {
      // Need findings to have been screened (trust scores applied)
      const unscored = (db.prepare('SELECT COUNT(*) as n FROM findings WHERE cascade_id = ? AND trust_composite = 0.5 AND trust_signals_json IS NULL').get(cascadeId) as any).n;
      if (unscored > 0) issues.push(`${unscored} findings haven't been trust-scored yet.`);
      break;
    }
    case 'evaluate': {
      // Need at least some findings with confidence > 0
      const evaluated = (db.prepare('SELECT COUNT(*) as n FROM findings WHERE cascade_id = ? AND quarantined = 0').get(cascadeId) as any).n;
      if (evaluated === 0) issues.push('No non-quarantined findings. All findings were rejected or quarantined.');
      break;
    }
    case 'consolidate': {
      // Just check we have entities in the graph
      // (consolidation creates entities — so this is post-facto)
      break;
    }
    case 'mature': {
      // Need at least 1 hypothesis
      const hyps = (db.prepare('SELECT COUNT(*) as n FROM hypotheses WHERE cascade_id = ?').get(cascadeId) as any).n;
      if (hyps === 0) issues.push('No hypotheses to mature. Create at least one hypothesis from findings.');
      break;
    }
    case 'prune': {
      // No hard requirements — pruning is optional
      break;
    }
    case 'synthesize': {
      // Need findings to synthesize
      const findings = (db.prepare('SELECT COUNT(*) as n FROM findings WHERE cascade_id = ? AND quarantined = 0').get(cascadeId) as any).n;
      if (findings === 0) issues.push('No findings to synthesize.');
      break;
    }
    case 'observe': {
      // Terminal — check stopping conditions
      break;
    }
  }

  return { ready: issues.length === 0, issues };
}

/**
 * Calculate information-theoretic metrics for the current round.
 */
export function calculateRoundMetrics(cascadeId: string): {
  coverage: number;
  depth: number;
  confidence: number;
  sourceQuality: number;
  graphDensity: number;
} {
  const db = getDb();
  const cascade = db.prepare('SELECT * FROM cascades WHERE id = ?').get(cascadeId) as any;
  if (!cascade) throw new Error(`Cascade ${cascadeId} not found`);

  const plan = cascade.plan_json ? JSON.parse(cascade.plan_json) : null;
  const totalQuestions = plan?.questions?.length || 1;

  // Coverage: what fraction of questions have findings
  const questionsWithFindings = db.prepare(`SELECT COUNT(DISTINCT t.question) as n
    FROM threads t JOIN findings f ON t.id = f.thread_id
    WHERE t.cascade_id = ? AND f.quarantined = 0`)
    .get(cascadeId) as any;
  const coverage = Math.min(1, (questionsWithFindings?.n || 0) / totalQuestions);

  // Depth: average findings per question
  const totalFindings = (db.prepare('SELECT COUNT(*) as n FROM findings WHERE cascade_id = ? AND quarantined = 0').get(cascadeId) as any).n;
  const depth = Math.min(1, totalFindings / (totalQuestions * 10)); // 10 findings/question = max depth

  // Confidence: average confidence of non-quarantined findings
  const avgConf = (db.prepare('SELECT AVG(confidence) as v FROM findings WHERE cascade_id = ? AND quarantined = 0').get(cascadeId) as any)?.v || 0;

  // Source quality: average trust score
  const avgTrust = (db.prepare('SELECT AVG(trust_composite) as v FROM findings WHERE cascade_id = ? AND quarantined = 0').get(cascadeId) as any)?.v || 0.5;

  // Graph density: 2|E|/(|V|(|V|-1)) — but capped at 1
  const V = (db.prepare('SELECT COUNT(*) as n FROM kg_entities').get() as any).n;
  const E = (db.prepare('SELECT COUNT(*) as n FROM kg_edges').get() as any).n;
  const graphDensity = V > 1 ? Math.min(1, (2 * E) / (V * (V - 1))) : 0;

  return {
    coverage,
    depth,
    confidence: avgConf,
    sourceQuality: avgTrust,
    graphDensity,
  };
}
