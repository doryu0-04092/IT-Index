const STORAGE_KEY = 'it-index-onboarding-seen';

/** 初回起動時のオンボーディングを既に見たかどうか（テーマ設定と同様、localStorageで管理） */
export function hasSeenOnboarding(): boolean {
  return localStorage.getItem(STORAGE_KEY) === '1';
}

export function markOnboardingSeen(): void {
  localStorage.setItem(STORAGE_KEY, '1');
}
