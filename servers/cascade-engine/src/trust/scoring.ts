/**
 * Trust Scoring — SpamAssassin-inspired multi-signal composite
 *
 * 6 orthogonal signals → composite 0-1:
 * 1. Source reputation
 * 2. Cross-corroboration
 * 3. Semantic anomaly (distance from topic centroid)
 * 4. Instruction pattern detection
 * 5. Temporal consistency
 * 6. GRADE assessment
 *
 * Thresholds: ≥0.7 auto-admit | 0.3-0.7 quarantine | <0.3 reject
 */

import { getDb } from '../db/index.js';
import { detectInstructionPatterns } from './patterns.js';

export interface TrustSignals {
  sourceReputation: number;   // 0-1
  crossCorroboration: number; // 0-1
  semanticAnomaly: number;    // 0-1 (1 = normal, 0 = anomalous)
  instructionScore: number;   // 0-1 (1 = clean, 0 = full of injection attempts)
  temporalConsistency: number; // 0-1
  gradeAssessment: number;    // 0-1
}

export interface TrustResult {
  composite: number;
  signals: TrustSignals;
  action: 'admit' | 'quarantine' | 'reject';
  reason: string;
  isNovel: boolean;
}

// Signal weights — sum to 1.0
const WEIGHTS = {
  sourceReputation: 0.20,
  crossCorroboration: 0.20,
  semanticAnomaly: 0.15,
  instructionScore: 0.20,
  temporalConsistency: 0.10,
  gradeAssessment: 0.15,
};

/**
 * Compute composite trust score for a finding.
 */
export function scoreTrust(
  claim: string,
  sourceUrl: string | undefined,
  existingClaims: string[],
  sourceType?: string,
): TrustResult {
  const signals: TrustSignals = {
    sourceReputation: scoreSourceReputation(sourceUrl),
    crossCorroboration: scoreCrossCorroboration(claim, existingClaims),
    semanticAnomaly: 1.0, // Default — would need embeddings for real scoring
    instructionScore: scoreInstructionSafety(claim),
    temporalConsistency: 1.0, // Default — would compare timestamps
    gradeAssessment: scoreGradeProxy(sourceType),
  };

  const composite =
    signals.sourceReputation * WEIGHTS.sourceReputation +
    signals.crossCorroboration * WEIGHTS.crossCorroboration +
    signals.semanticAnomaly * WEIGHTS.semanticAnomaly +
    signals.instructionScore * WEIGHTS.instructionScore +
    signals.temporalConsistency * WEIGHTS.temporalConsistency +
    signals.gradeAssessment * WEIGHTS.gradeAssessment;

  // Novel-vs-malicious detection
  const isNovel = signals.crossCorroboration < 0.3; // Not corroborated
  const isPrecise = signals.instructionScore > 0.7;
  const isTrusted = signals.sourceReputation > 0.5;

  let action: TrustResult['action'];
  let reason: string;

  if (composite >= 0.7) {
    action = 'admit';
    reason = 'Trust score above admission threshold';
  } else if (composite < 0.3) {
    action = 'reject';
    reason = composite < 0.2
      ? 'Trust score critically low — likely injection or unreliable'
      : 'Trust score below rejection threshold';
  } else {
    // Quarantine zone — apply novel-vs-malicious heuristic
    if (isNovel && isPrecise && isTrusted) {
      action = 'quarantine';
      reason = 'Contested novelty — novel claim from trusted source. Needs human review.';
    } else if (isNovel && !isPrecise && !isTrusted) {
      action = 'reject';
      reason = 'Structural anomaly — novel, imprecise, untrusted. Likely attack vector.';
    } else {
      action = 'quarantine';
      reason = 'Moderate trust — quarantined for review';
    }
  }

  return { composite, signals, action, reason, isNovel };
}

/**
 * Score source reputation based on domain history.
 */
