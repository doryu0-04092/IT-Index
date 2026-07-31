const PREFIX = 'it-index-hint-seen:';

/** 機能ごとの段階的オンボーディング（プログレッシブオンボーディング）を既に見たかどうか */
export function hasSeenHint(key: string): boolean {
  return localStorage.getItem(PREFIX + key) === '1';
}

export function markHintSeen(key: string): void {
  localStorage.setItem(PREFIX + key, '1');
}
