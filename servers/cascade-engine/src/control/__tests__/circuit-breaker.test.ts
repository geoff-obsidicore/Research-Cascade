import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../circuit-breaker.js';

describe('CircuitBreaker (AFR-17/AFR-21)', () => {
  it('opens after threshold consecutive failures', () => {
    const cb = new CircuitBreaker(3, 60_000, () => 0);
    expect(cb.allow()).toBe(true);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state()).toBe('closed');
    cb.recordFailure(); // 3rd → trip
    expect(cb.state()).toBe('open');
    expect(cb.allow()).toBe(false);
  });

  it('a success resets the failure count', () => {
    const cb = new CircuitBreaker(3, 60_000, () => 0);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.consecutiveFailures).toBe(0);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state()).toBe('closed'); // only 2 since the reset
  });

  it('half-opens after cooldown, closes on a successful trial', () => {
    let now = 0;
    const cb = new CircuitBreaker(1, 1_000, () => now);
    cb.recordFailure(); // threshold 1 → open
    expect(cb.state()).toBe('open');
    now = 1_000; // cooldown elapsed
    expect(cb.state()).toBe('half-open');
    expect(cb.allow()).toBe(true);
    cb.recordSuccess();
    expect(cb.state()).toBe('closed');
  });

  it('re-opens if the half-open trial fails', () => {
    let now = 0;
    const cb = new CircuitBreaker(1, 1_000, () => now);
    cb.recordFailure(); // open
    now = 1_000;
    expect(cb.state()).toBe('half-open');
    cb.recordFailure(); // trial fails → re-open
    expect(cb.state()).toBe('open');
  });
});
