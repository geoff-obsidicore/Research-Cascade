import { describe, it, expect } from 'vitest';
import { steerConsequence, steerAutoApplies, toolConsequence, TOOL_CONSEQUENCE } from '../policy.js';

describe('consequence policy (AFR-11 / AFR-12 / AFR-14)', () => {
  it('classifies destructive steers as high, benign steers as low', () => {
    expect(steerConsequence('reject')).toBe('high');
    expect(steerConsequence('redirect')).toBe('high');
    expect(steerConsequence('drop_hypothesis')).toBe('high');
    expect(steerConsequence('narrow')).toBe('low');
    expect(steerConsequence('broaden')).toBe('low');
    expect(steerConsequence('approve')).toBe('low');
  });

  it('only low-consequence steers auto-apply; high ones need approval', () => {
    expect(steerAutoApplies('narrow')).toBe(true);
    expect(steerAutoApplies('approve')).toBe(true);
    expect(steerAutoApplies('reject')).toBe(false);
    expect(steerAutoApplies('redirect')).toBe(false);
  });

  it('unknown types default-deny — treated as high and never auto-applied (AFR-14)', () => {
    expect(steerConsequence('nonsense')).toBe('high');
    expect(steerAutoApplies('nonsense')).toBe(false);
    expect(toolConsequence('made_up_tool')).toBe('high');
  });

  it('the engine has no critical-tier actions (no shell/network/spend)', () => {
    const tiers = new Set(Object.values(TOOL_CONSEQUENCE));
    expect(tiers.has('critical')).toBe(false);
  });
});
