#!/usr/bin/env node
/**
 * cascade-engine CLI
 *
 * Usage:
 *   cascade-engine serve          Start MCP stdio server (default)
 *   cascade-engine status         Show active cascades and DB stats
 *   cascade-engine status <id>    Show detailed cascade status
 *   cascade-engine graph          Show knowledge graph stats
 *   cascade-engine notes          Show Zettelkasten note stats
 *   cascade-engine reset          Delete the database and start fresh
 *   cascade-engine db-path        Print the database file path
 *   cascade-engine help           Show this help
 *
 * Environment:
 *   CASCADE_DB_PATH   Override database location (default: ~/.cascade-engine/knowledge.db)
 */

import { getDb, closeDb } from './db/index.js';
import { getGraphStats } from './graph/entities.js';
import { getNoteStats } from './graph/amem.js';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const command = args[0] || 'serve';

async function main(): Promise<void> {
  switch (command) {
    case 'serve':
    case 'start': {
      // Dynamic import to avoid loading the full MCP server for other commands
      const { default: startServer } = await import('./server.js');
      await startServer();
      break;
    }

    case 'status': {
      const db = getDb();
      const cascadeId = args[1];

      if (cascadeId) {
        const cascade = db.prepare('SELECT * FROM cascades WHERE id = ? OR id LIKE ?')
          .get(cascadeId, `${cascadeId}%`) as any;
        if (!cascade) {
          console.log(`Cascade "${cascadeId}" not found.`);
          break;
        }

        const findings = (db.prepare('SELECT COUNT(*) as n FROM findings WHERE cascade_id = ? AND quarantined = 0').get(cascade.id) as any).n;
        const quarantined = (db.prepare('SELECT COUNT(*) as n FROM findings WHERE cascade_id = ? AND quarantined = 1').get(cascade.id) as any).n;
        const hypotheses = (db.prepare('SELECT COUNT(*) as n FROM hypotheses WHERE cascade_id = ?').get(cascade.id) as any).n;

        console.log(`Cascade: ${cascade.id}`);
        console.log(`Question: ${cascade.question}`);
        console.log(`Status: ${cascade.status}`);
        console.log(`Round: ${cascade.current_round}/${cascade.max_rounds}`);
        console.log(`Findings: ${findings} (${quarantined} quarantined)`);
        console.log(`Hypotheses: ${hypotheses}`);
        console.log(`Tokens: ${cascade.tokens_used}/${cascade.token_budget}`);
        console.log(`Created: ${cascade.created_at}`);
      } else {
        const cascades = db.prepare("SELECT id, question, status, current_round, max_rounds, created_at FROM cascades ORDER BY updated_at DESC").all() as any[];

        if (cascades.length === 0) {
          console.log('No cascades found. Start one with cascade_init.');
        } else {
          console.log(`${cascades.length} cascade(s):\n`);
          for (const c of cascades) {
            console.log(`  ${c.id.slice(0, 8)}  ${c.status.padEnd(13)} R${c.current_round}/${c.max_rounds}  ${c.question.slice(0, 60)}`);
          }
        }

        const findings = (db.prepare('SELECT COUNT(*) as n FROM findings').get() as any).n;
        const entities = (db.prepare('SELECT COUNT(*) as n FROM kg_entities').get() as any).n;
        const edges = (db.prepare('SELECT COUNT(*) as n FROM kg_edges').get() as any).n;
        console.log(`\nDB totals: ${findings} findings, ${entities} entities, ${edges} edges`);
      }
      closeDb();
      break;
    }

    case 'graph': {
      const stats = getGraphStats();
      console.log('Knowledge Graph:');
      console.log(`  Entities: ${stats.entityCount}`);
      console.log(`  Edges: ${stats.edgeCount}`);
      console.log(`  Avg degree: ${stats.avgDegree.toFixed(2)}`);
      console.log(`  Communities: ${stats.communityCounts}`);
      console.log(`  Orphans: ${stats.orphanCount}`);
      console.log(`  Tiers: ${JSON.stringify(stats.tierCounts)}`);
      closeDb();
      break;
    }

    case 'notes': {
      const stats = getNoteStats();
      console.log('Zettelkasten Notes:');
      console.log(`  Total: ${stats.totalNotes}`);
      console.log(`  Links: ${stats.totalLinks}`);
      console.log(`  Orphans: ${stats.orphanCount}`);
      console.log(`  Maturity: ${JSON.stringify(stats.maturityCounts)}`);
      console.log(`  Types: ${JSON.stringify(stats.typeCounts)}`);
      closeDb();
      break;
    }

    case 'db-path': {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      const dbPath = process.env.CASCADE_DB_PATH || join(home, '.cascade-engine', 'knowledge.db');
      console.log(dbPath);
      break;
    }

    case 'reset': {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      const dbPath = process.env.CASCADE_DB_PATH || join(home, '.cascade-engine', 'knowledge.db');
      if (existsSync(dbPath)) {
        unlinkSync(dbPath);
        // Clean up WAL and SHM files
        if (existsSync(dbPath + '-wal')) unlinkSync(dbPath + '-wal');
        if (existsSync(dbPath + '-shm')) unlinkSync(dbPath + '-shm');
        console.log(`Deleted: ${dbPath}`);
      } else {
        console.log('No database found.');
      }
      break;
    }

    case 'help':
    case '--help':
    case '-h': {
      console.log(`cascade-engine — Progressive deep research MCP server

Usage:
  cascade-engine serve          Start MCP stdio server (default)
  cascade-engine status         Show active cascades and DB stats
  cascade-engine status <id>    Detailed cascade status
  cascade-engine graph          Knowledge graph statistics
  cascade-engine notes          Zettelkasten note statistics
  cascade-engine db-path        Print database file path
  cascade-engine reset          Delete database and start fresh
  cascade-engine help           Show this help

MCP Integration:
  Add to your .mcp.json (Claude Code) or equivalent:

  {
    "mcpServers": {
      "cascade-engine": {
        "command": "cascade-engine",
        "args": ["serve"]
      }
    }
  }

Environment:
  CASCADE_DB_PATH   Override database location
                    Default: ~/.cascade-engine/knowledge.db

More info: https://github.com/geoff-obsidicore/Research-Cascade`);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "cascade-engine help" for usage.');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
