/**
 * Research Integration — Search/fetch pipeline
 *
 * Provides structured interfaces for research operations.
 * The LLM performs actual web_search/web_fetch — this module
 * structures the inputs/outputs and tracks the process.
 */

import { getDb, contentHash, generateId } from '../db/index.js';

// --- Types ---

export interface SearchPlan {
  cascadeId: string;
  roundIndex: number;
  queries: SearchQuery[];
  explorationBudget: number;
}

export interface SearchQuery {
  query: string;
  type: 'exploration' | 'exploitation' | 'validation';
  priority: number;
  threadId?: string;
}

export interface RawFinding {
  claim: string;
  evidence?: string;
  sourceUrl?: string;
  sourceType?: 'primary' | 'secondary' | 'tertiary';
  rawConfidence?: number;
}

// --- Functions ---

/**
 * Build a search plan from cascade state.
 * Generates queries based on questions, existing findings, and gaps.
 */
export function buildSearchPlan(cascadeId: string): SearchPlan {
  const db = getDb();
  const cascade = db.prepare('SELECT * FROM cascades WHERE id = ?').get(cascadeId) as any;
  if (!cascade) throw new Error(`Cascade ${cascadeId} not found`);

  const plan = cascade.plan_json ? JSON.parse(cascade.plan_json) : null;
  const questions = plan?.questions || [cascade.question];
  const roundIndex = cascade.current_round;
  const budget = Math.max(0, 1 - roundIndex / cascade.max_rounds);

  const queries: SearchQuery[] = [];

  // Round 0 (SEED): all questions are exploration
  if (roundIndex === 0) {
    for (const q of questions) {
      queries.push({ query: q, type: 'exploration', priority: 1.0 });
    }
  } else {
    // Later rounds: mix of exploration, exploitation, validation
    const explorationCount = Math.ceil(questions.length * budget);

    // Exploration: questions without enough findings
    const threadCoverage = db.prepare(`SELECT t.question, COUNT(f.id) as finding_count
      FROM threads t LEFT JOIN findings f ON t.id = f.thread_id AND f.quarantined = 0
      WHERE t.cascade_id = ?
      GROUP BY t.question
      ORDER BY finding_count ASC`)
      .all(cascadeId) as any[];

    for (let i = 0; i < Math.min(explorationCount, threadCoverage.length); i++) {
      queries.push({
        query: threadCoverage[i].question,
        type: 'exploration',
        priority: 1.0 - i * 0.1,
      });
    }

    // Exploitation: deepen high-confidence threads
    const highConfThreads = db.prepare(`SELECT t.id, t.question, AVG(f.confidence) as avg_conf
      FROM threads t JOIN findings f ON t.id = f.thread_id
      WHERE t.cascade_id = ? AND f.quarantined = 0
      GROUP BY t.id
      HAVING avg_conf > 0.5
      ORDER BY avg_conf DESC LIMIT 3`)
      .all(cascadeId) as any[];

    for (const thread of highConfThreads) {
      queries.push({
        query: thread.question,
        type: 'exploitation',
        priority: thread.avg_conf,
        threadId: thread.id,
      });
    }

    // Validation: cross-check low-confidence findings
    const lowConfFindings = db.prepare(`SELECT claim FROM findings
      WHERE cascade_id = ? AND quarantined = 0 AND confidence < 0.5
      ORDER BY confidence ASC LIMIT 3`)
      .all(cascadeId) as any[];

    for (const f of lowConfFindings) {
      queries.push({
        query: `verify: ${f.claim}`,
        type: 'validation',
        priority: 0.8,
      });
    }
  }

  // Sort by priority
  queries.sort((a, b) => b.priority - a.priority);

  return { cascadeId, roundIndex, queries, explorationBudget: budget };
}

/**
 * Classify a query to determine which model should handle it.
 * Returns routing info for multi-model dispatch.
 */
export function classifyQuery(query: string): {
  type: 'technical' | 'discovery' | 'classification' | 'validation';
  suggestedModel: string;
  suggestedAgent: string;
  reasoning: string;
} {
  const lower = query.toLowerCase();

  // Classification heuristics (simple — LLM should refine these)
  if (lower.includes('verify') || lower.includes('validate') || lower.includes('confirm') || lower.includes('cross-check')) {
    return { type: 'validation', suggestedModel: 'sonnet', suggestedAgent: 'cross-validator', reasoning: 'Validation query — cross-reference with independent sources' };
  }

  if (lower.includes('how') || lower.includes('implementation') || lower.includes('architecture') || lower.includes('benchmark') || lower.includes('performance')) {
    return { type: 'technical', suggestedModel: 'opus', suggestedAgent: 'deep-investigator', reasoning: 'Technical deep-dive — needs strong reasoning' };
  }

  if (lower.includes('what if') || lower.includes('could') || lower.includes('explore') || lower.includes('design') || lower.includes('philosophy')) {
    return { type: 'discovery', suggestedModel: 'sonnet', suggestedAgent: 'research-planner', reasoning: 'Discovery/open-ended — benefits from diverse exploration' };
  }

  if (lower.includes('categorize') || lower.includes('sort') || lower.includes('tag') || lower.includes('extract')) {
    return { type: 'classification', suggestedModel: 'haiku', suggestedAgent: 'research-planner', reasoning: 'Classification task — lightweight model sufficient' };
  }

  // Default: technical
  return { type: 'technical', suggestedModel: 'sonnet', suggestedAgent: 'deep-investigator', reasoning: 'Default routing — general research query' };
}

/**
 * Batch store findings from a research round.
 * Returns count of new vs duplicate findings.
 */
export function batchStoreFindings(
  cascadeId: string,
  roundIndex: number,
  threadId: string | undefined,
  findings: RawFinding[],
): { stored: number; duplicates: number } {
  const db = getDb();
  let stored = 0;
  let duplicates = 0;

  const insertStmt = db.prepare(`INSERT INTO findings (id, thread_id, cascade_id, claim, evidence, source_url, source_type, confidence, cascade_round)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET confidence = MAX(confidence, excluded.confidence)`);

  const transaction = db.transaction(() => {
    for (const f of findings) {
      const id = contentHash(f.claim);
      const existing = db.prepare('SELECT id FROM findings WHERE id = ?').get(id);

      insertStmt.run(id, threadId, cascadeId, f.claim, f.evidence, f.sourceUrl, f.sourceType, f.rawConfidence ?? 0.5, roundIndex);

      if (existing) duplicates++;
      else stored++;
    }
  });

  transaction();
  return { stored, duplicates };
}
