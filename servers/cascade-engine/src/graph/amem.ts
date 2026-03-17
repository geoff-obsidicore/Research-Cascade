/**
 * A-MEM — Zettelkasten Atomic Notes Layer
 *
 * Each insight becomes an atomic note. Notes are bidirectionally linked
 * based on content relationships. Notes mature over time:
 *   isolated_fact → connected_fact → principle → mental_model
 *
 * Built on top of the entity/edge KG — notes reference entities and findings
 * but form their own link structure optimized for emergent understanding.
 */

import { getDb, contentHash } from '../db/index.js';

export interface AtomicNote {
  id: string;
  content: string;
  noteType: 'insight' | 'connection' | 'question' | 'contradiction' | 'synthesis';
  sourceFindingId: string | null;
  sourceEntityId: number | null;
  cascadeId: string | null;
  cascadeRound: number | null;
  keywords: string[];
  maturity: 'isolated_fact' | 'connected_fact' | 'principle' | 'mental_model';
  accessCount: number;
  lastAccessed: string;
  createdAt: string;
}

export interface NoteLink {
  id: number;
  sourceNoteId: string;
  targetNoteId: string;
  linkType: 'relates_to' | 'supports' | 'contradicts' | 'refines' | 'generalizes' | 'exemplifies';
  strength: number;
  bidirectional: boolean;
  createdAt: string;
}

// --- Note CRUD ---

/**
 * Create an atomic note from an insight.
 * Content-addressable: same content = same note (idempotent).
 */
export function createNote(
  content: string,
  noteType: AtomicNote['noteType'] = 'insight',
  keywords: string[] = [],
  sourceFindingId?: string,
  sourceEntityId?: number,
  cascadeId?: string,
  cascadeRound?: number,
): string {
  const db = getDb();
  const id = contentHash(content);

  db.prepare(`INSERT INTO atomic_notes
    (id, content, note_type, source_finding_id, source_entity_id, cascade_id, cascade_round, keywords)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      access_count = access_count + 1,
      last_accessed = datetime('now'),
      keywords = json_patch(keywords, excluded.keywords)`)
    .run(id, content, noteType, sourceFindingId ?? null, sourceEntityId ?? null,
      cascadeId ?? null, cascadeRound ?? null, JSON.stringify(keywords));

  return id;
}

/**
 * Link two notes bidirectionally.
 */
export function linkNotes(
  sourceId: string,
  targetId: string,
  linkType: NoteLink['linkType'] = 'relates_to',
  strength: number = 1.0,
  bidirectional: boolean = true,
): void {
  const db = getDb();

  db.prepare(`INSERT INTO note_links (source_note_id, target_note_id, link_type, strength, bidirectional)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_note_id, target_note_id, link_type) DO UPDATE SET
      strength = MAX(strength, excluded.strength)`)
    .run(sourceId, targetId, linkType, strength, bidirectional ? 1 : 0);

  // If bidirectional, create the reverse link too
  if (bidirectional) {
    db.prepare(`INSERT INTO note_links (source_note_id, target_note_id, link_type, strength, bidirectional)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_note_id, target_note_id, link_type) DO UPDATE SET
        strength = MAX(strength, excluded.strength)`)
      .run(targetId, sourceId, linkType, strength, 1);
  }
}

/**
 * Get a note and its connections.
 */
export function getNote(noteId: string): { note: AtomicNote; links: any[] } | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM atomic_notes WHERE id = ?').get(noteId) as any;
  if (!row) return null;

  // Touch access count
  db.prepare('UPDATE atomic_notes SET access_count = access_count + 1, last_accessed = datetime(\'now\') WHERE id = ?')
    .run(noteId);

  const links = db.prepare(`SELECT nl.*, an.content as linked_content, an.note_type as linked_type
    FROM note_links nl
    JOIN atomic_notes an ON an.id = nl.target_note_id
    WHERE nl.source_note_id = ?
    ORDER BY nl.strength DESC`)
    .all(noteId);

  return { note: rowToNote(row), links };
}

/**
 * Find notes by keyword.
 */
export function searchNotes(keyword: string, limit: number = 20): AtomicNote[] {
  const db = getDb();
  // Search in keywords JSON array and content
  const rows = db.prepare(`SELECT * FROM atomic_notes
    WHERE keywords LIKE ? OR content LIKE ?
    ORDER BY access_count DESC, created_at DESC LIMIT ?`)
    .all(`%${keyword}%`, `%${keyword}%`, limit) as any[];

  return rows.map(rowToNote);
}

/**
 * Auto-extract notes from a finding.
 * Creates an atomic note from the claim and links it to related entities.
 */
