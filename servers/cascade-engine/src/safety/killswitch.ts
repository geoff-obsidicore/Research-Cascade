/**
 * Kill-switch (AFR-20) — a human can halt the engine immediately.
 *
 * Two triggers, checked before every tool call:
 *   1. env  CASCADE_HALT=1        (halts the process without touching disk)
 *   2. a HALT sentinel file next to the database (survives restarts)
 *
 * While halted, every tool returns a refusal instead of executing. The CLI
 * commands `halt` / `resume` toggle the sentinel; `abort <id>` stalls a single
 * cascade (enforced separately, per-cascade). This is deliberately dependency-
 * free and file-based so it works even if the process is wedged and can be
 * triggered by anything that can touch the filesystem.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface HaltState {
  halted: boolean;
  reason?: string;
}

/** Location of the HALT sentinel: CASCADE_HALT_FILE, else next to the DB. */
export function haltFilePath(): string {
  const explicit = process.env.CASCADE_HALT_FILE;
  if (explicit) return explicit;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dbPath = process.env.CASCADE_DB_PATH || join(home, '.cascade-engine', 'knowledge.db');
  return join(dirname(dbPath), 'HALT');
}

export function isHalted(): HaltState {
  const env = process.env.CASCADE_HALT;
  if (env && env !== '0' && env.toLowerCase() !== 'false') {
    return { halted: true, reason: `env CASCADE_HALT=${env}` };
  }
  const f = haltFilePath();
  if (existsSync(f)) {
    let reason = 'HALT sentinel present';
    try {
      const t = readFileSync(f, 'utf-8').trim();
      if (t) reason = t;
    } catch {
      /* unreadable sentinel still halts */
    }
    return { halted: true, reason };
  }
  return { halted: false };
}

/** Engage the kill-switch. Returns the sentinel path written. */
export function halt(reason = 'manual halt'): string {
  const f = haltFilePath();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `${reason}\n`, 'utf-8');
  return f;
}

/** Release the kill-switch. Returns true if a sentinel was removed. */
export function resume(): boolean {
  const f = haltFilePath();
  if (existsSync(f)) {
    unlinkSync(f);
    return true;
  }
  return false;
}
