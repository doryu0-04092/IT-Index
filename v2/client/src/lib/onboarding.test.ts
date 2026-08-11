import { afterEach, describe, expect, it } from 'vitest';
import { hasSeenOnboarding, markOnboardingSeen } from './onboarding';

describe('onboarding', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('初回は未読(false)、既読マーク後はtrueになる', () => {
    expect(hasSeenOnboarding()).toBe(false);
    markOnboardingSeen();
    expect(hasSeenOnboarding()).toBe(true);
  });
});
