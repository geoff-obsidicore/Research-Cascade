/**
 * Dashboard — ANSI output for cascade monitoring
 *
 * Plain ANSI header (metrics/phase) + scrolling stdout (NDJSON with --stream-json).
 * NO TUIs (crash in tmux/SSH). Optional --tui flag for future.
 *
 * Quality review without reading everything:
 * 4 metrics at round boundaries + 3-sentence LLM summary + identified gaps
 */

import { getDb } from '../db/index.js';

// ANSI escape codes
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

export interface DashboardData {
  cascade: {
    id: string;
    question: string;
    status: string;
    round: number;
    maxRounds: number;
  };
  quality: {
    coverage: number;
    depth: number;
    confidence: number;
    sourceQuality: number;
  };
  counts: {
    findings: number;
    quarantined: number;
    hypotheses: number;
    entities: number;
    edges: number;
  };
  tokens: {
    used: number;
    budget: number;
  };
  explorationBudget: number;
  pendingSteers: number;
  interventions: string[];
}

/**
 * Generate a compact ANSI dashboard string.
 */
export function renderDashboard(data: DashboardData): string {
  const lines: string[] = [];

  // Header
  lines.push(`${BOLD}${CYAN}═══ Research Cascade Dashboard ═══${RESET}`);
  lines.push(`${BOLD}Q:${RESET} ${data.cascade.question.slice(0, 80)}`);
  lines.push(`${BOLD}ID:${RESET} ${data.cascade.id}  ${BOLD}Status:${RESET} ${colorStatus(data.cascade.status)}  ${BOLD}Round:${RESET} ${data.cascade.round}/${data.cascade.maxRounds}`);
  lines.push('');

  // Quality metrics bar
  lines.push(`${BOLD}Quality:${RESET}`);
  lines.push(`  Coverage:   ${progressBar(data.quality.coverage, 20)} ${(data.quality.coverage * 100).toFixed(0)}%`);
  lines.push(`  Depth:      ${progressBar(data.quality.depth, 20)} ${(data.quality.depth * 100).toFixed(0)}%`);
  lines.push(`  Confidence: ${progressBar(data.quality.confidence, 20)} ${(data.quality.confidence * 100).toFixed(0)}%`);
  lines.push(`  Source:     ${progressBar(data.quality.sourceQuality, 20)} ${(data.quality.sourceQuality * 100).toFixed(0)}%`);
  lines.push('');

  // Counts
  lines.push(`${BOLD}Counts:${RESET} ${data.counts.findings} findings | ${data.counts.quarantined} quarantined | ${data.counts.hypotheses} hypotheses | ${data.counts.entities} entities | ${data.counts.edges} edges`);

  // Budget
  const tokenPct = data.tokens.budget > 0 ? data.tokens.used / data.tokens.budget : 0;
  lines.push(`${BOLD}Tokens:${RESET} ${progressBar(tokenPct, 20)} ${data.tokens.used.toLocaleString()}/${data.tokens.budget.toLocaleString()}`);
  lines.push(`${BOLD}Explore/Exploit:${RESET} ${(data.explorationBudget * 100).toFixed(0)}% exploration`);

  // Alerts
  if (data.pendingSteers > 0) {
    lines.push(`${YELLOW}${BOLD}⚠ ${data.pendingSteers} pending steer events${RESET}`);
  }
  if (data.interventions.length > 0) {
    lines.push(`${RED}${BOLD}! ${data.interventions.length} interventions:${RESET}`);
    for (const i of data.interventions.slice(0, 3)) {
      lines.push(`  ${RED}${i}${RESET}`);
    }
  }

  lines.push(`${DIM}${CYAN}═══════════════════════════════════${RESET}`);
  return lines.join('\n');
}

/**
 * Build dashboard data from database state.
 */
export function buildDashboardData(cascadeId: string): DashboardData | null {
  const db = getDb();
  const cascade = db.prepare('SELECT * FROM cascades WHERE id = ?').get(cascadeId) as any;
  if (!cascade) return null;

  const findingsCount = (db.prepare('SELECT COUNT(*) as n FROM findings WHERE cascade_id = ? AND quarantined = 0').get(cascadeId) as any).n;
  const quarantinedCount = (db.prepare('SELECT COUNT(*) as n FROM findings WHERE cascade_id = ? AND quarantined = 1').get(cascadeId) as any).n;
  const hypothesesCount = (db.prepare('SELECT COUNT(*) as n FROM hypotheses WHERE cascade_id = ?').get(cascadeId) as any).n;
  const entityCount = (db.prepare('SELECT COUNT(*) as n FROM kg_entities').get() as any).n;
  const edgeCount = (db.prepare('SELECT COUNT(*) as n FROM kg_edges').get() as any).n;
  const pendingSteers = (db.prepare('SELECT COUNT(*) as n FROM steer_events WHERE cascade_id = ? AND applied = 0').get(cascadeId) as any).n;

  // Calculate quality metrics
  const plan = cascade.plan_json ? JSON.parse(cascade.plan_json) : null;
  const totalQuestions = plan?.questions?.length || 1;
  const avgConf = (db.prepare('SELECT AVG(confidence) as v FROM findings WHERE cascade_id = ? AND quarantined = 0').get(cascadeId) as any)?.v || 0;
  const avgTrust = (db.prepare('SELECT AVG(trust_composite) as v FROM findings WHERE cascade_id = ? AND quarantined = 0').get(cascadeId) as any)?.v || 0.5;

  return {
    cascade: {
      id: cascadeId,
      question: cascade.question,
      status: cascade.status,
      round: cascade.current_round,
      maxRounds: cascade.max_rounds,
    },
    quality: {
      coverage: Math.min(1, findingsCount / (totalQuestions * 3)),
      depth: Math.min(1, findingsCount / (totalQuestions * 10)),
      confidence: avgConf,
      sourceQuality: avgTrust,
    },
    counts: {
      findings: findingsCount,
      quarantined: quarantinedCount,
      hypotheses: hypothesesCount,
      entities: entityCount,
      edges: edgeCount,
    },
    tokens: { used: cascade.tokens_used, budget: cascade.token_budget },
    explorationBudget: Math.max(0, 1 - cascade.current_round / cascade.max_rounds),
    pendingSteers,
    interventions: [],
  };
}

/**
 * Render a simple ASCII progress bar.
 */
function progressBar(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  const empty = width - filled;

  const color = clamped >= 0.7 ? GREEN : clamped >= 0.4 ? YELLOW : RED;
  return `${color}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${RESET}`;
}

/**
 * Color status text based on state.
 */
function colorStatus(status: string): string {
  switch (status) {
    case 'planning': return `${CYAN}${status}${RESET}`;
    case 'investigating': return `${GREEN}${status}${RESET}`;
    case 'validating': return `${YELLOW}${status}${RESET}`;
    case 'synthesizing': return `${GREEN}${status}${RESET}`;
    case 'complete': return `${GREEN}${BOLD}${status}${RESET}`;
    case 'stalled': return `${RED}${BOLD}${status}${RESET}`;
    default: return status;
  }
}

/**
 * Format a cascade status as NDJSON for streaming output.
 */
export function toNDJSON(data: DashboardData): string {
  return JSON.stringify({
    type: 'cascade_status',
    timestamp: new Date().toISOString(),
    ...data,
  });
}
