/**
 * PID Math Manual Verification
 *
 * Spec warns: "Claude Code generates ~1.75x more logic errors — manually verify PID math"
 *
 * These tests use hand-computed expected values to verify the PID formulas are correct.
 * If any test fails, the PID implementation has a math error.
 */

import { describe, it, expect } from 'vitest';
import { createPIDState, computeError, updatePID, autoTuneKp } from '../pid.js';
import { fuseConfidence, kalmanUpdate, createKalmanState } from '../kalman.js';
import { computeLyapunov } from '../stability.js';

describe('PID Math Verification (hand-computed)', () => {

  it('error = 0.3*coverage + 0.3*confidence + 0.2*contradictions + 0.2*depth', () => {
    // Hand-computed: 0.3*0.5 + 0.3*0.4 + 0.2*0.3 + 0.2*0.6
    // = 0.15 + 0.12 + 0.06 + 0.12 = 0.45
    const error = computeError({ coverageGap: 0.5, lowConfidence: 0.4, contradictions: 0.3, depthGap: 0.6 });
    expect(error).toBeCloseTo(0.45, 10);
  });

  it('first PID update: P=Kp*e, I=Ki*e, D=Kd*(e-0), output=clamp(P+I+D)', () => {
    const state = createPIDState(1.0, 0.1, 0.5); // Kp=1, Ki=0.1, Kd=0.5
    const error = 0.6;

    // Hand-computed:
    // P = 1.0 * 0.6 = 0.6
    // I = 0.1 * 0.6 = 0.06 (integral starts at 0, now = 0+0.6=0.6, Ki*0.6=0.06)
    // D = 0.5 * (0.6 - 0) = 0.3 (prevError was 0)
    // output = clamp(0.6 + 0.06 + 0.3, 0, 1) = clamp(0.96, 0, 1) = 0.96
    updatePID(state, error);

    expect(state.error).toBeCloseTo(0.6, 10);
    expect(state.integral).toBeCloseTo(0.6, 10);
    expect(state.derivative).toBeCloseTo(0.6, 10); // 0.6 - 0 = 0.6
    expect(state.output).toBeCloseTo(0.96, 10);
  });

  it('second PID update: derivative uses previous error', () => {
    const state = createPIDState(1.0, 0.1, 0.5);

    // First update with error = 0.6
    updatePID(state, 0.6);
    // Second update with error = 0.4
    // P = 1.0 * 0.4 = 0.4
    // integral = 0.6 + 0.4 = 1.0, I = 0.1 * 1.0 = 0.1
    // D = 0.5 * (0.4 - 0.6) = 0.5 * (-0.2) = -0.1
    // output = clamp(0.4 + 0.1 + (-0.1), 0, 1) = clamp(0.4, 0, 1) = 0.4
    updatePID(state, 0.4);

    expect(state.integral).toBeCloseTo(1.0, 10);
    expect(state.derivative).toBeCloseTo(-0.2, 10); // 0.4 - 0.6
    expect(state.output).toBeCloseTo(0.4, 10);
  });

  it('anti-windup caps integral at integralMax', () => {
    const state = createPIDState(0, 1.0, 0); // Only Ki
    state.integralMax = 1.5;

    // Feed large errors to blow up integral
    updatePID(state, 1.0); // integral = 1.0
    updatePID(state, 1.0); // integral would be 2.0, capped to 1.5
    expect(state.integral).toBeCloseTo(1.5, 10);

    // Negative capping
    updatePID(state, -5.0); // integral = 1.5 + (-5) = -3.5, capped to -1.5
    expect(state.integral).toBeCloseTo(-1.5, 10);
  });

  it('output is always clamped to [0, 1]', () => {
    const state = createPIDState(10, 0, 0); // Very high Kp
    updatePID(state, 1.0);
    expect(state.output).toBe(1); // P = 10*1 = 10, clamped to 1

    updatePID(state, -1.0);
    expect(state.output).toBe(0); // P = 10*(-1) = -10, clamped to 0
  });
});

describe('Kalman Math Verification (hand-computed)', () => {

  it('K = P/(P+R), estimate += K*(measurement - estimate)', () => {
    // P=1.0, R=0.5
    // K = 1.0 / (1.0 + 0.5) = 1/1.5 ≈ 0.6667
    // estimate = 0.5 + 0.6667 * (0.8 - 0.5) = 0.5 + 0.6667*0.3 = 0.5 + 0.2 = 0.7
    // uncertainty = (1 - 0.6667) * 1.0 ≈ 0.3333
    const state = createKalmanState(0.5, 1.0);
    const updated = kalmanUpdate(state, 0.8, 0.5);

    expect(updated.estimate).toBeCloseTo(0.7, 3);
    expect(updated.uncertainty).toBeCloseTo(1/3, 3);
  });

  it('high noise source (R=10) barely moves estimate', () => {
    // P=0.1, R=10
    // K = 0.1 / (0.1 + 10) = 0.1/10.1 ≈ 0.0099
    // estimate = 0.5 + 0.0099 * (0.9 - 0.5) ≈ 0.5 + 0.004 ≈ 0.504
    const state = createKalmanState(0.5, 0.1);
    const updated = kalmanUpdate(state, 0.9, 10);

    expect(updated.estimate).toBeCloseTo(0.504, 2);
  });

  it('multiple measurements converge to true value', () => {
    // 5 measurements of 0.8 with noise 0.2
    // Should converge toward 0.8
    const result = fuseConfidence([
      { value: 0.8, noise: 0.2 },
      { value: 0.8, noise: 0.2 },
      { value: 0.8, noise: 0.2 },
      { value: 0.8, noise: 0.2 },
      { value: 0.8, noise: 0.2 },
    ], 0.5, 1.0);

    expect(result.estimate).toBeCloseTo(0.8, 1);
    expect(result.uncertainty).toBeLessThan(0.1);
  });
});

describe('Lyapunov Math Verification (hand-computed)', () => {

  it('V = 0.3*cov² + 0.3*conf² + 0.2*contra² + 0.2*depth²', () => {
    // V = 0.3*(0.5)² + 0.3*(0.4)² + 0.2*(0.3)² + 0.2*(0.6)²
    // = 0.3*0.25 + 0.3*0.16 + 0.2*0.09 + 0.2*0.36
    // = 0.075 + 0.048 + 0.018 + 0.072
    // = 0.213
    const V = computeLyapunov({ coverageGap: 0.5, lowConfidence: 0.4, contradictions: 0.3, depthGap: 0.6 });
    expect(V).toBeCloseTo(0.213, 10);
  });

  it('V = 0 when all errors are 0', () => {
    const V = computeLyapunov({ coverageGap: 0, lowConfidence: 0, contradictions: 0, depthGap: 0 });
    expect(V).toBe(0);
  });

  it('V = 1.0 when all errors are 1', () => {
    // V = 0.3*1 + 0.3*1 + 0.2*1 + 0.2*1 = 1.0
    const V = computeLyapunov({ coverageGap: 1, lowConfidence: 1, contradictions: 1, depthGap: 1 });
    expect(V).toBeCloseTo(1.0, 10);
  });
});
