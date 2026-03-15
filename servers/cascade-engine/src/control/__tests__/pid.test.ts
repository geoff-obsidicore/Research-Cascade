import { describe, it, expect } from 'vitest';
import { createPIDState, computeError, updatePID, autoTuneKp } from '../pid.js';

describe('PID Controller', () => {
  it('should create initial state with defaults', () => {
    const state = createPIDState();
    expect(state.kp).toBe(1.2);
    expect(state.ki).toBe(0.05);
    expect(state.kd).toBe(0.1);
    expect(state.output).toBe(0.5);
    expect(state.integral).toBe(0);
  });

  it('should compute weighted error from components', () => {
    const error = computeError({
      coverageGap: 1.0,
      lowConfidence: 1.0,
      contradictions: 1.0,
      depthGap: 1.0,
    });
    expect(error).toBe(1.0); // All maxed = 0.3+0.3+0.2+0.2
  });

  it('should compute zero error when all metrics are satisfied', () => {
    const error = computeError({
      coverageGap: 0,
      lowConfidence: 0,
      contradictions: 0,
      depthGap: 0,
    });
    expect(error).toBe(0);
  });

  it('should increase output on high error', () => {
    const state = createPIDState();
    state.output = 0;

    const output = updatePID(state, 0.8);
    expect(output.searchBreadth).toBeGreaterThan(0.5);
    expect(output.explorationRate).toBeGreaterThan(0.5);
  });

  it('should decrease output on low error', () => {
    const state = createPIDState();
    state.output = 1.0;
    state.error = 0.8;
    state.prevError = 0.8;

    const output = updatePID(state, 0.1);
    expect(output.searchBreadth).toBeLessThan(0.5);
  });

  it('should clamp output between 0 and 1', () => {
    const state = createPIDState(10, 0, 0); // Very high Kp
    updatePID(state, 1.0);
    expect(state.output).toBeLessThanOrEqual(1);
    expect(state.output).toBeGreaterThanOrEqual(0);
  });

  it('should apply anti-windup on integral', () => {
    const state = createPIDState(0, 1.0, 0); // Only Ki
    state.integralMax = 2.0;

    // Feed many large errors
    for (let i = 0; i < 100; i++) {
      updatePID(state, 1.0);
    }

    expect(state.integral).toBeLessThanOrEqual(state.integralMax);
  });

  it('should detect oscillation and reduce Kp', () => {
    const state = createPIDState(1.2, 0, 0);
    // Simulate alternating errors (oscillation)
    state.history = [0.5, 0.3, 0.5, 0.3];

    const tuned = autoTuneKp(state);
    expect(tuned).toBe(true);
    expect(state.kp).toBeCloseTo(1.2 * 0.7);
  });

  it('should NOT reduce Kp when converging', () => {
    const state = createPIDState(1.2, 0, 0);
    state.history = [0.8, 0.6, 0.4, 0.2]; // Monotonically decreasing

    const tuned = autoTuneKp(state);
    expect(tuned).toBe(false);
    expect(state.kp).toBe(1.2);
  });

  it('should maintain history bounded to 20 entries', () => {
    const state = createPIDState();
    for (let i = 0; i < 30; i++) {
      updatePID(state, Math.random());
    }
    expect(state.history.length).toBeLessThanOrEqual(20);
  });
});
