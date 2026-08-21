import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { detectIsNativeApp } from './lib/platform';
import { runAutoPull, type AutoPullOutcome } from './sync/autoPull';

/**
 * 起動時の自動pull(#193)がプラットフォーム判定の確定を待つことを固定する(#217)。
 *
 * **なぜ別ファイルなのか。** ここでは `lib/platform` と `sync/autoPull` をモジュールごと
 * 差し替える。vitestのモジュールモックはファイル単位で効くため、App.test.tsx に混ぜると
 * 他の全テストが同じモックの下で走ってしまう。
 *
 * **なぜ実測ではないのか。** `isNativeApp`(=`@capacitor/core` の動的import)と
 * `deviceId`(=IndexedDB読み)のどちらが先に解決するかは端末とストレージの速度で決まり、
 * 実機で測っても「その時は起きなかった」以上のことは言えない。そこで**判定の解決を
 * こちらが握って遅らせる**ことで、順序を決定的に再現する。
 */
vi.mock('./lib/platform', () => ({ detectIsNativeApp: vi.fn() }));
vi.mock('./sync/autoPull', () => ({
  runAutoPull: vi.fn(),
  shouldRefreshAfterAutoPull: vi.fn(() => false),
}));

const seed = {
  schemaVersion: 1,
  version: 'test-v1',
  terms: [{ term: 'HTTP', readings: ['エイチティーティーピー'], summary: '通信規約', field: 'ネットワーク' }],
};

const skipped: AutoPullOutcome = { status: 'skipped', reason: 'not-authed' };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(seed) }));
  vi.mocked(runAutoPull).mockResolvedValue(skipped);
  // 同期の組み立てに accountId が要る(無いと syncDeps が null になり、渡した値を見られない)
  localStorage.setItem('it-index-v2:token', 'tok-1');
  localStorage.setItem('it-index-v2:account-id', 'acc-1');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
});

/** シード取り込みが終わる=settingsRepo.get()も済んでおり、deviceIdが確定している時点まで待つ */
async function waitForStartup() {
  await waitFor(() => expect(screen.getByText('登録単語数(1語)')).toBeTruthy());
}

describe('起動時の自動pullとプラットフォーム判定の順序(#217)', () => {
  /**
   * 本命。判定が遅れた場合、`holdLocalOnConflict` が未確定の false で渡ってはいけない。
   * false で走ると newest-wins マージになり、Androidのノートが noteHistory に残らないまま
   * 上書きされる(sync/syncEngine.ts / repositories/notes.ts の upsertFromSync)。
   * Androidには競合解消UIが無いため戻せない。
   */
  it('判定が deviceId より遅れて確定しても、Androidネイティブとして自動pullが走る', async () => {
    let resolveNative!: (value: boolean) => void;
    vi.mocked(detectIsNativeApp).mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveNative = resolve;
      }),
    );

    render(<App />);
    await waitForStartup();

    // 判定を握ったままなので、この時点で走っていてはいけない
    expect(runAutoPull).not.toHaveBeenCalled();

    resolveNative(true);

    await waitFor(() => expect(runAutoPull).toHaveBeenCalledTimes(1));
    expect(vi.mocked(runAutoPull).mock.calls[0][0].syncDeps?.holdLocalOnConflict).toBe(true);
  });

  /**
   * 待たせた結果として自動pullが動かなくなっていないことを固定する。
   * `detectIsNativeApp()` は読み込みに失敗しても false を返して必ず解決する契約
   * (lib/platform.ts)なので、判定が false 側で確定するこの経路が「失敗時も走る」ことの確認になる。
   */
  it('ネイティブでない場合(PC・読み込み失敗時)も、判定の確定後に自動pullが走る', async () => {
    vi.mocked(detectIsNativeApp).mockResolvedValue(false);

    render(<App />);
    await waitForStartup();

    await waitFor(() => expect(runAutoPull).toHaveBeenCalledTimes(1));
    expect(vi.mocked(runAutoPull).mock.calls[0][0].syncDeps?.holdLocalOnConflict).toBe(false);
  });

  /** 判定が確定しても、起動につき1回だけ(ref ガードの意図を壊していないこと) */
  it('自動pullは起動につき1回しか走らない', async () => {
    vi.mocked(detectIsNativeApp).mockResolvedValue(true);

    render(<App />);
    await waitForStartup();
    await waitFor(() => expect(runAutoPull).toHaveBeenCalledTimes(1));

    // 判定確定後にも再描画は起きるが、回数は増えない
    await waitFor(() => expect(screen.getByText('登録単語数(1語)')).toBeTruthy());
    expect(runAutoPull).toHaveBeenCalledTimes(1);
  });
});
