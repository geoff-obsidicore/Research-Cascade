# Research Cascade — Master Specification
> Version 1.0 | March 15, 2026 | Distilled from 11-prompt research cascade across Claude + Gemini

## Purpose
This document is the durable synthesis of all research findings. It survives context clears and serves as the authoritative reference for implementation. Read this before writing any code.

**Companion document:** `spec/Research Cascade Memory Plan.md` — the full research cascade plan with raw findings, cross-model synthesis, and decision history. This spec is the DISTILLED architecture; the plan is the COMPLETE research record. Both documents should be read together for full context.

---

## Design Philosophy

**First Principles:**
1. **Compression = Understanding** — If you can compress knowledge shorter, you understand it better (Solomonoff). MDL fitness measures this.
2. **Files win** — File-based memory beats specialized tools (74% LoCoMo). Keep <200 lines for >92% rule application.
3. **CLI-native** — LLMs trained on CLI interactions. Shell commands, curl, pipes are the natural interface.
4. **Work WITH the brain** — OpenClaw harness steers Claude Opus, but the system must align with how LLMs naturally reason.
5. **Durable synthesis bridges context destruction** — At research milestones, produce condensed documents that carry understanding forward. This IS the cascade's memory consolidation.

**Schlereth's Law:** Systems in forced compression face exactly 3 exits: truncate, confabulate, or loop. Design to detect and handle all three.

**Cross-model diversity** is a feature, not just methodology. Technical queries → single model. Discovery queries → Claude + Gemini, synthesize divergences.

---

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│              OpenClaw Harness                │
│   (registerHook, registerService, Gateway)   │
├─────────────────────────────────────────────┤
│           MCP Server (Node.js)              │
│   ┌────────┐  ┌──────────┐  ┌───────────┐  │
│   │ 12+    │  │ SQLite   │  │ Model     │  │
│   │ Tools  │  │ WAL DB   │  │ Router    │  │
│   └────────┘  └──────────┘  └───────────┘  │
├─────────────────────────────────────────────┤
│         Claude Opus 4.6 (1M context)        │
│              (the brain)                     │
└─────────────────────────────────────────────┘
```

**Three-layer separation:**
1. **SKILL.md** = research protocol (guides the agent's behavior, ≤10 numbered steps per phase)
2. **MCP server** = state machine (tracks progress, stores findings, manages knowledge graph — NOT an orchestrator)
3. **Cron/HEARTBEAT.md** = watchdog (detects stalling, nudges agent to continue)

**The AGENT orchestrates.** The engine tracks state. The cron prevents stalling. This is how every successful autonomous OpenClaw skill works (Option C pattern).

**Database:** Own SQLite at `~/.openclaw/plugins/cascade/knowledge.db`. Read OpenClaw's Markdown files for context. NEVER touch OpenClaw's internal SQLite (undocumented, disposable, changes between versions).

**MCP tool naming:** Tools registered by native name (NOT `mcp__server__tool` — that's Claude Code). Agent calls `store_finding`, `cascade_status`, etc. directly.

**Anti-stall (three-layer nudge stack):**
- HEARTBEAT.md: 30min baseline (Gateway wakes agent, checks active cascades)
- Cron: 5min during active research (`--every 300000 --system-event "Check cascade progress"`)
- MCP `check_progress` tool: called at start of each agent cycle

**Subagent delegation:**
```
Main Agent (Opus, coordination/synthesis)
  ├── Sub-agent A (Sonnet, cheaper)
  ├── Sub-agent B (Sonnet, cheaper)
  └── Sub-agent C (Sonnet, cheaper)
```
- `maxSpawnDepth: 2`, `maxConcurrent: 8`, sub-agents share MCP tools
- Sub-agents write to shared knowledge.db, announce results to parent

---

## Core Loop

```
ROUND N:
  PID → intensity | SM-2 → due_topics | Linear schedule → explore/exploit budget
  → Identify (web_search, decompose)
  → Screen (relevance + NCD dedup + trust scoring)
  → Evaluate (web_fetch, GRADE evidence, Kalman confidence fusion)
  → Consolidate (interleaved replay, retrieval testing, graph update)
  → Mature (clonal selection, affinity maturation)
  → Prune (activity-decay + CD47 protection)
  → Synthesize (MDL compression)
  → Observe (Lyapunov stability, entropy convergence)
  → CONTINUE or STOP → PRISMA audit + export
