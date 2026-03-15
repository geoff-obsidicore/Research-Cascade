/**
 * Lyapunov Stability Detection
 *
 * Monitors cascade convergence by tracking a Lyapunov-like function:
 * V(t) = weighted sum of error metrics
 *
 * ΔV < 0 → converging (good)
 * ΔV alternating signs → oscillating (reduce Kp by 0.7×)
 * ΔV all positive → diverging (emergency synthesis)
 */

export type StabilityState = 'converging' | 'oscillating' | 'diverging' | 'insufficient_data';

export interface StabilityAnalysis {
  state: StabilityState;
  lyapunovValues: number[];
  deltas: number[];
  trend: number;
  recommendation: string;
}

/**
 * Compute Lyapunov-like function from error components.
 * V(t) = Σ wᵢ × eᵢ²  (quadratic form — always non-negative)
 */
export function computeLyapunov(errors: {
  coverageGap: number;
  lowConfidence: number;
  contradictions: number;
  depthGap: number;
}): number {
  return (
    0.3 * errors.coverageGap ** 2 +
    0.3 * errors.lowConfidence ** 2 +
    0.2 * errors.contradictions ** 2 +
    0.2 * errors.depthGap ** 2
  );
}

/**
 * Analyze stability from a sequence of Lyapunov values.
 * Requires at least 3 data points.
 */
export function analyzeStability(lyapunovHistory: number[]): StabilityAnalysis {
  if (lyapunovHistory.length < 3) {
    return {
      state: 'insufficient_data',
      lyapunovValues: lyapunovHistory,
      deltas: [],
      trend: 0,
      recommendation: 'Need at least 3 rounds of data for stability analysis.',
    };
  }

  // Compute deltas: ΔV = V(t) - V(t-1)
  const deltas: number[] = [];
  for (let i = 1; i < lyapunovHistory.length; i++) {
    deltas.push(lyapunovHistory[i] - lyapunovHistory[i - 1]);
  }

  // Overall trend (simple linear regression slope)
  const n = deltas.length;
  const sumX = n * (n - 1) / 2;
  const sumY = deltas.reduce((s, d) => s + d, 0);
  const sumXY = deltas.reduce((s, d, i) => s + i * d, 0);
  const sumX2 = deltas.reduce((s, _, i) => s + i * i, 0);
  const trend = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX || 1);

  // Check recent deltas (last 3)
  const recent = deltas.slice(-3);
  const allNegative = recent.every(d => d < -0.001);
  const allPositive = recent.every(d => d > 0.001);
  const alternating = recent.length >= 2 &&
    recent.slice(1).every((d, i) => Math.sign(d) !== Math.sign(recent[i]));

  let state: StabilityState;
  let recommendation: string;

  if (allNegative) {
    state = 'converging';
    recommendation = 'Research is converging. Continue current strategy.';
  } else if (allPositive) {
    state = 'diverging';
    recommendation = 'DIVERGING — errors growing. Trigger emergency synthesis. Reduce scope, increase validation.';
  } else if (alternating) {
    state = 'oscillating';
    recommendation = 'OSCILLATING — reduce Kp by 0.7×. The cascade is flip-flopping between states.';
  } else {
    // Mixed signals — use trend
    if (trend < -0.01) {
      state = 'converging';
      recommendation = 'Generally converging despite some noise. Continue.';
    } else if (trend > 0.01) {
      state = 'diverging';
      recommendation = 'Trending toward divergence. Consider narrowing scope.';
    } else {
      state = 'converging'; // Flat = stable
      recommendation = 'Stable plateau. May be approaching saturation — check stopping gates.';
    }
  }

  return {
    state,
    lyapunovValues: lyapunovHistory,
    deltas,
    trend,
    recommendation,
  };
}

/**
 * Check if the cascade has reached a convergence criterion.
 * Uses both Lyapunov stability AND absolute error threshold.
 */
export function hasConverged(
  lyapunovHistory: number[],
  absoluteThreshold: number = 0.05,
): { converged: boolean; reason: string } {
  if (lyapunovHistory.length === 0) {
    return { converged: false, reason: 'No data' };
  }

  const latest = lyapunovHistory[lyapunovHistory.length - 1];

  // Absolute convergence: V(t) below threshold
  if (latest < absoluteThreshold) {
    return { converged: true, reason: `Lyapunov V(t)=${latest.toFixed(4)} < threshold ${absoluteThreshold}` };
  }

  // Rate convergence: ΔV approaching zero
  if (lyapunovHistory.length >= 3) {
    const recentDeltas = [];
    for (let i = lyapunovHistory.length - 3; i < lyapunovHistory.length; i++) {
      if (i > 0) recentDeltas.push(Math.abs(lyapunovHistory[i] - lyapunovHistory[i - 1]));
    }
    const avgDelta = recentDeltas.reduce((s, d) => s + d, 0) / recentDeltas.length;

    if (avgDelta < 0.005) {
      return { converged: true, reason: `Average ΔV=${avgDelta.toFixed(5)} — compression progress exhausted` };
    }
  }

  return { converged: false, reason: `V(t)=${latest.toFixed(4)}, still above threshold` };
}
