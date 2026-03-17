#!/usr/bin/env node
/**
 * Research Cascade MCP Server
 *
 * Stdio-based MCP server providing 12+ tools for progressive research
 * with knowledge graph, trust scoring, and self-regulation.
 *
 * NEVER console.log() — corrupts stdio JSON-RPC. Use console.error() only.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getDb, closeDb, generateId, contentHash, withTransaction } from './db/index.js';
import { ingestFinding } from './trust/ingestion.js';
import { consolidateRound } from './memory/consolidation.js';
import { checkInterventions, formatInterventions } from './hitl/interventions.js';
import { renderDashboard, buildDashboardData } from './hitl/dashboard.js';
import { createNote, linkNotes, extractNotesFromFinding, updateMaturity, getNoteStats, searchNotes } from './graph/amem.js';

const server = new McpServer({
  name: 'cascade-engine',
  version: '0.1.0',
});

// ============================================================
// TOOL 1: store_plan — Save immutable research plan
// ============================================================
server.tool(
  'store_plan',
  'Save an immutable research plan for a cascade. Locks questions and criteria at round start to prevent HARKing.',
  {
    cascade_id: z.string().describe('Cascade ID to attach the plan to'),
    plan: z.object({
      questions: z.array(z.string()).describe('Research questions to investigate'),
      success_criteria: z.array(z.string()).describe('How we know when we have a good answer'),
      scope_boundaries: z.array(z.string()).optional().describe('What is explicitly out of scope'),
      max_rounds: z.number().optional().default(5),
      token_budget: z.number().optional().default(500000),
    }).describe('The research plan to lock in'),
  },
  async ({ cascade_id, plan }) => {
    const db = getDb();

    // Check if cascade exists
    const existing = db.prepare('SELECT id, plan_json FROM cascades WHERE id = ?').get(cascade_id) as any;
    if (existing?.plan_json) {
      return { content: [{ type: 'text' as const, text: `Error: Plan already locked for cascade ${cascade_id}. Plans are immutable to prevent HARKing.` }] };
    }

    const planJson = JSON.stringify(plan);

    if (existing) {
      db.prepare('UPDATE cascades SET plan_json = ?, max_rounds = ?, token_budget = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(planJson, plan.max_rounds, plan.token_budget, cascade_id);
    } else {
      db.prepare('INSERT INTO cascades (id, question, plan_json, max_rounds, token_budget) VALUES (?, ?, ?, ?, ?)')
        .run(cascade_id, plan.questions[0] || 'Unnamed cascade', planJson, plan.max_rounds, plan.token_budget);
    }

    return {
      content: [{ type: 'text' as const, text: `Plan locked for cascade ${cascade_id}. ${plan.questions.length} questions, max ${plan.max_rounds} rounds, ${plan.token_budget} token budget.` }],
    };
  }
);

// ============================================================
// TOOL 2: store_finding — Ingest finding with trust scoring
// ============================================================
server.tool(
  'store_finding',
  'Store a research finding. Generates content-addressable ID. Trust scoring applied automatically.',
  {
    cascade_id: z.string(),
    thread_id: z.string().optional(),
    claim: z.string().describe('The factual claim or finding'),
    evidence: z.string().optional().describe('Supporting evidence or context'),
    source_url: z.string().optional(),
    source_type: z.enum(['primary', 'secondary', 'tertiary']).optional(),
    confidence: z.number().min(0).max(1).optional().default(0.5),
    cascade_round: z.number(),
  },
  async ({ cascade_id, thread_id, claim, evidence, source_url, source_type, confidence, cascade_round }) => {
    // Route through full trust scoring pipeline
    const result = ingestFinding(
      cascade_id, claim, evidence, source_url, source_type,
      confidence, cascade_round, thread_id,
    );

    const statusIcon = result.action === 'admitted' ? 'ADMITTED' :
      result.action === 'quarantined' ? 'QUARANTINED' : 'REJECTED';

    return {
      content: [{ type: 'text' as const, text: `Finding ${result.findingId}: ${statusIcon} (trust: ${result.trustScore.toFixed(3)}, confidence: ${confidence})\nSignals: source=${result.signals.sourceReputation.toFixed(2)} corroboration=${result.signals.crossCorroboration.toFixed(2)} instruction=${result.signals.instructionScore.toFixed(2)} grade=${result.signals.gradeAssessment.toFixed(2)}\nReason: ${result.reason}` }],
    };
  }
);

// ============================================================
// TOOL 3: get_findings — Query findings (FTS + filters)
// ============================================================
server.tool(
  'get_findings',
  'Query stored findings using full-text search and/or filters.',
  {
    cascade_id: z.string().optional(),
    query: z.string().optional().describe('FTS search query'),
    min_confidence: z.number().min(0).max(1).optional(),
    include_quarantined: z.boolean().optional().default(false),
    round: z.number().optional(),
    limit: z.number().optional().default(20),
  },
  async ({ cascade_id, query, min_confidence, include_quarantined, round, limit }) => {
    const db = getDb();
    const params: any[] = [];
    let sql: string;

    if (query) {
      sql = `SELECT f.id, f.claim, f.evidence, f.source_url, f.confidence, f.trust_composite,
              f.grade_level, f.quarantined, f.cascade_round, f.created_at
             FROM findings f
             JOIN findings_fts fts ON f.rowid = fts.rowid
             WHERE findings_fts MATCH ?`;
      params.push(query);
    } else {
      sql = `SELECT id, claim, evidence, source_url, confidence, trust_composite,
              grade_level, quarantined, cascade_round, created_at
             FROM findings WHERE 1=1`;
    }

    if (cascade_id) { sql += ' AND cascade_id = ?'; params.push(cascade_id); }
    if (min_confidence !== undefined) { sql += ' AND confidence >= ?'; params.push(min_confidence); }
    if (!include_quarantined) { sql += ' AND quarantined = 0'; }
    if (round !== undefined) { sql += ' AND cascade_round = ?'; params.push(round); }

    sql += ' ORDER BY confidence DESC LIMIT ?';
    params.push(limit);

    const findings = db.prepare(sql).all(...params);

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(findings, null, 2) }],
    };
  }
);

// ============================================================
// TOOL 4: add_entity — Add KG entity
// ============================================================
server.tool(
  'add_entity',
  'Add an entity to the knowledge graph. Upserts on (name, entity_type).',
  {
    name: z.string(),
    entity_type: z.string().describe('e.g., concept, person, tool, technique, paper'),
    properties: z.record(z.any()).optional().default({}),
    tier: z.enum(['peripheral', 'working', 'core']).optional().default('working'),
    importance: z.number().min(0).max(1).optional().default(0.5),
  },
  async ({ name, entity_type, properties, tier, importance }) => {
    const db = getDb();
    const propsJson = JSON.stringify(properties);

    const result = db.prepare(`INSERT INTO kg_entities (name, entity_type, properties, tier, importance)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name, entity_type) DO UPDATE SET
        properties = json_patch(properties, ?),
        importance = MAX(importance, ?),
        last_accessed = datetime('now')`)
      .run(name, entity_type, propsJson, tier, importance, propsJson, importance);

    const entity = db.prepare('SELECT id FROM kg_entities WHERE name = ? AND entity_type = ?')
      .get(name, entity_type) as any;

    return {
      content: [{ type: 'text' as const, text: `Entity ${entity.id}: "${name}" (${entity_type}, tier: ${tier})` }],
    };
  }
);

// ============================================================
// TOOL 5: add_link — Add KG edge
// ============================================================
server.tool(
  'add_link',
  'Add a directional link between two knowledge graph entities.',
  {
    source_name: z.string(),
    source_type: z.string(),
    target_name: z.string(),
    target_type: z.string(),
    relation_type: z.string().describe('e.g., relates_to, causes, contradicts, supports, uses, part_of'),
    weight: z.number().min(0).max(1).optional().default(1.0),
    properties: z.record(z.any()).optional().default({}),
  },
  async ({ source_name, source_type, target_name, target_type, relation_type, weight, properties }) => {
    const db = getDb();

    const source = db.prepare('SELECT id FROM kg_entities WHERE name = ? AND entity_type = ?')
      .get(source_name, source_type) as any;
    const target = db.prepare('SELECT id FROM kg_entities WHERE name = ? AND entity_type = ?')
      .get(target_name, target_type) as any;

    if (!source) return { content: [{ type: 'text' as const, text: `Error: Source entity "${source_name}" (${source_type}) not found. Add it first.` }] };
    if (!target) return { content: [{ type: 'text' as const, text: `Error: Target entity "${target_name}" (${target_type}) not found. Add it first.` }] };

    db.prepare(`INSERT INTO kg_edges (source_id, target_id, relation_type, weight, properties)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_id, target_id, relation_type) DO UPDATE SET
        weight = MAX(weight, ?),
        activation_count = activation_count + 1,
        last_activated = datetime('now')`)
      .run(source.id, target.id, relation_type, weight, JSON.stringify(properties), weight);

    return {
      content: [{ type: 'text' as const, text: `Link: "${source_name}" -[${relation_type}]-> "${target_name}" (weight: ${weight})` }],
    };
  }
);

// ============================================================
// TOOL 6: query_graph — Recursive CTE traversal (≤3 hops)
// ============================================================
server.tool(
  'query_graph',
  'Traverse the knowledge graph from a starting entity. Uses recursive CTE, bounded to 3 hops max. Follows edges in both directions by default.',
  {
    start_name: z.string(),
    start_type: z.string(),
    max_hops: z.number().min(1).max(3).optional().default(2),
    direction: z.enum(['outgoing', 'incoming', 'both']).optional().default('both').describe('Edge direction to follow'),
    relation_filter: z.string().optional().describe('Filter edges by relation type'),
    min_weight: z.number().min(0).max(1).optional().default(0.0),
  },
  async ({ start_name, start_type, max_hops, direction, relation_filter, min_weight }) => {
    const db = getDb();

    const start = db.prepare('SELECT id FROM kg_entities WHERE name = ? AND entity_type = ?')
      .get(start_name, start_type) as any;
    if (!start) return { content: [{ type: 'text' as const, text: `Entity "${start_name}" (${start_type}) not found.` }] };

    let relationClause = '';
    if (relation_filter) {
      relationClause = `AND e.relation_type = '${relation_filter.replace(/'/g, "''")}'`;
    }

    // Build directional join clauses
    let edgeJoins: string;
    if (direction === 'outgoing') {
      edgeJoins = `
        SELECT e.target_id, t.depth + 1,
          t.path || ' -[' || e.relation_type || ']-> ' || tgt.name,
          t.visited || ',' || CAST(e.target_id AS TEXT)
        FROM traverse t
        JOIN kg_edges e ON e.source_id = t.entity_id
        JOIN kg_entities tgt ON tgt.id = e.target_id
        WHERE t.depth < ${max_hops} AND e.weight >= ${min_weight}
          AND t.visited NOT LIKE '%,' || CAST(e.target_id AS TEXT) || ',%'
          ${relationClause}`;
    } else if (direction === 'incoming') {
      edgeJoins = `
        SELECT e.source_id, t.depth + 1,
          t.path || ' <-[' || e.relation_type || ']- ' || src.name,
          t.visited || ',' || CAST(e.source_id AS TEXT)
        FROM traverse t
        JOIN kg_edges e ON e.target_id = t.entity_id
        JOIN kg_entities src ON src.id = e.source_id
        WHERE t.depth < ${max_hops} AND e.weight >= ${min_weight}
          AND t.visited NOT LIKE '%,' || CAST(e.source_id AS TEXT) || ',%'
          ${relationClause}`;
    } else {
      // both directions
      edgeJoins = `
        SELECT e.target_id, t.depth + 1,
          t.path || ' -[' || e.relation_type || ']-> ' || tgt.name,
          t.visited || ',' || CAST(e.target_id AS TEXT)
        FROM traverse t
        JOIN kg_edges e ON e.source_id = t.entity_id
        JOIN kg_entities tgt ON tgt.id = e.target_id
        WHERE t.depth < ${max_hops} AND e.weight >= ${min_weight}
          AND t.visited NOT LIKE '%,' || CAST(e.target_id AS TEXT) || ',%'
          ${relationClause}
        UNION ALL
        SELECT e.source_id, t.depth + 1,
          t.path || ' <-[' || e.relation_type || ']- ' || src.name,
          t.visited || ',' || CAST(e.source_id AS TEXT)
        FROM traverse t
        JOIN kg_edges e ON e.target_id = t.entity_id
        JOIN kg_entities src ON src.id = e.source_id
        WHERE t.depth < ${max_hops} AND e.weight >= ${min_weight}
          AND t.visited NOT LIKE '%,' || CAST(e.source_id AS TEXT) || ',%'
          ${relationClause}`;
    }

    const sql = `
      WITH RECURSIVE traverse(entity_id, depth, path, visited) AS (
        SELECT ${start.id}, 0, '${start_name.replace(/'/g, "''")}', ',${start.id},'
        UNION ALL
        ${edgeJoins}
      )
      SELECT DISTINCT
        ent.id, ent.name, ent.entity_type, ent.tier,
        ent.community_id, ent.betweenness, ent.importance,
        t.depth, t.path
      FROM traverse t
      JOIN kg_entities ent ON ent.id = t.entity_id
      WHERE t.depth > 0
      ORDER BY t.depth, ent.importance DESC`;

    const results = db.prepare(sql).all();

    // Update activation counts for traversed edges
    db.prepare(`UPDATE kg_edges SET activation_count = activation_count + 1, last_activated = datetime('now')
      WHERE source_id = ? OR target_id = ?`).run(start.id, start.id);

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
    };
  }
);

// ============================================================
// TOOL 7: store_hypothesis — Add/update hypothesis
// ============================================================
server.tool(
  'store_hypothesis',
  'Store or update a research hypothesis in the cascade.',
  {
    cascade_id: z.string(),
    statement: z.string(),
    parent_id: z.string().optional(),
    affinity: z.number().min(0).max(1).optional().default(0.5),
    status: z.enum(['proposed', 'testing', 'supported', 'refuted', 'uncertain', 'archived']).optional().default('proposed'),
    supporting_ids: z.array(z.string()).optional().default([]),
    contradicting_ids: z.array(z.string()).optional().default([]),
  },
  async ({ cascade_id, statement, parent_id, affinity, status, supporting_ids, contradicting_ids }) => {
    const db = getDb();
    const id = contentHash(statement);

    const existing = db.prepare('SELECT id FROM hypotheses WHERE id = ?').get(id) as any;

    if (existing) {
      // Merge new IDs into existing arrays (flat, no nesting)
      const current = db.prepare('SELECT supporting, contradicting FROM hypotheses WHERE id = ?').get(id) as any;
      const existingSupporting: string[] = JSON.parse(current.supporting || '[]');
      const existingContradicting: string[] = JSON.parse(current.contradicting || '[]');

      const mergedSupporting = [...new Set([...existingSupporting, ...supporting_ids])];
      const mergedContradicting = [...new Set([...existingContradicting, ...contradicting_ids])];

      db.prepare(`UPDATE hypotheses SET
        affinity = ?, status = ?,
        supporting = ?,
        contradicting = ?,
        updated_at = datetime('now')
        WHERE id = ?`)
        .run(affinity, status, JSON.stringify(mergedSupporting), JSON.stringify(mergedContradicting), id);
    } else {
      const generation = parent_id
        ? ((db.prepare('SELECT generation FROM hypotheses WHERE id = ?').get(parent_id) as any)?.generation ?? 0) + 1
        : 0;

      db.prepare(`INSERT INTO hypotheses (id, cascade_id, statement, parent_id, affinity, generation, status, supporting, contradicting)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, cascade_id, statement, parent_id, affinity, generation, status, JSON.stringify(supporting_ids), JSON.stringify(contradicting_ids));
    }

    return {
      content: [{ type: 'text' as const, text: `Hypothesis ${id}: "${statement.slice(0, 80)}..." (affinity: ${affinity}, status: ${status})` }],
    };
  }
);

// ============================================================
// TOOL 8: get_hypotheses — Query hypothesis population
// ============================================================
server.tool(
  'get_hypotheses',
  'Query hypotheses for a cascade, optionally filtered by status.',
  {
    cascade_id: z.string(),
    status: z.enum(['proposed', 'testing', 'supported', 'refuted', 'uncertain', 'archived']).optional(),
    min_affinity: z.number().min(0).max(1).optional(),
  },
  async ({ cascade_id, status, min_affinity }) => {
    const db = getDb();
    let sql = 'SELECT * FROM hypotheses WHERE cascade_id = ?';
    const params: any[] = [cascade_id];

    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (min_affinity !== undefined) { sql += ' AND affinity >= ?'; params.push(min_affinity); }

    sql += ' ORDER BY affinity DESC';
    const results = db.prepare(sql).all(...params);

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
    };
  }
);

// ============================================================
// TOOL 9: cascade_init — Initialize a new research cascade
// ============================================================
server.tool(
  'cascade_init',
  'Initialize a new research cascade with a question. Returns cascade ID.',
  {
    question: z.string().describe('The research question to investigate'),
    max_rounds: z.number().optional().default(5),
    token_budget: z.number().optional().default(500000),
  },
  async ({ question, max_rounds, token_budget }) => {
    const db = getDb();
    const id = generateId();

    db.prepare(`INSERT INTO cascades (id, question, status, max_rounds, token_budget)
      VALUES (?, ?, 'planning', ?, ?)`)
      .run(id, question, max_rounds, token_budget);

    return {
      content: [{ type: 'text' as const, text: `Cascade initialized: ${id}\nQuestion: ${question}\nMax rounds: ${max_rounds}\nToken budget: ${token_budget}\n\nNext: store_plan to lock research criteria, then update_status to begin.` }],
    };
  }
);

// ============================================================
// TOOL 10: get_status — Cascade state + metrics
// ============================================================
server.tool(
  'get_status',
  'Get current cascade status including progress, findings count, hypothesis count, and PID state.',
  {
    cascade_id: z.string().optional().describe('Specific cascade ID, or omit for all active cascades'),
  },
  async ({ cascade_id }) => {
    const db = getDb();

    if (cascade_id) {
      const cascade = db.prepare('SELECT * FROM cascades WHERE id = ?').get(cascade_id) as any;
      if (!cascade) return { content: [{ type: 'text' as const, text: `Cascade ${cascade_id} not found.` }] };

      const findingsCount = (db.prepare('SELECT COUNT(*) as n FROM findings WHERE cascade_id = ?').get(cascade_id) as any).n;
      const quarantinedCount = (db.prepare('SELECT COUNT(*) as n FROM findings WHERE cascade_id = ? AND quarantined = 1').get(cascade_id) as any).n;
      const hypothesesCount = (db.prepare('SELECT COUNT(*) as n FROM hypotheses WHERE cascade_id = ?').get(cascade_id) as any).n;
      const threadsCount = (db.prepare('SELECT COUNT(*) as n FROM threads WHERE cascade_id = ?').get(cascade_id) as any).n;
      const entityCount = (db.prepare('SELECT COUNT(*) as n FROM kg_entities').get() as any).n;
      const edgeCount = (db.prepare('SELECT COUNT(*) as n FROM kg_edges').get() as any).n;

      // Auto-apply pending steer events
      const pendingSteers = db.prepare('SELECT * FROM steer_events WHERE cascade_id = ? AND applied = 0 ORDER BY created_at').all(cascade_id) as any[];
      const appliedSteers: string[] = [];
      for (const steer of pendingSteers) {
        db.prepare('UPDATE steer_events SET applied = 1 WHERE id = ?').run(steer.id);
        appliedSteers.push(`[${steer.event_type}] ${steer.instruction}`);
      }

      // --- Phase 7 activation: check interventions ---
      const interventions = checkInterventions(cascade_id);
      const blockingInterventions = interventions.filter(i => i.level === 'blocking');
      const advisoryInterventions = interventions.filter(i => i.level === 'advisory');

      // Note stats
      const noteCount = (db.prepare('SELECT COUNT(*) as n FROM atomic_notes WHERE cascade_id = ?').get(cascade_id) as any)?.n || 0;

      const status = {
        ...cascade,
        pid_state: cascade.pid_state_json ? JSON.parse(cascade.pid_state_json) : null,
        plan: cascade.plan_json ? JSON.parse(cascade.plan_json) : null,
        counts: { findings: findingsCount, quarantined: quarantinedCount, hypotheses: hypothesesCount, threads: threadsCount, entities: entityCount, edges: edgeCount, notes: noteCount },
        applied_steers: appliedSteers.length > 0 ? appliedSteers : undefined,
        interventions: blockingInterventions.length > 0
          ? { blocking: blockingInterventions.map(i => i.description), advisory: advisoryInterventions.map(i => i.description) }
          : advisoryInterventions.length > 0
            ? { advisory: advisoryInterventions.map(i => i.description) }
            : undefined,
        exploration_budget: Math.max(0, 1 - cascade.current_round / cascade.max_rounds),
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }] };
    }

    // All active cascades
    const cascades = db.prepare("SELECT id, question, status, current_round, max_rounds, created_at FROM cascades WHERE status NOT IN ('complete') ORDER BY updated_at DESC").all();
    return { content: [{ type: 'text' as const, text: JSON.stringify(cascades, null, 2) }] };
  }
);

// ============================================================
// TOOL 11: update_status — Advance phase/round
// ============================================================
server.tool(
  'update_status',
  'Update cascade status and/or advance to next round.',
  {
    cascade_id: z.string(),
    status: z.enum(['planning', 'investigating', 'validating', 'synthesizing', 'complete', 'stalled']).optional(),
    advance_round: z.boolean().optional().default(false).describe('Increment current_round by 1'),
    pid_state: z.object({
      error: z.number(),
      integral: z.number(),
      derivative: z.number(),
      output: z.number(),
      kp: z.number().optional(),
      ki: z.number().optional(),
      kd: z.number().optional(),
    }).optional(),
    tokens_used: z.number().optional().describe('Add to running token count'),
  },
  async ({ cascade_id, status, advance_round, pid_state, tokens_used }) => {
    const db = getDb();

    const cascade = db.prepare('SELECT * FROM cascades WHERE id = ?').get(cascade_id) as any;
    if (!cascade) return { content: [{ type: 'text' as const, text: `Cascade ${cascade_id} not found.` }] };

    const updates: string[] = ["updated_at = datetime('now')"];
    const params: any[] = [];

    if (status) { updates.push('status = ?'); params.push(status); }
    if (advance_round) {
      const newRound = cascade.current_round + 1;
      updates.push('current_round = ?');
      params.push(newRound);
      updates.push('exploration_budget = ?');
      params.push(Math.max(0, 1 - newRound / cascade.max_rounds));
    }
    if (pid_state) {
      updates.push('pid_state_json = ?');
      params.push(JSON.stringify(pid_state));
    }
    if (tokens_used) {
      updates.push('tokens_used = tokens_used + ?');
      params.push(tokens_used);
    }

    params.push(cascade_id);
    db.prepare(`UPDATE cascades SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    // --- Phase 6 activation: run consolidation when advancing rounds ---
    let consolidationReport: string | undefined;
    if (advance_round) {
      try {
        const result = consolidateRound(cascade_id, cascade.current_round);
        // Extract notes from this round's findings
        const roundFindings = db.prepare('SELECT id FROM findings WHERE cascade_id = ? AND cascade_round = ? AND quarantined = 0')
          .all(cascade_id, cascade.current_round) as any[];
        let notesCreated = 0;
        for (const f of roundFindings) {
          const noteIds = extractNotesFromFinding(f.id, cascade_id, cascade.current_round);
          notesCreated += noteIds.length;
        }
        // Update note maturity
        const maturityResult = updateMaturity();

        consolidationReport = `Consolidation: dedup ${result.deduped.removed} removed, ${result.tierChanges.promoted} promoted, ${result.tierChanges.demoted} demoted, ${result.pruned.archived} pruned, ${result.scheduled} scheduled for SM-2. ${notesCreated} notes created, ${maturityResult.promoted} matured. (${result.durationMs}ms)`;
      } catch (err: any) {
        consolidationReport = `Consolidation error: ${err.message}`;
      }
    }

    const updated = db.prepare('SELECT id, status, current_round, max_rounds, tokens_used, token_budget FROM cascades WHERE id = ?').get(cascade_id) as any;
    const response: any = { ...updated };
    if (consolidationReport) response.consolidation = consolidationReport;

    return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] };
  }
);

// ============================================================
// TOOL 12: get_metrics — Information-theoretic dashboard
// ============================================================
server.tool(
  'get_metrics',
  'Get cascade quality metrics: coverage, depth, confidence distribution, source diversity.',
  {
    cascade_id: z.string(),
  },
  async ({ cascade_id }) => {
    const db = getDb();

    const cascade = db.prepare('SELECT * FROM cascades WHERE id = ?').get(cascade_id) as any;
    if (!cascade) return { content: [{ type: 'text' as const, text: `Cascade ${cascade_id} not found.` }] };

    // Aggregate metrics
    const findings = db.prepare('SELECT confidence, trust_composite, source_url, grade_level, cascade_round FROM findings WHERE cascade_id = ? AND quarantined = 0').all(cascade_id) as any[];

    const avgConfidence = findings.length ? findings.reduce((s: number, f: any) => s + f.confidence, 0) / findings.length : 0;
    const avgTrust = findings.length ? findings.reduce((s: number, f: any) => s + (f.trust_composite || 0.5), 0) / findings.length : 0;

    // Source diversity
    const domains = new Set(findings.map((f: any) => {
      try { return new URL(f.source_url || '').hostname; } catch { return 'unknown'; }
    }));

    // Confidence distribution
    const confBuckets = { high: 0, medium: 0, low: 0 };
    for (const f of findings) {
      if (f.confidence >= 0.7) confBuckets.high++;
      else if (f.confidence >= 0.4) confBuckets.medium++;
      else confBuckets.low++;
    }

    // Grade distribution
    const gradeDist: Record<string, number> = {};
    for (const f of findings) {
      const g = f.grade_level || 'ungraded';
      gradeDist[g] = (gradeDist[g] || 0) + 1;
    }

    // Hypotheses status
    const hypStats = db.prepare(`SELECT status, COUNT(*) as n FROM hypotheses WHERE cascade_id = ? GROUP BY status`).all(cascade_id);

    // Graph stats
    const entityCount = (db.prepare('SELECT COUNT(*) as n FROM kg_entities').get() as any).n;
    const edgeCount = (db.prepare('SELECT COUNT(*) as n FROM kg_edges').get() as any).n;
    const avgDegree = entityCount > 0 ? (2 * edgeCount) / entityCount : 0;

    // Recent metrics from metrics table
    const recentMetrics = db.prepare(`SELECT metric_name, metric_value, recorded_at FROM metrics
      WHERE cascade_id = ? ORDER BY recorded_at DESC LIMIT 20`).all(cascade_id);

    // Note stats
    const noteStats = getNoteStats();

    // Consolidation history
    const lastConsolidation = db.prepare(`SELECT * FROM consolidation_log
      WHERE cascade_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(cascade_id) as any;

    // SM-2 review stats
    const sm2Due = (db.prepare("SELECT COUNT(*) as n FROM sm2_schedule WHERE next_review <= datetime('now')").get() as any).n;

    const dashboard = {
      cascade: { id: cascade_id, status: cascade.status, round: cascade.current_round, maxRounds: cascade.max_rounds },
      quality: {
        totalFindings: findings.length,
        avgConfidence: Math.round(avgConfidence * 1000) / 1000,
        avgTrust: Math.round(avgTrust * 1000) / 1000,
        confidenceDistribution: confBuckets,
        gradeDistribution: gradeDist,
        sourceDiversity: domains.size,
      },
      hypotheses: hypStats,
      graph: { entities: entityCount, edges: edgeCount, avgDegree: Math.round(avgDegree * 100) / 100 },
      notes: noteStats,
      memory: {
        lastConsolidation: lastConsolidation ? {
          promoted: lastConsolidation.items_promoted,
          demoted: lastConsolidation.items_demoted,
          pruned: lastConsolidation.items_pruned,
          durationMs: lastConsolidation.duration_ms,
        } : null,
        sm2ItemsDue: sm2Due,
      },
      tokens: { used: cascade.tokens_used, budget: cascade.token_budget, remaining: cascade.token_budget - cascade.tokens_used },
      explorationBudget: Math.max(0, 1 - cascade.current_round / cascade.max_rounds),
      recentMetrics,
    };

    // --- Phase 7 activation: render ANSI dashboard to stderr ---
    const dashData = buildDashboardData(cascade_id);
    if (dashData) {
      console.error(renderDashboard(dashData));
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify(dashboard, null, 2) }] };
  }
);

// ============================================================
// TOOL 13: store_checkpoint — Step-level checkpointing
// ============================================================
server.tool(
  'store_checkpoint',
  'Save a checkpoint for crash recovery. Each step is checkpointed independently.',
  {
    task_id: z.string(),
    round_index: z.number(),
    step_index: z.number(),
    step_name: z.string(),
    status: z.enum(['pending', 'running', 'done', 'failed', 'skipped']),
    state_snapshot: z.string().optional().describe('JSON state to restore from'),
    error_message: z.string().optional(),
  },
  async ({ task_id, round_index, step_index, step_name, status, state_snapshot, error_message }) => {
    const db = getDb();
    const idempotencyKey = `${task_id}:${round_index}:${step_index}:${step_name}`;

    db.prepare(`INSERT INTO cascade_checkpoints (task_id, round_index, step_index, step_name, status, state_snapshot, idempotency_key, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, round_index, step_index) DO UPDATE SET
        status = excluded.status,
        state_snapshot = COALESCE(excluded.state_snapshot, state_snapshot),
        error_message = excluded.error_message,
        completed_at = CASE WHEN excluded.status IN ('done','failed','skipped') THEN datetime('now') ELSE NULL END`)
      .run(task_id, round_index, step_index, step_name, status, state_snapshot, idempotencyKey, error_message);

    return {
      content: [{ type: 'text' as const, text: `Checkpoint: ${task_id} R${round_index}S${step_index} "${step_name}" → ${status}` }],
    };
  }
);

// ============================================================
// TOOL 14: steer — Submit human steering event
// ============================================================
server.tool(
  'steer',
  'Submit a steering event to redirect an active cascade.',
  {
    cascade_id: z.string(),
    event_type: z.enum(['redirect', 'narrow', 'broaden', 'add_question', 'drop_hypothesis', 'approve', 'reject']),
    instruction: z.string(),
    target_id: z.string().optional().describe('ID of hypothesis or finding to target'),
  },
  async ({ cascade_id, event_type, instruction, target_id }) => {
    const db = getDb();

    db.prepare('INSERT INTO steer_events (cascade_id, event_type, instruction, target_id) VALUES (?, ?, ?, ?)')
      .run(cascade_id, event_type, instruction, target_id);

    return {
      content: [{ type: 'text' as const, text: `Steer event queued: ${event_type} — "${instruction}". Will be applied on next cascade iteration.` }],
    };
  }
);

// ============================================================
// TOOL 15: record_metric — Store a metric value
// ============================================================
server.tool(
  'record_metric',
  'Record a metric value for tracking cascade health over time.',
  {
    cascade_id: z.string(),
    round_index: z.number().optional(),
    metric_name: z.string().describe('e.g., entropy, coverage, confidence_avg, pid_error, ncd_dedup_ratio'),
    metric_value: z.number(),
  },
  async ({ cascade_id, round_index, metric_name, metric_value }) => {
    const db = getDb();
    db.prepare('INSERT INTO metrics (cascade_id, round_index, metric_name, metric_value) VALUES (?, ?, ?, ?)')
      .run(cascade_id, round_index, metric_name, metric_value);

    return {
      content: [{ type: 'text' as const, text: `Metric recorded: ${metric_name} = ${metric_value}` }],
    };
  }
);

// ============================================================
// TOOL 16: create_note — A-MEM atomic note creation
// ============================================================
server.tool(
  'create_note',
  'Create an atomic Zettelkasten note from an insight. Auto-links to related notes by keyword overlap. Content-addressable (idempotent).',
  {
    content: z.string().describe('The atomic insight or observation'),
    note_type: z.enum(['insight', 'connection', 'question', 'contradiction', 'synthesis']).optional().default('insight'),
    keywords: z.array(z.string()).optional().default([]),
    source_finding_id: z.string().optional(),
    cascade_id: z.string().optional(),
    cascade_round: z.number().optional(),
  },
  async ({ content, note_type, keywords, source_finding_id, cascade_id, cascade_round }) => {
    const noteId = createNote(content, note_type, keywords, source_finding_id, undefined, cascade_id, cascade_round);

    // Auto-link to related notes
    if (cascade_id) {
      const db = getDb();
      const existing = db.prepare(`SELECT id, content FROM atomic_notes WHERE id != ? AND cascade_id = ? LIMIT 50`)
        .all(noteId, cascade_id) as any[];

      let linksCreated = 0;
      const contentWords = new Set(content.toLowerCase().split(/\s+/).filter(w => w.length > 5));
      for (const other of existing) {
        const otherWords = new Set(other.content.toLowerCase().split(/\s+/).filter((w: string) => w.length > 5));
        let overlap = 0;
        for (const w of contentWords) { if (otherWords.has(w)) overlap++; }
        if (overlap >= 2) {
          linkNotes(noteId, other.id, 'relates_to', Math.min(1.0, overlap * 0.2));
          linksCreated++;
        }
      }

      return {
        content: [{ type: 'text' as const, text: `Note ${noteId}: "${content.slice(0, 60)}..." (${note_type}, ${linksCreated} auto-links)` }],
      };
    }

    return {
      content: [{ type: 'text' as const, text: `Note ${noteId}: "${content.slice(0, 60)}..." (${note_type})` }],
    };
  }
);

// ============================================================
// TOOL 17: search_notes — Search Zettelkasten notes
// ============================================================
server.tool(
  'search_notes',
  'Search atomic notes by keyword. Returns notes sorted by access frequency.',
  {
    keyword: z.string(),
    limit: z.number().optional().default(10),
  },
  async ({ keyword, limit }) => {
    const notes = searchNotes(keyword, limit);
    return { content: [{ type: 'text' as const, text: JSON.stringify(notes, null, 2) }] };
  }
);

// ============================================================
// Server startup
// ============================================================
export async function startServer(): Promise<void> {
  // Initialize DB on startup to catch schema errors early
  try {
    getDb();
    console.error('[cascade-engine] Database initialized');
  } catch (err) {
    console.error('[cascade-engine] DB initialization failed:', err);
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[cascade-engine] MCP server running on stdio');
}

// Direct execution (node dist/index.js)
const isDirectRun = process.argv[1]?.endsWith('index.js');
if (isDirectRun) {
  startServer().catch((err) => {
    console.error('[cascade-engine] Fatal:', err);
    closeDb();
    process.exit(1);
  });
}

export default startServer;