```

**Quality gates between each phase.** Pre-registered research plan locks criteria at round start.

---

## SQLite Schema (~15 tables, 3 tiers)

### Required PRAGMAs
```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 10000;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;
```
**CRITICAL: SQLite ≥3.51.3 required** (WAL-reset corruption fix, 2026-03-13).

### Tier 1 — Cascade State

```sql
CREATE TABLE cascades (
  id TEXT PRIMARY KEY, question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning'
    CHECK(status IN('planning','investigating','validating','synthesizing','complete','stalled')),
  plan_json TEXT CHECK(plan_json IS NULL OR json_valid(plan_json)),
  pid_state_json TEXT, created_at TEXT DEFAULT(datetime('now')),
  updated_at TEXT DEFAULT(datetime('now'))
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY, cascade_id TEXT NOT NULL REFERENCES cascades(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN('technical','discovery','classification','validation')),
  status TEXT DEFAULT 'pending' CHECK(status IN('pending','active','done','failed')),
  agent_name TEXT, model_used TEXT, started_at TEXT, completed_at TEXT
);

CREATE TABLE findings (
  id TEXT PRIMARY KEY, -- content-addressable hash
  thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
  cascade_id TEXT REFERENCES cascades(id) ON DELETE CASCADE,
  claim TEXT NOT NULL, evidence TEXT, source_url TEXT,
  source_type TEXT CHECK(source_type IN('primary','secondary','tertiary')),
  confidence REAL DEFAULT 0.5, -- Kalman-fused
  trust_composite REAL DEFAULT 0.5,
  trust_signals_json TEXT, grade_level TEXT,
  quarantined INTEGER DEFAULT 0, human_reviewed INTEGER DEFAULT 0,
  retrieval_weight REAL DEFAULT 1.0,
  cascade_round INTEGER NOT NULL,
  created_at TEXT DEFAULT(datetime('now'))
);

CREATE VIRTUAL TABLE findings_fts USING fts5(claim, evidence, source_url, content=findings);

CREATE TABLE cascade_checkpoints (
  task_id TEXT NOT NULL, round_index INTEGER NOT NULL,
  step_index INTEGER NOT NULL, step_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  state_snapshot TEXT, idempotency_key TEXT UNIQUE,
  created_at TEXT DEFAULT(datetime('now')),
  PRIMARY KEY (task_id, round_index, step_index)
);

CREATE TABLE idempotency_cache (
  key TEXT PRIMARY KEY, result_json TEXT NOT NULL,
  created_at TEXT DEFAULT(datetime('now')), expires_at TEXT
);
```

### Tier 2 — Knowledge Graph

```sql
CREATE TABLE kg_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, entity_type TEXT NOT NULL,
  properties TEXT DEFAULT '{}',
  community_id INTEGER, betweenness REAL DEFAULT 0.0,
  tier TEXT DEFAULT 'working' CHECK(tier IN('peripheral','working','core')),
  created_at TEXT DEFAULT(datetime('now')),
  UNIQUE(name, entity_type)
);

CREATE TABLE kg_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  weight REAL DEFAULT 1.0, properties TEXT DEFAULT '{}',
  activation_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT(datetime('now'))
);
CREATE INDEX idx_edges_source ON kg_edges(source_id);
CREATE INDEX idx_edges_target ON kg_edges(target_id);

CREATE TABLE kg_entity_chunks (
  entity_id INTEGER REFERENCES kg_entities(id) ON DELETE CASCADE,
  chunk_id INTEGER, relevance REAL DEFAULT 1.0,
  PRIMARY KEY (entity_id, chunk_id)
);

