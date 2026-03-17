# Research Cascade

Progressive deep research engine with knowledge graph, trust scoring, and self-regulation. Runs as an MCP server — plug it into Claude Code (or any MCP client) and it tracks your research across sessions, builds a persistent knowledge graph, scores source trustworthiness, and tells you when to stop.

**Status:** Dogfood-validated. 4-round cascade produced 31 findings, 37 entities, 48 edges, 8 hypotheses across 4 generations. PID self-regulation converged correctly. Trust scoring caught 1 low-quality claim. [Full results below.](#dogfood-results)

## Quick Start

```bash
# Clone and build
git clone https://github.com/geoff-obsidicore/Research-Cascade.git
cd Research-Cascade/servers/cascade-engine
npm install
npm run build
cp src/db/schema.sql dist/db/schema.sql

# Run tests (78 tests, all passing)
npm test
```

The `.mcp.json` in the project root registers the server automatically. Start a Claude Code session from the project directory and all 15 tools are available:

```bash
cd Research-Cascade
claude
```

Then tell Claude to run a cascade:

```
Use cascade_init to start researching "your question here",
then store_plan with sub-questions, and run the full cascade loop.
```

The knowledge graph persists in `~/.cascade-engine/knowledge.db` — it survives context compaction, session restarts, and `/clear`.

## How It Works

The cascade follows an 8-phase loop per round, with quality gates between each phase:

```
ROUND N:
  Identify   → Decompose question into search queries (UCB explore/exploit)
  Screen     → Filter by relevance, NCD dedup, trust scoring
  Evaluate   → Deep fetch, GRADE evidence assessment, Kalman confidence fusion
  Consolidate → Graph update, tier management, SM-2 scheduling
  Mature     → Hypothesis evolution (clonal selection, affinity maturation)
  Prune      → Activity-decay + CD47 protection (archive, never delete)
  Synthesize → MDL compression, round summary
  Observe    → PID self-regulation, Lyapunov stability, stopping check
  → CONTINUE or STOP
```

Each round narrows scope while deepening understanding. The exploration budget decreases linearly (80/20 → 50/50 → 20/80) so early rounds explore broadly and later rounds exploit what's been found.

**Stopping conditions** (any triggers cascade completion):
- Coverage and depth decelerating (diminishing returns)
- PID error below threshold (convergence)
- Entropy plateau (knowledge graph structure stabilized)
- Token budget exhausted
- Max rounds reached

## Architecture

```
┌─────────────────────────────────────────────┐
│           MCP Server (stdio)                │
│                                             │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ 15 Tools │  │ SQLite   │  │ Trust     │ │
│  │          │  │ WAL DB   │  │ Scoring   │ │
│  └──────────┘  └──────────┘  └───────────┘ │
│                                             │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ Knowledge│  │ PID +    │  │ Memory    │ │
│  │ Graph    │  │ Kalman   │  │ Mgmt      │ │
│  └──────────┘  └──────────┘  └───────────┘ │
├─────────────────────────────────────────────┤
│          Claude / Any MCP Client            │
│              (the brain)                    │
└─────────────────────────────────────────────┘
```

The server **tracks state**. The LLM **orchestrates**. This separation means:
- The LLM decides what to research and how to interpret findings
- The engine ensures nothing is lost, scores trust, detects convergence
- The knowledge graph persists across sessions — pick up where you left off

### Source Layout

```
servers/cascade-engine/src/
  index.ts          — MCP server entry (15 tools, stdio)
  db/               — SQLite schema + wrapper (WAL, PRAGMAs, migrations)
  cascade/          — FSM engine, quality gates, checkpoints, search planning
  graph/            — KG entities, edges, recursive CTE traversal
  trust/            — 6-signal scoring, injection patterns, sandboxed ingestion
  control/          — PID controller, Kalman filter, Lyapunov stability
  memory/           — NCD dedup, Weibull tiers, SM-2 spaced repetition
  hitl/             — Interventions, steering events, ANSI dashboard
```

## MCP Tools

| Tool | Purpose |
|------|---------|
| `cascade_init` | Start a new research cascade |
| `store_plan` | Lock immutable research plan (prevents HARKing) |
| `store_finding` | Ingest finding through 6-signal trust pipeline |
| `get_findings` | Query findings (full-text search + filters) |
| `add_entity` | Add entity to knowledge graph |
| `add_link` | Add relationship between entities |
| `query_graph` | Traverse graph (recursive CTE, ≤3 hops, bidirectional) |
| `store_hypothesis` | Track hypothesis with affinity scoring |
| `get_hypotheses` | Query hypothesis population |
| `get_status` | Cascade state + auto-apply pending steers |
| `update_status` | Advance phase/round, update PID state |
| `get_metrics` | Quality dashboard (coverage, depth, confidence, graph stats) |
| `store_checkpoint` | Step-level crash recovery |
| `steer` | Redirect active research (narrow/broaden/add question) |
| `record_metric` | Track metric values over time |

## Trust Scoring

Every finding passes through a 4-stage ingestion pipeline before entering the knowledge base:

1. **Sanitize** — Strip zero-width characters, control codes, normalize whitespace
2. **Score** — 6 orthogonal signals weighted to a composite 0–1:
   - Source reputation (known-good domains: arxiv, github, nature → 0.8)
   - Cross-corroboration (overlap with existing findings)
   - Instruction detection (regex rules for prompt injection patterns)
   - Semantic anomaly
   - Temporal consistency
   - GRADE evidence assessment (primary/secondary/tertiary source grading)
3. **Classify** — Novel-vs-malicious: novel + precise + trusted = contested novelty (quarantine for review). Novel + vague + untrusted = reject.
4. **Admit/Quarantine/Reject** — ≥0.7 auto-admit, 0.3–0.7 quarantine, <0.3 reject

## Self-Regulation

The cascade auto-adjusts research intensity using a PID controller:

- **Error signal**: coverage gap + low confidence + contradictions + depth gap
- **Proportional**: immediate response to knowledge gaps
- **Integral**: breaks out of chronic stagnation (anti-windup capped)
- **Derivative**: dampens sudden contradictory information

**Lyapunov stability detection** monitors convergence:
- ΔV < 0 → converging (continue)
- ΔV alternating → oscillating (reduce Kp by 0.7×)
- ΔV all positive → diverging (emergency synthesis)

**Kalman filter** fuses confidence from multiple noisy sources — unreliable sources (high R) are auto-discounted.

## Dogfood Results

First cascade: *"How do SQLite extensions go from idea to production adoption?"*

| Metric | R0 | R1 | R2 | R3 |
|--------|----|----|----|----|
| Findings | 10 | 19 | 26 | 31 |
| Entities | 16 | 26 | 33 | 37 |
| Edges | 15 | 28 | 41 | 48 |
| Avg degree | 1.88 | 2.15 | 2.48 | 2.59 |
| Coverage | 0.55 | 0.75 | 0.85 | 0.90 |
| Confidence | 0.87 | 0.87 | 0.88 | 0.88 |
| PID error | — | — | 0.21 | 0.13 |
| Hypotheses | 3 | 5 | 7 | 8 |

**Key outcome:** The cascade discovered four distinct adoption paths for SQLite extensions (amalgamation, language-native wrapping, standard mandate, vendor bundling) plus a platform symbiosis multiplier. Started with 1 hypothesis ("amalgamation is the only path"), refined through 4 generations, ended with that hypothesis **refuted** and a richer model **supported** by 9 cited findings.

**Engine validation:**
- Trust scoring discriminated source quality (primary 0.90 vs tertiary 0.40)
- 1 quarantine event — correctly caught a low-grade synthesis claim
- PID converged (error 0.21→0.13, derivative negative throughout)
- Graph crossed percolation threshold at Round 1
- Stopping condition triggered at the correct moment

## Benchmarks

| Operation | 10K edges | 100K edges |
|-----------|-----------|------------|
| Graph traversal (≤3 hops) | 21.6ms | 160ms |
| Structural entropy | 20.7ms | — |
| Hub detection | 5.1ms | — |

78 tests passing across 11 test suites. PID math hand-verified against computed expected values.

## Configuration

Database location (default `~/.cascade-engine/knowledge.db`):
```bash
export CASCADE_DB_PATH=/path/to/custom/knowledge.db
```

MCP server registration (`.mcp.json` in project root):
```json
{
  "mcpServers": {
    "cascade-engine": {
      "command": "node",
      "args": ["servers/cascade-engine/dist/index.js"]
    }
  }
}
```

## Requirements

- Node.js ≥22 LTS
- Python 3 + igraph (optional, for community detection: `pip install igraph`)

## Specs

- [`spec/MASTER_SPEC.md`](spec/MASTER_SPEC.md) — Full architecture with schemas, algorithms, implementation order
- [`spec/Research Cascade Memory Plan.md`](spec/Research%20Cascade%20Memory%20Plan.md) — Complete research record (11 prompts, cross-model synthesis)
- [`CLAUDE.md`](CLAUDE.md) — Project conventions for AI-assisted development

## License

MIT
