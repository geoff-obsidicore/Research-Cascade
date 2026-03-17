-- Research Cascade Knowledge Database Schema
-- Version: 1.0
-- Requires: SQLite >= 3.51.3 (WAL-reset corruption fix)

-- ============================================================
-- TIER 1: CASCADE STATE
-- ============================================================

CREATE TABLE IF NOT EXISTS cascades (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning'
    CHECK(status IN('planning','investigating','validating','synthesizing','complete','stalled')),
  plan_json TEXT CHECK(plan_json IS NULL OR json_valid(plan_json)),
  pid_state_json TEXT,
  max_rounds INTEGER DEFAULT 5,
  current_round INTEGER DEFAULT 0,
  token_budget INTEGER DEFAULT 500000,
  tokens_used INTEGER DEFAULT 0,
  exploration_budget REAL DEFAULT 0.8,
  created_at TEXT DEFAULT(datetime('now')),
  updated_at TEXT DEFAULT(datetime('now'))
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  cascade_id TEXT NOT NULL REFERENCES cascades(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN('technical','discovery','classification','validation')),
  status TEXT DEFAULT 'pending' CHECK(status IN('pending','active','done','failed')),
  agent_name TEXT,
  model_used TEXT,
  ucb_value REAL DEFAULT 0.0,
  ucb_visits INTEGER DEFAULT 0,
  ucb_reward REAL DEFAULT 0.0,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_threads_cascade ON threads(cascade_id);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
  cascade_id TEXT REFERENCES cascades(id) ON DELETE CASCADE,
  claim TEXT NOT NULL,
  evidence TEXT,
  source_url TEXT,
  source_type TEXT CHECK(source_type IN('primary','secondary','tertiary')),
  confidence REAL DEFAULT 0.5,
  confidence_uncertainty REAL DEFAULT 1.0,
  trust_composite REAL DEFAULT 0.5,
  trust_signals_json TEXT,
  grade_level TEXT CHECK(grade_level IS NULL OR grade_level IN('high','moderate','low','very_low')),
  quarantined INTEGER DEFAULT 0,
  human_reviewed INTEGER DEFAULT 0,
  retrieval_weight REAL DEFAULT 1.0,
  cd47_protected INTEGER DEFAULT 0,
  cascade_round INTEGER NOT NULL,
  ncd_cluster_id TEXT,
  created_at TEXT DEFAULT(datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_findings_cascade ON findings(cascade_id);
CREATE INDEX IF NOT EXISTS idx_findings_quarantined ON findings(quarantined) WHERE quarantined = 1;

CREATE VIRTUAL TABLE IF NOT EXISTS findings_fts USING fts5(
  claim, evidence, source_url, content=findings, content_rowid=rowid
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS findings_ai AFTER INSERT ON findings BEGIN
  INSERT INTO findings_fts(rowid, claim, evidence, source_url)
  VALUES (new.rowid, new.claim, new.evidence, new.source_url);
END;

CREATE TRIGGER IF NOT EXISTS findings_ad AFTER DELETE ON findings BEGIN
  INSERT INTO findings_fts(findings_fts, rowid, claim, evidence, source_url)
  VALUES ('delete', old.rowid, old.claim, old.evidence, old.source_url);
END;

CREATE TRIGGER IF NOT EXISTS findings_au AFTER UPDATE ON findings BEGIN
  INSERT INTO findings_fts(findings_fts, rowid, claim, evidence, source_url)
  VALUES ('delete', old.rowid, old.claim, old.evidence, old.source_url);
  INSERT INTO findings_fts(rowid, claim, evidence, source_url)
  VALUES (new.rowid, new.claim, new.evidence, new.source_url);
END;

CREATE TABLE IF NOT EXISTS cascade_checkpoints (
  task_id TEXT NOT NULL,
  round_index INTEGER NOT NULL,
  step_index INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN('pending','running','done','failed','skipped')),
  state_snapshot TEXT,
  idempotency_key TEXT UNIQUE,
  error_message TEXT,
  created_at TEXT DEFAULT(datetime('now')),
  completed_at TEXT,
  PRIMARY KEY (task_id, round_index, step_index)
);

CREATE TABLE IF NOT EXISTS idempotency_cache (
  key TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  created_at TEXT DEFAULT(datetime('now')),
  expires_at TEXT
);

-- ============================================================
-- TIER 2: KNOWLEDGE GRAPH
-- ============================================================

CREATE TABLE IF NOT EXISTS kg_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  properties TEXT DEFAULT '{}',
  community_id INTEGER,
  betweenness REAL DEFAULT 0.0,
  tier TEXT DEFAULT 'working' CHECK(tier IN('peripheral','working','core')),
  access_count INTEGER DEFAULT 0,
  importance REAL DEFAULT 0.5,
  last_accessed TEXT DEFAULT(datetime('now')),
  created_at TEXT DEFAULT(datetime('now')),
  UNIQUE(name, entity_type)
);
CREATE INDEX IF NOT EXISTS idx_entities_tier ON kg_entities(tier);
CREATE INDEX IF NOT EXISTS idx_entities_community ON kg_entities(community_id);

CREATE TABLE IF NOT EXISTS kg_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  properties TEXT DEFAULT '{}',
  activation_count INTEGER DEFAULT 0,
  last_activated TEXT DEFAULT(datetime('now')),
  created_at TEXT DEFAULT(datetime('now')),
  UNIQUE(source_id, target_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON kg_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON kg_edges(target_id);

CREATE TABLE IF NOT EXISTS kg_entity_chunks (
  entity_id INTEGER REFERENCES kg_entities(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL,
  relevance REAL DEFAULT 1.0,
  PRIMARY KEY (entity_id, chunk_id)
);

CREATE TABLE IF NOT EXISTS hypotheses (
  id TEXT PRIMARY KEY,
  cascade_id TEXT REFERENCES cascades(id) ON DELETE CASCADE,
  statement TEXT NOT NULL,
  parent_id TEXT,
  affinity REAL DEFAULT 0.5,
  generation INTEGER DEFAULT 0,
  status TEXT DEFAULT 'proposed'
    CHECK(status IN('proposed','testing','supported','refuted','uncertain','archived')),
  supporting TEXT DEFAULT '[]',
  contradicting TEXT DEFAULT '[]',
  mutation_history TEXT DEFAULT '[]',
  cd47_protected INTEGER DEFAULT 0,
  created_at TEXT DEFAULT(datetime('now')),
  updated_at TEXT DEFAULT(datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hypotheses_cascade ON hypotheses(cascade_id);
CREATE INDEX IF NOT EXISTS idx_hypotheses_status ON hypotheses(status);

-- ============================================================
-- TIER 2b: A-MEM ZETTELKASTEN LAYER
-- ============================================================

CREATE TABLE IF NOT EXISTS atomic_notes (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  note_type TEXT NOT NULL DEFAULT 'insight'
    CHECK(note_type IN('insight','connection','question','contradiction','synthesis')),
  source_finding_id TEXT REFERENCES findings(id),
  source_entity_id INTEGER REFERENCES kg_entities(id),
  cascade_id TEXT REFERENCES cascades(id) ON DELETE CASCADE,
  cascade_round INTEGER,
  keywords TEXT DEFAULT '[]',
  maturity TEXT DEFAULT 'isolated_fact'
    CHECK(maturity IN('isolated_fact','connected_fact','principle','mental_model')),
  access_count INTEGER DEFAULT 0,
  last_accessed TEXT DEFAULT(datetime('now')),
  created_at TEXT DEFAULT(datetime('now'))
);

CREATE TABLE IF NOT EXISTS note_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_note_id TEXT NOT NULL REFERENCES atomic_notes(id) ON DELETE CASCADE,
  target_note_id TEXT NOT NULL REFERENCES atomic_notes(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL DEFAULT 'relates_to'
    CHECK(link_type IN('relates_to','supports','contradicts','refines','generalizes','exemplifies')),
  strength REAL DEFAULT 1.0,
  bidirectional INTEGER DEFAULT 1,
  created_at TEXT DEFAULT(datetime('now')),
  UNIQUE(source_note_id, target_note_id, link_type)
);
CREATE INDEX IF NOT EXISTS idx_note_links_source ON note_links(source_note_id);
CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(target_note_id);

-- ============================================================
-- TIER 3: TRUST & ANALYTICS
-- ============================================================

CREATE TABLE IF NOT EXISTS source_reputation (
  domain TEXT PRIMARY KEY,
  reputation_score REAL DEFAULT 0.5,
  total_entries INTEGER DEFAULT 0,
  admitted_entries INTEGER DEFAULT 0,
  flagged_entries INTEGER DEFAULT 0,
  rejected_entries INTEGER DEFAULT 0,
  last_updated TEXT DEFAULT(datetime('now'))
);

CREATE TABLE IF NOT EXISTS ingestion_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id TEXT,
  action TEXT CHECK(action IN('admitted','quarantined','rejected')),
  trust_composite REAL,
  signals_json TEXT,
  reason TEXT,
  decided_at TEXT DEFAULT(datetime('now')),
  human_override INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cascade_id TEXT REFERENCES cascades(id) ON DELETE CASCADE,
  round_index INTEGER,
  metric_name TEXT NOT NULL,
  metric_value REAL NOT NULL,
  recorded_at TEXT DEFAULT(datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_metrics_cascade ON metrics(cascade_id, metric_name);

-- ============================================================
-- TIER 4: MEMORY MANAGEMENT (SM-2 + CONSOLIDATION)
-- ============================================================

CREATE TABLE IF NOT EXISTS sm2_schedule (
  item_id TEXT PRIMARY KEY,
  item_type TEXT NOT NULL CHECK(item_type IN('finding','entity','hypothesis')),
  ease_factor REAL DEFAULT 2.5,
  interval_days REAL DEFAULT 1.0,
  repetitions INTEGER DEFAULT 0,
  next_review TEXT DEFAULT(datetime('now')),
  last_reviewed TEXT,
  retrieval_success_rate REAL DEFAULT 0.0
);

CREATE TABLE IF NOT EXISTS consolidation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cascade_id TEXT,
  trigger_type TEXT CHECK(trigger_type IN('round_boundary','context_saturation','manual')),
  items_processed INTEGER DEFAULT 0,
  items_promoted INTEGER DEFAULT 0,
  items_demoted INTEGER DEFAULT 0,
  items_pruned INTEGER DEFAULT 0,
  duration_ms INTEGER,
  created_at TEXT DEFAULT(datetime('now'))
);

-- ============================================================
-- TIER 5: STEER EVENTS & HITL
-- ============================================================

CREATE TABLE IF NOT EXISTS steer_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cascade_id TEXT NOT NULL REFERENCES cascades(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL
    CHECK(event_type IN('redirect','narrow','broaden','add_question','drop_hypothesis','approve','reject')),
  instruction TEXT NOT NULL,
  target_id TEXT,
  applied INTEGER DEFAULT 0,
  created_at TEXT DEFAULT(datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_steer_cascade ON steer_events(cascade_id, applied);
