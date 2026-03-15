import { describe, it, expect } from 'vitest';
import { computeLyapunov, analyzeStability, hasConverged } from '../stability.js';

describe('Lyapunov Stability Detection', () => {
  it('should compute Lyapunov from error components', () => {
    const V = computeLyapunov({
      coverageGap: 0,
      lowConfidence: 0,
      contradictions: 0,
      depthGap: 0,
    });
    expect(V).toBe(0);
  });

  it('should increase with larger errors', () => {
    const V1 = computeLyapunov({ coverageGap: 0.2, lowConfidence: 0.2, contradictions: 0.2, depthGap: 0.2 });
    const V2 = computeLyapunov({ coverageGap: 0.8, lowConfidence: 0.8, contradictions: 0.8, depthGap: 0.8 });
    expect(V2).toBeGreaterThan(V1);
  });

  it('should detect convergence (decreasing V)', () => {
    const result = analyzeStability([0.8, 0.6, 0.4, 0.2, 0.1]);
    expect(result.state).toBe('converging');
    expect(result.deltas.every(d => d < 0)).toBe(true);
  });

  it('should detect divergence (increasing V)', () => {
    const result = analyzeStability([0.1, 0.2, 0.4, 0.6, 0.8]);
    expect(result.state).toBe('diverging');
  });

  it('should detect oscillation (alternating V)', () => {
    const result = analyzeStability([0.3, 0.6, 0.3, 0.6, 0.3]);
    expect(result.state).toBe('oscillating');
  });

  it('should require minimum 3 data points', () => {
    const result = analyzeStability([0.5, 0.4]);
    expect(result.state).toBe('insufficient_data');
  });

  it('should detect absolute convergence', () => {
    const result = hasConverged([0.1, 0.05, 0.02], 0.05);
    expect(result.converged).toBe(true);
  });

  it('should detect rate convergence (plateau)', () => {
    const result = hasConverged([0.3, 0.299, 0.2985, 0.298], 0.01);
    expect(result.converged).toBe(true);
  });

  it('should not converge when V is high', () => {
    const result = hasConverged([0.8, 0.7, 0.6]);
    expect(result.converged).toBe(false);
  });
});
