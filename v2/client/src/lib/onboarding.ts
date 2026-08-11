const STORAGE_KEY = 'it-index-v2-onboarding-seen';

/** 初回起動時のオンボーディングを既に見たかどうか(移植元: ../../../src/ui/onboarding.ts) */
export function hasSeenOnboarding(): boolean {
  return localStorage.getItem(STORAGE_KEY) === '1';
}

export function markOnboardingSeen(): void {
  localStorage.setItem(STORAGE_KEY, '1');
}
