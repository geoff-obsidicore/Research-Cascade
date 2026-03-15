/**
 * Kalman Filter — Confidence fusion from multiple noisy sources
 *
 * K = P / (P + R)
 * confidence += K × (measurement - confidence)
 * uncertainty = (1 - K) × P
 *
 * High R (unreliable source) → low K → measurement discounted
 * High P (uncertain claim) → high K → updated aggressively
 */

export interface KalmanState {
  estimate: number;     // Current confidence estimate
  uncertainty: number;  // P — estimation uncertainty
}

/**
 * Create initial Kalman state for a new finding.
 */
export function createKalmanState(
  initialEstimate: number = 0.5,
  initialUncertainty: number = 1.0,
): KalmanState {
  return {
    estimate: initialEstimate,
    uncertainty: initialUncertainty,
  };
}

/**
 * Update Kalman estimate with a new measurement.
 *
 * @param state Current Kalman state
 * @param measurement New confidence measurement (0-1)
 * @param measurementNoise R — noise of the measurement source (higher = less reliable)
 * @returns Updated state
 */
export function kalmanUpdate(
  state: KalmanState,
  measurement: number,
  measurementNoise: number,
): KalmanState {
  // Kalman gain
  const K = state.uncertainty / (state.uncertainty + measurementNoise);

  // Update estimate
  const newEstimate = state.estimate + K * (measurement - state.estimate);

  // Update uncertainty
  const newUncertainty = (1 - K) * state.uncertainty;

  return {
    estimate: Math.max(0, Math.min(1, newEstimate)),
    uncertainty: newUncertainty,
  };
}

/**
 * Fuse multiple measurements at once.
 * Each measurement has its own noise level based on source reliability.
 */
export function fuseConfidence(
  measurements: { value: number; noise: number }[],
  initialEstimate: number = 0.5,
  initialUncertainty: number = 1.0,
): KalmanState {
  let state = createKalmanState(initialEstimate, initialUncertainty);

  for (const m of measurements) {
    state = kalmanUpdate(state, m.value, m.noise);
  }

  return state;
}

/**
 * Map source type to measurement noise.
 * Lower noise = more trusted source.
 */
export function sourceToNoise(sourceType: string | undefined, trustScore: number): number {
  const baseNoise: Record<string, number> = {
    primary: 0.1,     // Peer-reviewed → very reliable
    secondary: 0.3,   // Blogs, tutorials
    tertiary: 0.6,    // Forums, social media
  };

  const base = baseNoise[sourceType || ''] ?? 0.5;

  // Modulate by trust score — low trust = higher noise
  return base * (2 - trustScore); // Range: base*1 to base*2
}

/**
 * Batch update: apply multiple findings' confidence to a single claim.
 * Returns the fused confidence and remaining uncertainty.
 */
export function batchFuseForClaim(
  existingConfidence: number,
  existingUncertainty: number,
  newMeasurements: { confidence: number; sourceType?: string; trustScore: number }[],
): { confidence: number; uncertainty: number } {
  let state: KalmanState = {
    estimate: existingConfidence,
    uncertainty: existingUncertainty,
  };

  for (const m of newMeasurements) {
    const noise = sourceToNoise(m.sourceType, m.trustScore);
    state = kalmanUpdate(state, m.confidence, noise);
  }

  return {
    confidence: state.estimate,
    uncertainty: state.uncertainty,
  };
}
