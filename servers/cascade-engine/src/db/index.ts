/**
 * SQLite database wrapper for Research Cascade knowledge store.
 * Uses synchronous better-sqlite3 (no async race conditions with JSONL state).
 * WAL mode, single writer + multiple readers.
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCHEMA_PATH = join(__dirname, '..', '..', 'src', 'db', 'schema.sql');
const SCHEMA_DIST_PATH = join(__dirname, 'schema.sql');

export interface DatabaseOptions {
  dbPath?: string;
  readonly?: boolean;
}

let _db: Database.Database | null = null;

function getDefaultDbPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dir = join(home, '.cascade-engine');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, 'knowledge.db');
}

/** For testing only — inject an in-memory DB */
export function __setTestDb(db: Database.Database | null): void {
  _db = db;
}

export function getDb(options?: DatabaseOptions): Database.Database {
  if (_db) return _db;

  const dbPath = options?.dbPath || process.env.CASCADE_DB_PATH || getDefaultDbPath();
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  _db = new Database(dbPath, {
    readonly: options?.readonly ?? false,
    fileMustExist: false,
  });

  // Critical PRAGMAs — order matters
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 10000');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('cache_size = -64000');    // 64MB
  _db.pragma('foreign_keys = ON');
  _db.pragma('temp_store = MEMORY');
  _db.pragma('mmap_size = 268435456');  // 256MB

  // Run schema migration
  migrateSchema(_db);

  // Register shutdown handler
  process.on('exit', () => closeDb());

  return _db;
}

function migrateSchema(db: Database.Database): void {
  // Try source path first (dev), then dist path (production)
  let schemaPath = SCHEMA_PATH;
  if (!existsSync(schemaPath)) {
    schemaPath = SCHEMA_DIST_PATH;
  }
  if (!existsSync(schemaPath)) {
    // Inline minimal check — schema.sql should be copied during build
    console.error('[cascade-engine] Warning: schema.sql not found, skipping migration');
    return;
  }

  const schema = readFileSync(schemaPath, 'utf-8');

  // Split on semicolons, filter empty, execute each statement
  // All CREATE statements use IF NOT EXISTS — safe to re-run
  db.exec(schema);
}

export function closeDb(): void {
  if (_db) {
    try {
      // Optimize before close
      _db.pragma('optimize');
      _db.close();
    } catch {
      // Already closed or errored — ignore
    }
    _db = null;
  }
}

/**
 * Check WAL size and run passive checkpoint if > threshold.
 * Call periodically (e.g., between cascade rounds).
 */
export function checkpointIfNeeded(thresholdMB: number = 50): void {
  const db = getDb();
  const walPath = db.name + '-wal';
  try {
    const { size } = require('node:fs').statSync(walPath);
    if (size > thresholdMB * 1024 * 1024) {
      db.pragma('wal_checkpoint(PASSIVE)');
    }
  } catch {
    // WAL file doesn't exist or can't stat — fine
  }
}

// --- Helpers for common patterns ---

/** Generate a content-addressable ID from claim text */
export function contentHash(text: string): string {
  const { createHash } = require('node:crypto');
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Generate a random UUID-like ID */
export function generateId(): string {
  const { randomBytes } = require('node:crypto');
  return randomBytes(8).toString('hex');
}

/** Begin an immediate write transaction */
export function withTransaction<T>(fn: () => T): T {
  const db = getDb();
  const transaction = db.transaction(fn);
  return transaction();
}
