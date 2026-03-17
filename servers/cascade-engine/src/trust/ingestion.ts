/**
 * Sandboxed Ingestion Pipeline — 4-stage trust gate
 *
 * Stage 1: Content Sanitization — strip dangerous content
 * Stage 2: Signal Computation — compute 6 trust signals
 * Stage 3: Anomaly Detection — novel-vs-malicious classification
 * Stage 4: Admission Decision — admit/quarantine/reject
 *
 * All findings go through this pipeline. Quarantine buffer has
 * reduced retrieval weight (0.1) and TTL auto-purge.
 */

import { getDb, contentHash } from '../db/index.js';
import { scoreTrust, TrustResult, TrustSignals } from './scoring.js';

export interface IngestionResult {
  findingId: string;
  action: 'admitted' | 'quarantined' | 'rejected';
  trustScore: number;
  reason: string;
  signals: TrustSignals;
}

/**
 * Ingest a finding through the full trust pipeline.
 * This is the ONLY path for findings to enter the knowledge base.
 */
export function ingestFinding(
  cascadeId: string,
  claim: string,
  evidence: string | undefined,
  sourceUrl: string | undefined,
  sourceType: 'primary' | 'secondary' | 'tertiary' | undefined,
  rawConfidence: number,
  cascadeRound: number,
  threadId?: string,
): IngestionResult {
  const db = getDb();
  const findingId = contentHash(claim);

  // Stage 1: Content Sanitization
  const sanitizedClaim = sanitize(claim);
  const sanitizedEvidence = evidence ? sanitize(evidence) : undefined;

  // Stage 2: Signal Computation
  // Get existing claims for cross-corroboration
  const existingClaims = db.prepare(
    'SELECT claim FROM findings WHERE cascade_id = ? AND quarantined = 0'
  ).all(cascadeId).map((r: any) => r.claim);

  const trustResult = scoreTrust(sanitizedClaim, sourceUrl, existingClaims, sourceType);

  // Stage 3: Anomaly Detection (handled inside scoreTrust)

  // Stage 4: Admission Decision
  let action: 'admitted' | 'quarantined' | 'rejected';
  let retrievalWeight = 1.0;
  let quarantined = 0;

  switch (trustResult.action) {
    case 'admit':
      action = 'admitted';
      break;
    case 'quarantine':
      action = 'quarantined';
      retrievalWeight = 0.1; // Reduced visibility until reviewed
      quarantined = 1;
      break;
    case 'reject':
      action = 'rejected';
      break;
  }

  // Store the finding (or update if duplicate)
  if (action !== 'rejected') {
    db.prepare(`INSERT INTO findings
      (id, thread_id, cascade_id, claim, evidence, source_url, source_type,
       confidence, trust_composite, trust_signals_json, grade_level, quarantined,
       retrieval_weight, cascade_round)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        confidence = MAX(confidence, excluded.confidence),
        trust_composite = excluded.trust_composite,
        trust_signals_json = excluded.trust_signals_json,
        grade_level = excluded.grade_level,
        quarantined = MIN(quarantined, excluded.quarantined)`)
      .run(
        findingId, threadId, cascadeId,
        sanitizedClaim, sanitizedEvidence, sourceUrl, sourceType,
        rawConfidence, trustResult.composite,
        JSON.stringify(trustResult.signals),
        trustResult.gradeLevel,
        quarantined, retrievalWeight, cascadeRound,
      );
  }

  // Update source reputation tracking
  if (sourceUrl) {
    try {
      const domain = new URL(sourceUrl).hostname;
      const repAction = action === 'rejected' ? 'rejected' : action === 'quarantined' ? 'flagged' : 'admitted';
      db.prepare(`INSERT INTO source_reputation (domain, total_entries, ${repAction === 'admitted' ? 'admitted_entries' : repAction === 'flagged' ? 'flagged_entries' : 'rejected_entries'})
        VALUES (?, 1, 1)
        ON CONFLICT(domain) DO UPDATE SET
          total_entries = total_entries + 1,
          ${repAction === 'admitted' ? 'admitted_entries = admitted_entries + 1' : repAction === 'flagged' ? 'flagged_entries = flagged_entries + 1' : 'rejected_entries = rejected_entries + 1'},
          last_updated = datetime('now')`)
        .run(domain);
    } catch { /* Invalid URL — skip */ }
  }

  // Audit log
  db.prepare(`INSERT INTO ingestion_audit_log (finding_id, action, trust_composite, signals_json, reason)
    VALUES (?, ?, ?, ?, ?)`)
    .run(findingId, action, trustResult.composite, JSON.stringify(trustResult.signals), trustResult.reason);

  return {
    findingId,
    action,
    trustScore: trustResult.composite,
    reason: trustResult.reason,
    signals: trustResult.signals,
  };
}

/**
 * Review quarantined findings — human approves or rejects.
 */
export function reviewQuarantined(findingId: string, approved: boolean): void {
  const db = getDb();

  if (approved) {
    db.prepare(`UPDATE findings SET
      quarantined = 0, human_reviewed = 1, retrieval_weight = 1.0
      WHERE id = ?`).run(findingId);
  } else {
    db.prepare('DELETE FROM findings WHERE id = ?').run(findingId);
  }

  // Log the decision
  db.prepare(`INSERT INTO ingestion_audit_log (finding_id, action, reason, human_override)
    VALUES (?, ?, ?, 1)`)
    .run(findingId, approved ? 'admitted' : 'rejected', `Human ${approved ? 'approved' : 'rejected'}`);
}

/**
 * Get quarantined findings pending review.
 */
export function getQuarantinedFindings(cascadeId?: string): any[] {
  const db = getDb();
  let sql = 'SELECT * FROM findings WHERE quarantined = 1 AND human_reviewed = 0';
  const params: any[] = [];

  if (cascadeId) {
    sql += ' AND cascade_id = ?';
    params.push(cascadeId);
  }

  sql += ' ORDER BY trust_composite DESC';
  return db.prepare(sql).all(...params);
}

/**
 * Auto-purge old quarantined findings (TTL).
 * Findings quarantined for >24h without review are removed.
 */
export function purgeExpiredQuarantine(ttlHours: number = 24): number {
  const db = getDb();
  const result = db.prepare(`DELETE FROM findings
    WHERE quarantined = 1 AND human_reviewed = 0
    AND created_at < datetime('now', '-' || ? || ' hours')`)
    .run(ttlHours);
  return result.changes;
}

// --- Content Sanitization ---

/**
 * Strip potentially dangerous content from text.
 * Preserves semantic meaning while removing injection vectors.
 */
function sanitize(text: string): string {
  let clean = text;

  // Remove zero-width characters (common in injection attacks)
  clean = clean.replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '');

  // Remove control characters except newlines and tabs
  clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Normalize whitespace
  clean = clean.replace(/\s{3,}/g, '  ');

  return clean.trim();
}
