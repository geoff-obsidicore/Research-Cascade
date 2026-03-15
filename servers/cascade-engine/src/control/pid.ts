/**
 * PID Controller — Self-regulation for research cascade
 *
 * Maps control theory to research strategy:
 * - Kp (Proportional): Immediate response to knowledge gaps
 * - Ki (Integral): Breaks out of chronic stagnation loops
 * - Kd (Derivative): Dampens sudden contradictory information
 *
 * Anti-windup cap on integral. Lyapunov stability detection.
 *
 * Error signal components:
 *   error = coverage_gap*0.3 + low_confidence*0.3 + contradictions*0.2 + depth_gap*0.2
 *
 * Output maps to: {searchBreadth, searchDepth, explorationRate}
 */

export interface PIDState {
  kp: number;
  ki: number;
  kd: number;
  error: number;
  prevError: number;
  integral: number;
  derivative: number;
  output: number;
  integralMax: number; // Anti-windup cap
  history: number[];   // Error history for Lyapunov
}

export interface PIDOutput {
  searchBreadth: number;  // 0-1: how many new threads to open
  searchDepth: number;    // 0-1: how deep to go in each thread
  explorationRate: number; // 0-1: exploration vs exploitation bias
}

export interface ErrorComponents {
  coverageGap: number;    // 0-1: what fraction of questions lack findings
  lowConfidence: number;  // 0-1: fraction of findings below confidence threshold
  contradictions: number; // 0-1: fraction of contradicting edges vs total
  depthGap: number;       // 0-1: how far from target depth
}

/**
 * Create initial PID state with tuned defaults.
 */
export function createPIDState(
  kp: number = 1.2,
  ki: number = 0.05,
  kd: number = 0.1,
): PIDState {
  return {
    kp, ki, kd,
    error: 0,
    prevError: 0,
    integral: 0,
    derivative: 0,
    output: 0.5, // Start neutral
    integralMax: 2.0,
    history: [],
  };
}

/**
 * Compute composite error from research state.
 */
export function computeError(components: ErrorComponents): number {
  return (
    components.coverageGap * 0.3 +
    components.lowConfidence * 0.3 +
    components.contradictions * 0.2 +
    components.depthGap * 0.2
  );
}

/**
 * Update PID controller with new error measurement.
 * Returns control output and updated state.
 */
export function updatePID(state: PIDState, error: number): PIDOutput {
  // Proportional
  const P = state.kp * error;

  // Integral with anti-windup
  state.integral = clamp(state.integral + error, -state.integralMax, state.integralMax);
  const I = state.ki * state.integral;

  // Derivative
  state.derivative = error - state.prevError;
  const D = state.kd * state.derivative;

  // Combined output, clamped 0-1
  state.output = clamp(P + I + D, 0, 1);
  state.prevError = state.error;
  state.error = error;
  state.history.push(error);

  // Keep history bounded
  if (state.history.length > 20) state.history.shift();

  // Map output to research parameters
  return mapOutputToStrategy(state.output);
}

/**
 * Map PID output (0-1) to concrete research strategy parameters.
 */
function mapOutputToStrategy(output: number): PIDOutput {
  return {
    searchBreadth: clamp(output * 0.8 + 0.1, 0, 1),    // 0.1-0.9 range
    searchDepth: clamp((1 - output) * 0.8 + 0.1, 0, 1), // Inverse of breadth
    explorationRate: clamp(output, 0, 1),
  };
}

/**
 * Auto-tune Kp when oscillation detected.
 * Reduces Kp by 0.7× on alternating error signs.
 */
export function autoTuneKp(state: PIDState): boolean {
  if (state.history.length < 4) return false;

  const recent = state.history.slice(-4);
  const signs = recent.map((v, i) => i > 0 ? Math.sign(v - recent[i - 1]) : 0).slice(1);

  // Check for alternating signs (oscillation)
  const isOscillating = signs.length >= 3 &&
    signs[0] !== signs[1] && signs[1] !== signs[2];

  if (isOscillating) {
    state.kp *= 0.7;
    return true;
  }

  return false;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