CREATE TABLE hypotheses (
  id TEXT PRIMARY KEY, cascade_id TEXT REFERENCES cascades(id) ON DELETE CASCADE,
  statement TEXT NOT NULL, parent_id TEXT,
  affinity REAL DEFAULT 0.5, generation INTEGER DEFAULT 0,
  status TEXT DEFAULT 'proposed' CHECK(status IN('proposed','supported','refuted','uncertain')),
  supporting TEXT DEFAULT '[]', contradicting TEXT DEFAULT '[]',
  created_at TEXT DEFAULT(datetime('now'))
);
```

### Tier 3 — Trust & Analytics

```sql
CREATE TABLE source_reputation (
  domain TEXT PRIMARY KEY, reputation_score REAL DEFAULT 0.5,
  total_entries INTEGER DEFAULT 0, flagged_entries INTEGER DEFAULT 0,
  last_updated TEXT
);

CREATE TABLE ingestion_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT,
  action TEXT CHECK(action IN('admitted','quarantined','rejected')),
  trust_composite REAL, signals_json TEXT,
  decided_at TEXT DEFAULT(datetime('now')), human_override INTEGER DEFAULT 0
);

CREATE TABLE metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cascade_id TEXT REFERENCES cascades(id) ON DELETE CASCADE,
  metric_name TEXT NOT NULL, metric_value REAL NOT NULL,
  recorded_at TEXT DEFAULT(datetime('now'))
);
```

---

## Key Algorithms

### Kalman Filter (confidence fusion)
```
K = P / (P + R)
confidence += K * (measurement - confidence)
uncertainty = (1 - K) * P
```
High R (unreliable source) → low K → measurement discounted. High P (uncertain claim) → high K → updated aggressively.

### NCD Deduplication
```typescript
function ncd(x: string, y: string): number {
  const cx = deflateSync(Buffer.from(x)).length;
  const cy = deflateSync(Buffer.from(y)).length;
  const cxy = deflateSync(Buffer.from(x + y)).length;
  return (cxy - Math.min(cx, cy)) / Math.max(cx, cy);
}
// <0.3 = redundant, >0.7 = novel
```

### PID Self-Regulation
```
error = coverage_gap*0.3 + low_confidence*0.3 + contradictions*0.2 + depth_gap*0.2
P = Kp * error
I = Ki * clamp(integral + error, max)
D = Kd * (error - prevError)
output = clamp(P + I + D, 0, 1) → maps to {searchBreadth, searchDepth, explorationRate}
```
Lyapunov stability: ΔV<0 = converging | alternating = oscillating (Kp×0.7) | all positive = diverging (emergency synthesis).

### Weibull Tier Decay
```
S(t) = exp(-(t/λ)^k)
Core:       k=0.8 (Lindy — survives longer over time)
Working:    k=1.0 (standard exponential)
Peripheral: k=1.3 (fades fast)

