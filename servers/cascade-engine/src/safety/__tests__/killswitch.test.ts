import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { isHalted, halt, resume, haltFilePath } from '../killswitch.js';

const sentinel = join(tmpdir(), `cascade-halt-test-${process.pid}`);

describe('kill-switch (AFR-20)', () => {
  beforeEach(() => {
    process.env.CASCADE_HALT_FILE = sentinel;
    delete process.env.CASCADE_HALT;
    if (existsSync(sentinel)) rmSync(sentinel);
  });
  afterEach(() => {
    delete process.env.CASCADE_HALT_FILE;
    delete process.env.CASCADE_HALT;
    if (existsSync(sentinel)) rmSync(sentinel);
  });

  it('is not halted by default', () => {
    expect(haltFilePath()).toBe(sentinel);
    expect(isHalted().halted).toBe(false);
  });

  it('halt() writes a sentinel that isHalted() reports, with the reason', () => {
    halt('scheduled maintenance');
    expect(existsSync(sentinel)).toBe(true);
    const s = isHalted();
    expect(s.halted).toBe(true);
    expect(s.reason).toContain('scheduled maintenance');
  });

  it('resume() clears the sentinel and is idempotent', () => {
    halt('x');
    expect(resume()).toBe(true);
    expect(isHalted().halted).toBe(false);
    expect(resume()).toBe(false);
  });

  it('env CASCADE_HALT halts without touching disk', () => {
    process.env.CASCADE_HALT = '1';
    expect(isHalted().halted).toBe(true);
    process.env.CASCADE_HALT = '0';
    expect(isHalted().halted).toBe(false);
  });
});