function scoreSourceReputation(sourceUrl: string | undefined): number {
  if (!sourceUrl) return 0.3; // Unknown source gets low baseline

  const db = getDb();
  let domain: string;
  try {
    domain = new URL(sourceUrl).hostname;
  } catch {
    return 0.2; // Invalid URL
  }

  // Check known reputation
  const rep = db.prepare('SELECT reputation_score FROM source_reputation WHERE domain = ?').get(domain) as any;
  if (rep) return rep.reputation_score;

  // Known-good domains baseline
  const knownGood = [
    'arxiv.org', 'github.com', 'stackoverflow.com', 'docs.python.org',
    'developer.mozilla.org', 'en.wikipedia.org', 'scholar.google.com',
    'proceedings.neurips.cc', 'openreview.net', 'dl.acm.org',
    'ieee.org', 'nature.com', 'science.org',
  ];

  if (knownGood.some(d => domain.endsWith(d))) {
    // Initialize reputation
    db.prepare('INSERT OR IGNORE INTO source_reputation (domain, reputation_score) VALUES (?, 0.8)')
      .run(domain);
    return 0.8;
  }

  // Unknown domain — neutral
  db.prepare('INSERT OR IGNORE INTO source_reputation (domain, reputation_score) VALUES (?, 0.5)')
    .run(domain);
  return 0.5;
}

/**
 * Score cross-corroboration — how many existing findings support this claim.
 * Simple text overlap heuristic (would use embeddings in production).
 */
function scoreCrossCorroboration(claim: string, existingClaims: string[]): number {
  if (existingClaims.length === 0) return 0.3; // First finding — neutral

  // Simple word overlap scoring
  const claimWords = new Set(claim.toLowerCase().split(/\s+/).filter(w => w.length > 4));
  let maxOverlap = 0;
  let corroborations = 0;

  for (const existing of existingClaims) {
    const existingWords = new Set(existing.toLowerCase().split(/\s+/).filter(w => w.length > 4));
    let overlap = 0;
    for (const word of claimWords) {
      if (existingWords.has(word)) overlap++;
    }
    const overlapRatio = claimWords.size > 0 ? overlap / claimWords.size : 0;
    maxOverlap = Math.max(maxOverlap, overlapRatio);
    if (overlapRatio > 0.3) corroborations++;
  }

  // More corroborations = higher score, diminishing returns
  return Math.min(1.0, 0.3 + corroborations * 0.15 + maxOverlap * 0.3);
}

/**
 * Score instruction safety — detect prompt injection patterns.
 */
function scoreInstructionSafety(text: string): number {
  const patterns = detectInstructionPatterns(text);
  return Math.max(0, 1.0 + patterns.totalScore); // patterns.totalScore is negative
}

/**
 * Proxy GRADE assessment based on source type.
 */
function scoreGradeProxy(sourceType: string | undefined): number {
  switch (sourceType) {
    case 'primary': return 0.9;   // Peer-reviewed, official docs
    case 'secondary': return 0.6; // Blog posts, tutorials
    case 'tertiary': return 0.4;  // Forum posts, social media
    default: return 0.5;
  }
}

/**
 * Update source reputation based on finding outcomes.
 * Called when human reviews findings (SpamAssassin ham/spam training).
 */
export function updateSourceReputation(
  domain: string,
  wasAccurate: boolean,
): void {
  const db = getDb();
  const direction = wasAccurate ? 0.05 : -0.1; // Penalize inaccuracy more

  db.prepare(`INSERT INTO source_reputation (domain, reputation_score, total_entries)
    VALUES (?, ?, 1)
    ON CONFLICT(domain) DO UPDATE SET
      reputation_score = MAX(0, MIN(1, reputation_score + ?)),
      total_entries = total_entries + 1,
      flagged_entries = flagged_entries + CASE WHEN ? THEN 0 ELSE 1 END,
      last_updated = datetime('now')`)
    .run(domain, 0.5 + direction, direction, wasAccurate ? 1 : 0);
}
