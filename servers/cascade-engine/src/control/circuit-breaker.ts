/**
 * Circuit breaker (AFR-17 / AFR-21) — dependency-free.
 *
 * The spec (MASTER_SPEC "Cockatiel resilience stack", memory plan `circuitBreaker(3)`)
 * promised this and it was never implemented. This is the real thing, with no
 * external dependency: after `threshold` consecutive failures the breaker opens
 * and `allow()` returns false, pausing the caller automatically before a human
 * reacts. After `cooldownMs` it half-opens to admit a single trial; a success
 * closes it, a failure re-opens it.
 *
 * Time is injectable so the cooldown is deterministically testable.
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private _state: BreakerState = 'closed';

  constructor(
    private readonly threshold = 3,
    private readonly cooldownMs = 60_000,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** Current state, accounting for cooldown expiry (open → half-open). */
  state(): BreakerState {
    if (this._state === 'open' && this.clock() - this.openedAt >= this.cooldownMs) {
      this._state = 'half-open';
    }
    return this._state;
  }

  /** Whether a call is permitted right now. */
  allow(): boolean {
    return this.state() !== 'open';
  }

  recordSuccess(): void {
    this.failures = 0;
    this._state = 'closed';
  }

  recordFailure(): void {
    // A failure while testing the water re-opens immediately.
    if (this.state() === 'half-open') {
      this.trip();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.trip();
    }
  }

  private trip(): void {
    this._state = 'open';
    this.openedAt = this.clock();
  }

  get consecutiveFailures(): number {
    return this.failures;
  }
}
