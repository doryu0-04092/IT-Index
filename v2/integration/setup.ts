import 'fake-indexeddb/auto';

/**
 * workerd には `localStorage` が無い。クライアント側はトークン・接続先サーバー・
 * 同期の鍵の保管に `localStorage` を使うため、最小の代替を置く
 * (`fake-indexeddb` と同じ「ブラウザAPIのテスト用代替」)。
 *
 * 実装を変えずに実サーバー相手へ向けられることが本テストの前提なので、
 * ここで足すのは保管先だけにとどめ、アプリ側のコードには一切手を入れない。
 */
class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

(globalThis as unknown as { localStorage: Storage }).localStorage = new MemoryStorage();