composite = 0.4×weibull + 0.3×min(1, access/10) + 0.3×importance×confidence
```
Promote: Working→Core when access≥10 AND composite≥0.7. Demote: Working→Peripheral when composite<0.15.
Graph-aware: peripheral connected to ≥2 core → promoted (spreading activation).

### Hypothesis Evolution (Clonal Selection)
```
temp = 0.3 + (1-affinity)*0.7     // high affinity = lower temp = protected
clones = ceil(affinity * 5)
threshold = 0.3 + round/maxRounds * 0.4  // increasing stringency
```
CD47 protection: active/cited findings immune from pruning. Archive, never delete.

### Explore/Exploit Budget
```
explorationBudget = max(0, 1 - round/maxRounds)  // Linear: 80/20→50/50→20/80
UCB(thread) = value + c × √(ln(N) / n_thread)    // Per-thread selection
```

### Trust Scoring (SpamAssassin model)
6 orthogonal signals → composite 0-1:
- Source reputation (domain age, known-good list)
- Cross-corroboration (N independent sources)
- Semantic anomaly (embedding distance from topic centroid)
- Instruction pattern detection (regex: OVERRIDE_ATTEMPT -0.40)
- Temporal consistency
- GRADE assessment (5 domains: bias, consistency, directness, precision, publication bias)

Thresholds: ≥0.7 auto-admit | 0.3-0.7 quarantine (HITL) | <0.3 reject.
Novel-vs-malicious: novel+precise+trusted = contested novelty (HITL). Novel+vague+untrusted = attack (reject).

---

## MCP Tools (12+)

| Tool | Purpose |
|------|---------|
| `store_plan` | Save immutable research plan |
| `store_finding` | Ingest finding with trust scoring |
| `get_findings` | Query findings (FTS + filters) |
| `add_entity` | Add KG entity |
| `add_link` | Add KG edge |
| `query_graph` | Recursive CTE traversal (≤3 hops) |
| `store_hypothesis` | Add/update hypothesis |
| `get_hypotheses` | Query hypothesis population |
| `classify_query` | Route to model (technical/discovery/classification) |
| `get_status` | Cascade state + PID + entropy |
| `update_status` | Advance phase/round |
| `get_metrics` | Information-theoretic dashboard |

---

## Multi-Model Dispatch

| Thread Type | Model | Cost/1M tok | Use |
|-------------|-------|-------------|-----|
| Classification | Haiku | $0.25 | Sorting, tagging, extraction |
| Discovery | Sonnet | $3 | Open exploration |
| Technical | Opus | $15 | Deep reasoning, synthesis |
| Validation | Sonnet | $3 | Cross-referencing |

Routing: `classify_query` → returns `{type, agent, model}` → dispatch named agent → agent selects model via frontmatter.

---

## CLI Commands

```bash
cascade research <query> [--max-rounds N] [--token-budget N] [--auto-approve]
cascade resume <task-id>
cascade replay <task-id> [--from round=N]    # time-travel via checkpoints
cascade status [task-id]
cascade quality [task-id]                     # coverage/depth/confidence/sources
cascade steer <task-id> <text>               # redirect/narrow/broaden/add_question/drop_hypothesis
cascade trust status | review [--quarantined]
cascade graph <id> --format dot | dot -Tsvg
cascade export <id> --format markdown|json
cascade self-improve <id>                    # v2: research own methodology
```

---

## Fault Tolerance

- **Checkpoint at every step** (not just rounds) — crash loses only current step
- **Idempotent upserts** via SHA-256 content hashes + `ON CONFLICT DO UPDATE`
- **Cockatiel resilience:** retry(4, exp backoff 30s) → circuitBreaker(3 consecutive) → bulkhead(3 concurrent) → timeout(60s)
- **Garbage detection heuristics** before KG integration: length, repetition, refusal patterns, topic relevance, specificity
- **Buffer in SQLite, commit to JSONL only after step completes** — prevents JSONL/DB divergence
- **Must use synchronous better-sqlite3** — async introduces V8 event-loop race conditions with JSONL state

---

## HITL Intervention Points

**BLOCKING:** Round 0 hypothesis (always) | hypothesis drift >0.6 | round boundaries (15min timeout)
**ADVISORY:** trust <0.4 (2min) | circuit breaker open (1min) | confidence <0.5 (3min)
**SILENT:** search planning (log only)

**Steering:** `/steer <instruction>` → appends to JSONL as system hint → agent pivots on next iteration. Types: redirect, narrow, broaden, add_question, drop_hypothesis.

**Dashboard:** ANSI header (metrics/phase) + scrolling stdout (NDJSON) + readline prompt. NO TUIs (crash in tmux/SSH). Optional `--tui` flag.

**Quality review (without reading everything):** 4 metrics at round boundaries: coverage, depth, confidence, source quality. Plus 3-sentence LLM summary + identified gaps.

---

## Anti-Patterns (Guardrails)

| Domain | Anti-Pattern | Detection/Prevention |
|--------|-------------|---------------------|
| Scientific | HARKing (post-hoc criteria changes) | Immutable pre-registered plan |
| Scientific | Infinite exploration | Linear explore/exploit budget |
| Zettelkasten | Orphan notes | Periodic orphan detection query |
| Zettelkasten | Hub-and-spoke collapse | Max edge count per node |
| Cognitive | Testing too early (<50%) | Min findings threshold before recall test |
| Cognitive | Re-summarizing summaries | Always refer to episodic buffer, not summaries |
| Control | Oscillating PID | Reduce Kp by 0.7× on alternating error signs |
| Control | Integral windup | Anti-windup cap on accumulator |
| Immunology | Original Antigenic Sin | Enforce minimum hypothesis diversity |
| Immunology | Premature dominance | Diversity floor check per round |
| Info Theory | Over-compression = hallucination | MDL detects when model grows without explanatory gain |
| Info Theory | Surprise ≠ value | NCD + trust scoring filter noise |
| Security | MINJA memory poisoning | 6-signal trust scoring, sandboxed ingestion |
| Amplification | Reasoning Trap (hallucination compounds) | Per-round garbage detection, Kalman discounting |

---

## Concurrency Model

- Single writer process + multiple reader connections (eliminates SQLITE_BUSY)
- Recursive CTEs hold read snapshots → bound ≤3 hops (completes <500ms)
- `BEGIN IMMEDIATE` for writes (acquire lock upfront)
- Monitor WAL size → `PRAGMA wal_checkpoint(PASSIVE)` when >50MB
- Node.js: better-sqlite3 (sync API, minimizes lock hold time)

---

## Graph Queries

### The "money query" (hybrid vector + graph + FTS)
```sql
WITH seed_chunks AS (
  SELECT rowid AS chunk_id, distance FROM chunks_vec
  WHERE embedding MATCH :query_embedding ORDER BY distance LIMIT 10
), seed_entities AS (
  SELECT DISTINCT ec.entity_id FROM kg_entity_chunks ec
  JOIN seed_chunks sc ON ec.chunk_id = sc.chunk_id
), expanded AS (
  SELECT entity_id FROM seed_entities
  UNION SELECT e.target_id FROM kg_edges e
    JOIN seed_entities se ON e.source_id = se.entity_id WHERE e.weight > 0.5
  UNION SELECT e.source_id FROM kg_edges e
    JOIN seed_entities se ON e.target_id = se.entity_id WHERE e.weight > 0.5
), related_chunks AS (
  SELECT DISTINCT ec.chunk_id FROM kg_entity_chunks ec
  JOIN expanded exp ON ec.entity_id = exp.entity_id
)
SELECT c.id, c.content, fts.rank FROM chunks c
JOIN chunks_fts fts ON c.id = fts.rowid
WHERE chunks_fts MATCH :text_query AND c.id IN (SELECT chunk_id FROM related_chunks)
ORDER BY fts.rank LIMIT 20;
```

### Performance expectations
| Edges | ≤3 hops | Notes |
|-------|---------|-------|
| 10K | <50ms | Agent memory sweet spot |
| 100K | 50-500ms | Upper practical limit |
| 1M | 0.5-5s | Export to Neo4j at this scale |

---

## Community Detection

External python-igraph script (cannot run in SQLite):
- **Leiden** over Louvain (better guarantees, actually faster)
- Betweenness centrality with cutoff=3
- At ≤50K nodes, full recompute <1s → no incremental needed
- Write community_id + betweenness back to kg_entities
- Watch: high betweenness = bridge concepts (most valuable for cross-domain reasoning)

---

## Implementation Order

1. **MCP server + SQLite schema** — `servers/cascade-engine/`, all ~15 tables, WAL mode, PRAGMAs
2. **Cascade engine core** — init → search → evaluate → synthesize loop with quality gates
3. **Knowledge graph + A-MEM** — entities, edges, atomic notes, LLM-curated links
4. **Trust scoring + security** — SpamAssassin model, GRADE, quarantine buffer
5. **PID + Kalman + stability** — self-regulation, confidence fusion, Lyapunov checks
6. **Consolidation + SM-2** — memory management, tier promotion, retrieval testing
7. **HITL + dashboard** — intervention points, steering, ANSI dashboard
8. **Hooks + distribution** — OpenClaw integration, plugin packaging

---

## Key Dependencies

- `better-sqlite3` (sync SQLite, native module)
- `@anthropic-ai/sdk` (Claude API)
- `@modelcontextprotocol/sdk` (MCP server)
- `igraph` (community detection, `pip install igraph` NOT python-igraph)
- `zlib` (NCD deduplication, Node.js built-in)

---

## Windows 11 Critical Notes

- **Node 22 LTS ONLY** — better-sqlite3 ships prebuilt binaries for Node LTS. Node 24 causes unfixable V8 ABI mismatches. If compilation needed: VS Build Tools 2022 + "Desktop development with C++" + `npm config set msvs_version 2022`. Fallback: sql.js (pure WASM).
- **igraph:** `pip install igraph` (NOT python-igraph — deprecated name). C library bundled in wheel. Fallback: NetworkX (pure Python, much slower).
- **Paths:** `path.join()` for filesystem, `path.posix.join()` for URLs/config. Never manual `/` or `\\`.
- **MCP stdio on Windows:** `npx` is a `.cmd` batch script — `spawn()` can't execute without shell. Fix:
  ```json
  {"command": "cmd", "args": ["/c", "node", "dist/mcp/server.js"]}
  ```
- **NEVER `console.log()` in MCP server** — corrupts stdout JSON-RPC. Use `console.error()` only.
- **Enable Win32 long paths** via Group Policy if path issues arise.
- **WSL2 eliminates nearly all Windows issues** — strongly recommended if feasible.
- **SQLite ≥3.51.3** (WAL-reset bug fix from March 13, 2026)

---

## Implementation Scaffolding (Claude Code Build Protocol)

### CLAUDE.md Design (~120 lines)
Routing matrix, not data store. Imperatives not descriptions. Most important rules first.
Reference specs by **description** (Claude reads on demand), NOT `@import` (embeds every session).
CLAUDE.md survives `/compact` and `/clear` — reloads from disk.

**Hierarchy:** `~/.claude/CLAUDE.md` (global) → root `CLAUDE.md` → subdirs → `.claude/rules/*.md` (glob-targeted).

**Template structure:** Tech Stack → Architecture (paths) → Reference Documents (descriptions) → Commands → Code Conventions (10-15 rules) → Workflow → Prohibitions (NEVER rules get highest compliance).

### Memory Architecture
MEMORY.md hard limit: **200 lines loaded per session.** Index → topic files:
```
memory/
├── MEMORY.md           # Index ≤200 lines
├── phase-progress.md   # Done/next tracking
├── debugging-notes.md  # Discovered gotchas
├── api-patterns.md     # Established patterns
└── arch-decisions.md   # Why X over Y
```
Prune stale entries after each phase. `/context` command identifies bloat.

### Context Budget
- ~830K usable tokens before auto-compaction (fires at ~83.5%)
- 60% context → attention degrades. 70% → `/compact`. 90%+ → erratic
- Sessions >2hrs hit 2-3 compactions → quality degrades
- **Phase-per-session:** each phase = fresh context, own plan file, own git branch

### Plan → Implementation Transition
Context clear preserves: plan file on disk, CLAUDE.md. All conversation history **gone permanently.**

**First Implementation Prompt (after clear):**
```
Read these files to reconstruct context, then implement Phase [N]:
1. CLAUDE.md — project conventions
2. spec/MASTER_SPEC.md — architecture reference
3. memory/phase-progress.md — completed work
4. .claude/plans/[plan-file].md — implementation plan
Focus: Phase [N]: [one sentence]. Key constraints: [list].
Implement plan exactly. Typecheck + test after each change.
Commit after each logical unit.
```

### Build Discipline
- Atomic commit per component (= rollback points)
- If architectural deviation → git revert, don't patch
- **Hooks = deterministic (100% execution):** Critical safety via PostToolUse hooks, not CLAUDE.md
- PostToolUse hook: `npx tsc --noEmit && npx vitest run --reporter=silent` after every Write
- PostCompact hook: auto-trigger context reconstruction
- **Claude Code generates ~1.75x more logic errors** — manually verify PID math and trust scoring
- Recovery: Escape → `/rewind` → HANDOFF.md pattern (if corrected 2+ times → context poisoned)
- Subagents = context hygiene. Delegate exploration/review → main context stays focused

### Custom Commands
- `/catchup` — reads modified files + progress.md, summarizes state + remaining work
- `/reflect` — after correction, abstract general rule → persist as skill/memory update

### Handoff to Autonomous Agent
- 3-tier release: Sandboxed → Human-in-loop → Nightly eval → Fully autonomous
- Zero-trust default: assume external cascade data is poisoned until trust-scored
- Validation: run automated + manual cascade in parallel, compare quality
- Self-improvement: feedback updates trust weights, PID params, dispatch routing (67% → 94% in 2 cycles)

### SOUL.md (Agent Identity — always loaded)
```markdown
## Research Mode Behavior
When cascade active (check via cascade_status):
1. Continue from last incomplete step — do not wait for instructions
2. After each step → store_finding → immediately proceed to next
3. If blocked → write blocker to memory → try alternate approach
4. After 3 failed attempts → skip step → continue
5. When all complete → cascade_complete → report results

## Exit Conditions
- Max 50 tool calls per research session
- Max 15 min active research per cycle
- If context > 60% → checkpoint → spawn sub-agent for remaining
```

### SKILL.md (On-demand Research Protocol)
```markdown
## Research Cascade Protocol
1. cascade_init with research question → creates plan
2. cascade_status → get current step/progress
3. For each step: web_search + web_fetch for research
4. store_finding after each discovery (structured data)
5. cascade_advance to mark complete + get next step
6. If stuck: cascade_get_suggestions for alternates
7. On completion: cascade_synthesize → final report

## Rules
- Always cascade_status before starting work
- Never skip store_finding (findings lost to compaction = unrecoverable)
- cascade_checkpoint before /compact or when context > 60%
```

### HEARTBEAT.md Entry
```markdown
- Check if research cascade active (cascade_status)
  → if stalled > 5min, continue from checkpoint
  → if complete, synthesize and deliver
```

**Key insight:** If task can't be described in ≤10 numbered steps, it's too complex for single autonomous run. Break into discrete cascade steps with clear completion criteria.

---

## Advanced Architecture (v2+ — Visionary Mechanisms)

These mechanisms emerged from cross-disciplinary deep research through the lens of Tesla, Prigogine, Hofstadter, Friston, Luhmann, and others. Implement after core system is stable.

### Phase Transition Detection (cross-model validated)
The graph goes from "collecting facts" to "generating insight" at a measurable percolation threshold.
- **Fast metric:** Structural entropy `H_SI = -Σᵥ(dᵥ/2m)log₂(dᵥ/2m)` — O(n), bounded within log₂(e) of exact Von Neumann entropy
- **Percolation threshold:** Giant component emerges at avg degree `⟨k⟩ ≈ 1` (Erdős-Rényi). Post-threshold: adjacent possible grows combinatorially.
- **Concrete thresholds:**

| Metric | Pre | Threshold | Post |
|---|---|---|---|
| Giant component fraction | <0.3 | ≈0.5 | >0.7 |
| Avg degree 2|E|/|V| | <1.0 | **≈1.0** | >2.0 |
| Entropy rate dH/dt | Rising | Inflection | Declining |
| Modularity Q (Leiden) | <0.1 | 0.3 | 0.4-0.7 |

- **Strategy shift:** Pre → maximize breadth (every edge → criticality). Post → exploit structure, community-boundary contradictions = research frontiers.

### Latent Semantic Bridges (Graph-Informed Prompting)
The most valuable connections are nodes with HIGH embedding similarity but HIGH topological distance (>4 hops). These are Luhmann's "surprises" — connections the graph structure hasn't recognized yet.
- Find: embedding cosine > 0.7 AND shortest path > 4 hops
- Force LLM to synthesize the connection between these distant-but-similar concepts
- This IS the mechanism for emergent understanding

### Activation Spreading (Tesla Resonance)
Query excitation propagates through the graph like a wave: `dAᵢ/dt = -δAᵢ + ΣWᵢⱼAⱼ + Eᵢ`
- **Antinodes** (high activation + high eigenvector centrality) = core paradigms to include in context
- **Low activation gaps** = targeted research questions
- **Practical:** Run N iterations of spreading activation from query node, inject highest-activation nodes into LLM context

### Structural Analogy (Hofstadter)
VF2 subgraph isomorphism on embeddings: find historical subgraph S structurally identical to target T. Project established rules of S onto unverified T. This IS "analogy as cognition" — understanding the unknown by mapping it to the known.

### Strategy Memory (Meta-Learning)
Table: `strategy_id | state_vector | topology_signature | action_sequence | epistemic_yield`
- **Fitness:** Epistemic Yield = Δ graph entropy per compute token
- **Selection:** k-NN match current state to historical topology_signature → deploy proven action_sequence
- **No trial-and-error:** Pattern-match against what worked before

### Transmissible Understanding (Graph Export)
**Minimum Viable Seed:** Top 5% PageRank hubs + topological boundary edges + constructor sequence (prompts + PID params + PRISMA gates). Forces new agent into exact cognitive posture of the previous cascade.
**Interchange format:** RDF-star JSON-LD — edges as reified objects with confidence + provenance arrays.
**Deterministic merge:** Edge collisions → Bayesian update on confidence + array concatenation on provenance. Zero context loss.

### Graph-Informed Prompting (3 modules, activate post-phase-transition)
**Luhmann Module:** Biased random walks (node2vec p=0.5, q=2.0). 3 PageRank entry points × 10 walks × length 15. Surprise = node on ≥2 walks from different entries. Rank: `0.4×relevance + 0.3×walk_freq + 0.3×surprise`.
**Tesla/Burt Module:** Top-5% betweenness nodes = bridge concepts. Generate: `"[X] bridges [A] and [B]—consider cross-domain transfer."` Disconnected components → `"No path between [A] and [B]—predict intermediate concept."`
**Hofstadter Module:** WL graph kernel O(hm) for structural similarity. Analogy = `WL_sim > 0.6 AND semantic_distance > 0.7`.
**Prompt tags:** `[BRIDGE]`, `[SURPRISE]`, `[ANALOGY]`, `[GAP]` injected into LLM context.

### Strategy Memory (strategies table — add in v2)
```sql
CREATE TABLE strategies (
  id TEXT PRIMARY KEY,
  trigger_embedding BLOB, graph_density REAL, contradiction_level REAL,
  active_strategies JSON, outcome_delta REAL,
  mean_reward REAL, n_applications INTEGER, success_rate REAL,
  max_depth INTEGER, breadth_limit INTEGER, confidence_threshold REAL,
  parent_id TEXT, mutation_type TEXT, generation INTEGER
);
```
Selection: k-NN on trigger_embedding. If similarity >0.85 → execute immediately (Boyd's IG&C). Else UCB1+Context. Evolution: mutation (Gaussian noise on params), crossover, destruction-creation on clustered failures.

### The Unified Objective (Free Energy Minimization — cross-model validated)
Both Claude and Gemini independently derived the same equation. **Proven equivalences** (not analogies): ELBO = two-part MDL (Hinton/Zemel 1994). Information Bottleneck = special case. Friston 2023 proved path integral reduces to variational F.
```
F_t = E_q[-log p(D_t|G_t)] + β·KL[q(G_t)||p(G_t)]
      ├─ prediction error      ├─ model complexity (MDL)

Action: π* = argmin_π [-E[log p(o|s)] + KL[q(s|π)||q(s|o,π)]]
                        ├─ relevance    ├─ info gain

Stop: |F_t - F_{t-1}| < ε (compression progress exhausted)
Validate: D_KL(p(D|sources) || p(D̂|G*)) < δ (Feynman reconstruction test)
```
- **Channel capacity per round:** `C = N_tokens × η_retrieval × log₂(1 + SNR_relevance)`. Below → wasting compute. At → optimal. Above → hallucinating.
- **Bateson's learning levels:** I = update values, II = change structure, III = restructure framework. Double bind (contradictions across levels) → level change trigger.
- **Schlereth's Law as corollary:** Forced compression below capacity → truncate (detect via coverage), confabulate (detect via trust scoring), or loop (detect via PID oscillation).

---

## Research Cascade Design Pattern (Meta)

This spec was produced using the Research Cascade methodology:
1. Craft discovery prompts → run deep research on Claude Desktop AND Gemini
2. Synthesize findings → compare cross-model (agreement/complementary/contradiction/blind spots)
3. Use results to inform next round → each round builds on validated understanding
4. At milestones, produce **durable synthesis documents** (like this spec) that survive context destruction
5. Reference these documents in plan mode to preserve critical context across clears

**This pattern IS the system we're building.** The first dogfood test is this project itself.
