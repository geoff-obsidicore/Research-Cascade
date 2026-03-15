import { describe, it, expect } from 'vitest';
import { createKalmanState, kalmanUpdate, fuseConfidence, sourceToNoise } from '../kalman.js';

describe('Kalman Filter', () => {
  it('should create initial state', () => {
    const state = createKalmanState(0.5, 1.0);
    expect(state.estimate).toBe(0.5);
    expect(state.uncertainty).toBe(1.0);
  });

  it('should update toward measurement with high uncertainty', () => {
    const state = createKalmanState(0.5, 1.0);
    const updated = kalmanUpdate(state, 0.9, 0.1);

    // High P, low R → K ≈ 1 → should move strongly toward measurement
    expect(updated.estimate).toBeGreaterThan(0.8);
    expect(updated.uncertainty).toBeLessThan(state.uncertainty);
  });

  it('should resist noisy measurements', () => {
    const state = createKalmanState(0.5, 0.1); // Low uncertainty
    const updated = kalmanUpdate(state, 0.9, 1.0); // High noise

    // Low P, high R → K ≈ 0 → should barely move
    expect(updated.estimate).toBeLessThan(0.6);
  });

  it('should reduce uncertainty with each measurement', () => {
    let state = createKalmanState(0.5, 1.0);

    for (let i = 0; i < 5; i++) {
      state = kalmanUpdate(state, 0.7, 0.3);
    }

    expect(state.uncertainty).toBeLessThan(0.2);
    expect(state.estimate).toBeCloseTo(0.7, 1);
  });

  it('should fuse multiple measurements', () => {
    const result = fuseConfidence([
      { value: 0.8, noise: 0.1 }, // Reliable source says 0.8
      { value: 0.7, noise: 0.3 }, // Moderate source says 0.7
      { value: 0.2, noise: 0.9 }, // Noisy source says 0.2 — should be discounted
    ]);

    // Should be closer to reliable sources
    expect(result.estimate).toBeGreaterThan(0.6);
    expect(result.uncertainty).toBeLessThan(0.5);
  });

  it('should clamp estimate to [0, 1]', () => {
    const state = createKalmanState(0.95, 0.5);
    const updated = kalmanUpdate(state, 1.5, 0.1); // Out-of-range measurement
    expect(updated.estimate).toBeLessThanOrEqual(1.0);
  });

  it('should map source types to noise correctly', () => {
    expect(sourceToNoise('primary', 1.0)).toBeCloseTo(0.1);
    expect(sourceToNoise('secondary', 1.0)).toBeCloseTo(0.3);
    expect(sourceToNoise('tertiary', 1.0)).toBeCloseTo(0.6);

    // Low trust → higher noise
    expect(sourceToNoise('primary', 0.5)).toBeGreaterThan(sourceToNoise('primary', 1.0));
  });
});