export function extractNotesFromFinding(
  findingId: string,
  cascadeId: string,
  cascadeRound: number,
): string[] {
  const db = getDb();
  const finding = db.prepare('SELECT * FROM findings WHERE id = ?').get(findingId) as any;
  if (!finding) return [];

  const noteIds: string[] = [];

  // Create a note from the claim
  const noteId = createNote(
    finding.claim,
    'insight',
    [], // Keywords could be extracted by LLM
    findingId,
    undefined,
    cascadeId,
    cascadeRound,
  );
  noteIds.push(noteId);

  // Link to any existing notes with overlapping content
  const existing = db.prepare(`SELECT id, content FROM atomic_notes
    WHERE id != ? AND cascade_id = ?
    ORDER BY created_at DESC LIMIT 50`)
    .all(noteId, cascadeId) as any[];

  for (const other of existing) {
    // Simple keyword overlap check for auto-linking
    const words1 = new Set(finding.claim.toLowerCase().split(/\s+/).filter((w: string) => w.length > 5));
    const words2 = new Set(other.content.toLowerCase().split(/\s+/).filter((w: string) => w.length > 5));
    let overlap = 0;
    for (const w of words1) {
      if (words2.has(w)) overlap++;
    }
    if (overlap >= 2) {
      linkNotes(noteId, other.id, 'relates_to', Math.min(1.0, overlap * 0.2));
    }
  }

  return noteIds;
}

/**
 * Update note maturity based on connection count.
 * Dreyfus progression: isolated_fact → connected_fact → principle → mental_model
 */
export function updateMaturity(): { promoted: number } {
  const db = getDb();
  let promoted = 0;

  // Connected fact: ≥2 links
  const r1 = db.prepare(`UPDATE atomic_notes SET maturity = 'connected_fact'
    WHERE maturity = 'isolated_fact'
    AND (SELECT COUNT(*) FROM note_links WHERE source_note_id = id OR target_note_id = id) >= 2`).run();
  promoted += r1.changes;

  // Principle: ≥5 links AND accessed ≥3 times
  const r2 = db.prepare(`UPDATE atomic_notes SET maturity = 'principle'
    WHERE maturity = 'connected_fact'
    AND (SELECT COUNT(*) FROM note_links WHERE source_note_id = id OR target_note_id = id) >= 5
    AND access_count >= 3`).run();
  promoted += r2.changes;

  // Mental model: ≥10 links AND accessed ≥10 times AND note_type = 'synthesis'
  const r3 = db.prepare(`UPDATE atomic_notes SET maturity = 'mental_model'
    WHERE maturity = 'principle'
    AND (SELECT COUNT(*) FROM note_links WHERE source_note_id = id OR target_note_id = id) >= 10
    AND access_count >= 10
    AND note_type = 'synthesis'`).run();
  promoted += r3.changes;

  return { promoted };
}

/**
 * Find orphan notes (no links) — candidates for linking or pruning.
 */
export function findOrphanNotes(): AtomicNote[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM atomic_notes
    WHERE id NOT IN (SELECT source_note_id FROM note_links)
    AND id NOT IN (SELECT target_note_id FROM note_links)
    ORDER BY created_at DESC`)
    .all() as any[];
  return rows.map(rowToNote);
}

/**
 * Get note graph statistics.
 */
export function getNoteStats(): {
  totalNotes: number;
  maturityCounts: Record<string, number>;
  typeCounts: Record<string, number>;
  totalLinks: number;
  orphanCount: number;
} {
  const db = getDb();

  const totalNotes = (db.prepare('SELECT COUNT(*) as n FROM atomic_notes').get() as any).n;
  const totalLinks = (db.prepare('SELECT COUNT(*) as n FROM note_links').get() as any).n;
  const orphanCount = (db.prepare(`SELECT COUNT(*) as n FROM atomic_notes
    WHERE id NOT IN (SELECT source_note_id FROM note_links)
    AND id NOT IN (SELECT target_note_id FROM note_links)`).get() as any).n;

  const maturityRows = db.prepare('SELECT maturity, COUNT(*) as n FROM atomic_notes GROUP BY maturity').all() as any[];
  const maturityCounts: Record<string, number> = {};
  for (const r of maturityRows) maturityCounts[r.maturity] = r.n;

  const typeRows = db.prepare('SELECT note_type, COUNT(*) as n FROM atomic_notes GROUP BY note_type').all() as any[];
  const typeCounts: Record<string, number> = {};
  for (const r of typeRows) typeCounts[r.note_type] = r.n;

  return { totalNotes, maturityCounts, typeCounts, totalLinks, orphanCount };
}

// --- Helpers ---

function rowToNote(row: any): AtomicNote {
  return {
    id: row.id,
    content: row.content,
    noteType: row.note_type,
    sourceFindingId: row.source_finding_id,
    sourceEntityId: row.source_entity_id,
    cascadeId: row.cascade_id,
    cascadeRound: row.cascade_round,
    keywords: JSON.parse(row.keywords || '[]'),
    maturity: row.maturity,
    accessCount: row.access_count,
    lastAccessed: row.last_accessed,
    createdAt: row.created_at,
  };
}
