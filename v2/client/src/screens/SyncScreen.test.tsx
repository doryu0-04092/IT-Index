import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AiClient } from '../ai/aiClient';
import { ItIndexDB } from '../db';
import { createAsksRepository } from '../repositories/asks';
import { createNoteConflictsRepository, type NoteConflict } from '../repositories/noteConflicts';
import { createNotesRepository } from '../repositories/notes';
import { createSyncEventsRepository } from '../repositories/syncEvents';
import { createSyncStateRepository } from '../repositories/syncState';
import { createTermsRepository } from '../repositories/terms';
import { ApiRequestError } from '../sync/apiClient';
import SyncScreen from './SyncScreen';

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

function fakeAiClient(overrides: Partial<AiClient> = {}): AiClient {
  return { send: vi.fn(), ...overrides };
}

function makeConflict(termId = 'term-a'): NoteConflict {
  const base = { termId, diagrams: [], noteHistory: [] };
  return {
    termId,
    local: { ...base, body: 'この端末の内容', updatedAt: 100, lastEditedBy: 'device-1' },
    remote: { ...base, body: '相手の端末の内容', updatedAt: 200, lastEditedBy: 'device-2' },
  };
}

function createSyncDeps() {
  const db = new ItIndexDB(`test-syncscreen-${Math.random()}`);
  return {
    db,
    termsRepo: createTermsRepository(db),
    notesRepo: createNotesRepository(db),
    asksRepo: createAsksRepository(db),
    noteConflictsRepo: createNoteConflictsRepository(db),
    syncEventsRepo: createSyncEventsRepository(db),
    syncStateRepo: createSyncStateRepository(db),
  };
}

/**
 * 競合を事前に仕込む(#157で画面は「最新の同期イベントに紐づく競合」だけを表示するため、
 * 同期イベントも一緒に作ってリンクさせる)。
 */
async function seedConflict(
  deps: ReturnType<typeof createSyncDeps>,
  conflict: NoteConflict,
  detectedAt = 1000,
) {
  const eventId = 'event-test';
  await deps.syncEventsRepo.put({
    id: eventId,
    at: detectedAt,
    pushedSeq: 1,
    receivedBlobs: 1,
    skippedBlobs: 0,
    conflictCount: 1,
    peerDeviceIds: ['device-2'],
    completed: true,
  });
  return deps.noteConflictsRepo.add(conflict, 'device-2', detectedAt, eventId);
}

/**
 * 競合を事前に仕込むテスト(AI統合・選び直し)は、renderより前にdb/repoを用意して
 * noteConflictsRepo.add()しておく必要があるため、depsを引数で受け取れるようにしてある。
 * 省略時は毎回新しいdbを作る(既存の単純なテストはこれで足りる)。
 */
function renderSyncScreen(
  deps: ReturnType<typeof createSyncDeps> = createSyncDeps(),
  options: {
    deviceId?: string | null;
    aiClient?: AiClient;
    onGoToSettings?: () => void;
    isNativeApp?: boolean;
    onSyncApplied?: () => void;
  } = {},
) {
  render(
    <SyncScreen
      db={deps.db}
      deviceId={options.deviceId ?? 'device-1'}
      isNativeApp={options.isNativeApp ?? false}
      termsRepo={deps.termsRepo}
      notesRepo={deps.notesRepo}
      asksRepo={deps.asksRepo}
      noteConflictsRepo={deps.noteConflictsRepo}
      syncEventsRepo={deps.syncEventsRepo}
      syncStateRepo={deps.syncStateRepo}
      aiClient={options.aiClient ?? fakeAiClient()}
      onGoToSettings={options.onGoToSettings}
      onSyncApplied={options.onSyncApplied}
    />,
  );
  return deps;
}

describe('SyncScreen', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('未ログイン時はログインフォームを表示する', async () => {
    renderSyncScreen();
    await waitFor(() => expect(screen.getByLabelText('メールアドレス')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'ログインする' })).toBeTruthy();
  });

  it('保存済みトークンが有効ならログイン済み表示に切り替わる', async () => {
    localStorage.setItem('it-index-v2:token', 'saved-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { accountId: 'acc-1', email: 'saved@example.com' })));

    renderSyncScreen();

    await waitFor(() => expect(screen.getByText(/ログイン中: saved@example.com/)).toBeTruthy());
  });

  it('保存済みトークンが無効(401)なら未ログイン表示に戻し、トークンを破棄する', async () => {
    localStorage.setItem('it-index-v2:token', 'expired-token');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(401, { error: { code: 'unauthorized', message: '認証が必要です' } })),
    );

    renderSyncScreen();

    await waitFor(() => expect(screen.getByLabelText('メールアドレス')).toBeTruthy());
    expect(localStorage.getItem('it-index-v2:token')).toBeNull();
  });

  it('確認がネットワーク断で失敗してもトークンを破棄せず、ログイン状態を保つ', async () => {
    // 要件定義書§5: サーバー停止時に止まってよいのは同期だけ。トークン破棄は401のときに限る。
    localStorage.setItem('it-index-v2:token', 'saved-token');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    renderSyncScreen();

    await waitFor(() => expect(screen.getByText(/オフライン: 次の接続時に確認します/)).toBeTruthy());
    expect(localStorage.getItem('it-index-v2:token')).toBe('saved-token');
  });

  it('ログイン成功で同期操作画面に切り替わり、失敗時はサーバーの日本語messageを表示する', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      if (url === '/api/auth/login') {
        const body = JSON.parse(init.body as string);
        if (body.password === 'wrong') {
          return Promise.resolve(
            jsonResponse(401, { error: { code: 'invalid_credentials', message: 'メールアドレスまたはパスワードが正しくありません' } }),
          );
        }
        return Promise.resolve(jsonResponse(200, { token: 'tok-1' }));
      }
      if (url === '/api/auth/me') {
        return Promise.resolve(jsonResponse(200, { accountId: 'acc-1', email: 'a@example.com' }));
      }
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSyncScreen();
    await waitFor(() => expect(screen.getByLabelText('メールアドレス')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('メールアドレス'), { target: { value: 'a@example.com' } });
    fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'ログインする' }));

    await waitFor(() => expect(screen.getByText('メールアドレスまたはパスワードが正しくありません')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: 'correct-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'ログインする' }));

    await waitFor(() => expect(screen.getByText(/ログイン中: a@example.com/)).toBeTruthy());
  });

  it('ログイン済みで「今すぐ同期」を押すとpush→pullし、結果件数を表示する', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/auth/me') return Promise.resolve(jsonResponse(200, { accountId: 'acc-1', email: 'a@example.com' }));
      if (url === '/api/sync/push') return Promise.resolve(jsonResponse(201, { seq: 1 }));
      if (url.startsWith('/api/sync/pull')) return Promise.resolve(jsonResponse(200, { blobs: [], latest: 0 }));
      throw new Error(`unexpected url: ${url}`);
    });
    localStorage.setItem('it-index-v2:token', 'tok-1');
    vi.stubGlobal('fetch', fetchMock);

    renderSyncScreen();
    await waitFor(() => expect(screen.getByText(/ログイン中: a@example.com/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '今すぐ同期' }));

    // 表示は「実際に変わった語数」(#202)。受信blobの件数ではない
    await waitFor(() => expect(screen.getByText(/変わった内容はありませんでした/)).toBeTruthy());
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/sync/push')).toBe(true);
  });

  it('ログアウトでトークンを破棄し、ログインフォームに戻る', async () => {
    localStorage.setItem('it-index-v2:token', 'tok-1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { accountId: 'acc-1', email: 'a@example.com' })));

    renderSyncScreen();
    await waitFor(() => expect(screen.getByText(/ログイン中: a@example.com/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }));

    await waitFor(() => expect(screen.getByLabelText('メールアドレス')).toBeTruthy());
    expect(localStorage.getItem('it-index-v2:token')).toBeNull();
  });

  // 設定タブ新設(PR)の回帰防止: APIキー設定(BYOK)・テーマ切替はSettingsScreen.tsxへ移設した
  // ため、同期タブにはもう出ない(個別のUIテストはApiKeySection.test.tsx・
  // SettingsScreen.test.tsxへ移した)。
  it('APIキー設定・テーマ切替のUIが無い(設定タブへ分離済み)', async () => {
    localStorage.setItem('it-index-v2:token', 'tok-1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { accountId: 'acc-1', email: 'a@example.com' })));

    renderSyncScreen();
    await waitFor(() => expect(screen.getByText(/ログイン中: a@example.com/)).toBeTruthy());

    expect(screen.queryByLabelText('APIキー')).toBeNull();
    expect(screen.queryByTestId('api-key-status')).toBeNull();
    expect(screen.queryByText('テーマ')).toBeNull();
  });

  // v1ファイル取り込みの廃止(UIレビュー反映)の回帰防止: 同期タブから
  // 「v1のファイルを取り込む」の入口(見出し・ファイル入力)が無いことを確認する。
  it('v1ファイル取り込みのUIが無い(廃止済み)', async () => {
    localStorage.setItem('it-index-v2:token', 'tok-1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { accountId: 'acc-1', email: 'a@example.com' })));

    renderSyncScreen();
    await waitFor(() => expect(screen.getByText(/ログイン中: a@example.com/)).toBeTruthy());

    expect(screen.queryByText('v1のファイルを取り込む')).toBeNull();
    expect(screen.queryByLabelText('v1の手動書き出しJSON')).toBeNull();
  });

  function stubAuthedFetch() {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { accountId: 'acc-1', email: 'a@example.com' })));
    localStorage.setItem('it-index-v2:token', 'tok-1');
  }

  it('同じ単語で複数台と競合したら、1枚のカードに端末ごとに縦に並べる(#203)', async () => {
    const deps = createSyncDeps();
    // 同じ語について3台と競合している状態(端末ごとに1件できる)
    await seedConflict(deps, {
      termId: 'tcp-ip',
      local: { termId: 'tcp-ip', diagrams: [], noteHistory: [], body: 'この端末の内容', updatedAt: 100, lastEditedBy: 'device-1' },
      remote: { termId: 'tcp-ip', diagrams: [], noteHistory: [], body: 'B端末の内容', updatedAt: 300, lastEditedBy: 'device-b' },
    });
    await seedConflict(
      deps,
      {
        termId: 'tcp-ip',
        local: { termId: 'tcp-ip', diagrams: [], noteHistory: [], body: 'この端末の内容', updatedAt: 100, lastEditedBy: 'device-1' },
        remote: { termId: 'tcp-ip', diagrams: [], noteHistory: [], body: 'C端末の内容', updatedAt: 200, lastEditedBy: 'device-c' },
      },
      1000,
    );
    stubAuthedFetch();

    renderSyncScreen(deps);

    const card = await screen.findByTestId('conflict-group-tcp-ip');
    // 語の数で数える(端末ごとの件数ではない)
    expect(screen.getByText('未解決の競合(1語)')).toBeTruthy();
    expect(within(card).getByText(/2台の端末と内容が食い違っています/)).toBeTruthy();

    // この端末が一番上、その下に相手端末が更新の新しい順で並ぶ。
    // 本文にも同じ文字列が出るため、見出し(sync-conflict-side-title)だけを数える
    const titles = Array.from(card.querySelectorAll('.sync-conflict-side-title')).map(
      (el) => el.textContent ?? '',
    );
    expect(titles).toHaveLength(3);
    expect(titles[0]).toContain('この端末の内容');
    expect(titles[1]).toContain('別の端末の内容');
    expect(within(card).getByText('B端末の内容')).toBeTruthy();
    expect(within(card).getByText('C端末の内容')).toBeTruthy();
  });

  it('「AIで統合する」を適用するとnotesに反映され、再度統合を選んでもキャッシュがあれば再呼び出ししない', async () => {
    const deps = createSyncDeps();
    await seedConflict(deps, makeConflict('tcp-ip'));
    const send = vi.fn().mockResolvedValue({
      text: JSON.stringify({ body: '統合された説明', diagrams: [] }),
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    stubAuthedFetch();

    renderSyncScreen(deps, { aiClient: fakeAiClient({ send }) });
    await waitFor(() => expect(screen.getByText('tcp-ip')).toBeTruthy());

    let item = screen.getByText('tcp-ip').closest('li')!;
    fireEvent.click(within(item).getByRole('button', { name: 'この端末とAIで統合' }));

    await waitFor(() => expect(screen.getByText('解決済みの競合(1件)')).toBeTruthy());
    expect(send).toHaveBeenCalledTimes(1);
    expect((await deps.notesRepo.getByTermId('tcp-ip'))?.body).toBe('統合された説明');

    // 選び直し: 一旦「この端末の内容」へ変更する(mergedキャッシュは消えない)
    item = screen.getByText('tcp-ip').closest('li')!;
    fireEvent.click(within(item).getAllByRole('button', { name: 'こちらを採用' })[0]);
    await waitFor(async () => expect((await deps.notesRepo.getByTermId('tcp-ip'))?.body).toBe('この端末の内容'));

    // 再度「AIで統合する」(キャッシュがあるためボタン名は「統合した内容を採用」)を選ぶ
    // -> AIを再度呼ばずキャッシュのbodyをそのまま適用する
    item = screen.getByText('tcp-ip').closest('li')!;
    fireEvent.click(within(item).getByRole('button', { name: '統合した内容を採用' }));
    await waitFor(async () => expect((await deps.notesRepo.getByTermId('tcp-ip'))?.body).toBe('統合された説明'));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('AI統合が失敗した場合はエラーを表示し、license_requiredなら設定タブへ誘導する(未適用のまま)', async () => {
    const deps = createSyncDeps();
    await seedConflict(deps, makeConflict('tcp-ip'));
    const send = vi.fn().mockRejectedValue(
      new ApiRequestError(
        { code: 'license_required', message: 'ライセンスが必要です。設定タブから購入(モック)するか、自分のサーバーを設定してください。' },
        403,
      ),
    );
    const onGoToSettings = vi.fn();
    stubAuthedFetch();

    renderSyncScreen(deps, { aiClient: fakeAiClient({ send }), onGoToSettings });
    await waitFor(() => expect(screen.getByText('tcp-ip')).toBeTruthy());

    const item = screen.getByText('tcp-ip').closest('li')!;
    fireEvent.click(within(item).getByRole('button', { name: 'この端末とAIで統合' }));

    await waitFor(() => expect(within(item).getByText(/ライセンスが必要です/)).toBeTruthy());
    fireEvent.click(within(item).getByRole('button', { name: '設定タブへ' }));
    expect(onGoToSettings).toHaveBeenCalled();

    // 適用されていない(未解決のまま・notesは変わっていない)
    expect(screen.queryByText('解決済みの競合(1件)')).toBeNull();
    expect(await deps.notesRepo.getByTermId('tcp-ip')).toBeUndefined();
  });

  it('AI統合の応答を解釈できない場合もエラーを表示する(license_required以外の通常のエラー文言)', async () => {
    const deps = createSyncDeps();
    await seedConflict(deps, makeConflict('tcp-ip'));
    const send = vi.fn().mockResolvedValue({ text: '壊れた応答', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } });
    stubAuthedFetch();

    renderSyncScreen(deps, { aiClient: fakeAiClient({ send }) });
    await waitFor(() => expect(screen.getByText('tcp-ip')).toBeTruthy());

    const item = screen.getByText('tcp-ip').closest('li')!;
    fireEvent.click(within(item).getByRole('button', { name: 'この端末とAIで統合' }));

    await waitFor(() => expect(within(item).getByText('AIの応答を解釈できませんでした。')).toBeTruthy());
  });

  it('解決済みの競合を選び直すと、この端末のnotesの内容が置き換わる', async () => {
    const deps = createSyncDeps();
    await seedConflict(deps, makeConflict('tcp-ip'));
    stubAuthedFetch();

    renderSyncScreen(deps);
    await waitFor(() => expect(screen.getByText('tcp-ip')).toBeTruthy());

    let item = screen.getByText('tcp-ip').closest('li')!;
    fireEvent.click(within(item).getAllByRole('button', { name: 'こちらを採用' })[0]); // 「この端末の内容」を採用
    await waitFor(() => expect(screen.getByText('解決済みの競合(1件)')).toBeTruthy());
    expect((await deps.notesRepo.getByTermId('tcp-ip'))?.body).toBe('この端末の内容');

    // 解決済み一覧側で選び直す(残っているボタンは「相手の端末の内容」側)
    item = screen.getByText('tcp-ip').closest('li')!;
    fireEvent.click(within(item).getAllByRole('button', { name: 'こちらを採用' })[0]);
    await waitFor(async () => expect((await deps.notesRepo.getByTermId('tcp-ip'))?.body).toBe('相手の端末の内容'));
  });

  // #171: 同期完了時の画面自動反映(onSyncApplied)の呼び出し条件。
  // 受信も統一も無い同期で無駄に全画面を再読込しないことを固定する。
  it('F1: 受信ありの同期ではonSyncAppliedが呼ばれる(#171)', async () => {
    const deps = createSyncDeps();
    const remoteFile = {
      syncSchemaVersion: 1,
      deviceId: 'device-2',
      writtenAt: 1,
      notes: [{ termId: 'term-a', body: '相手の本文', diagrams: [], updatedAt: 100, lastEditedBy: 'device-2', noteHistory: [] }],
      asks: [],
      aiTerms: [],
    };
    const onSyncApplied = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url === '/api/auth/me') return Promise.resolve(jsonResponse(200, { accountId: 'acc-1', email: 'a@example.com' }));
        if (url === '/api/sync/push') return Promise.resolve(jsonResponse(201, { seq: 1 }));
        return Promise.resolve(
          jsonResponse(200, {
            blobs: [{ seq: 2, deviceId: 'device-2', payload: JSON.stringify(remoteFile), createdAt: 2 }],
            latest: 2,
          }),
        );
      }),
    );
    localStorage.setItem('it-index-v2:token', 'tok-1');

    renderSyncScreen(deps, { onSyncApplied });
    await waitFor(() => expect(screen.getByText(/ログイン中: a@example.com/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '今すぐ同期' }));

    await waitFor(() => expect(onSyncApplied).toHaveBeenCalledTimes(1));
  });

  it('F1b: 受信0件・統一0件の同期ではonSyncAppliedを呼ばない(無駄な再読込をしない)(#171)', async () => {
    const onSyncApplied = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url === '/api/auth/me') return Promise.resolve(jsonResponse(200, { accountId: 'acc-1', email: 'a@example.com' }));
        if (url === '/api/sync/push') return Promise.resolve(jsonResponse(201, { seq: 1 }));
        return Promise.resolve(jsonResponse(200, { blobs: [], latest: 0 }));
      }),
    );
    localStorage.setItem('it-index-v2:token', 'tok-1');

    renderSyncScreen(createSyncDeps(), { onSyncApplied });
    await waitFor(() => expect(screen.getByText(/ログイン中: a@example.com/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '今すぐ同期' }));

    await waitFor(() => expect(screen.getByText(/変わった内容はありませんでした/)).toBeTruthy());
    expect(onSyncApplied).not.toHaveBeenCalled();
  });

  it('競合を解消するとonResolutionAppliedが呼ばれる(リレーへの自動pushの起点)(#169)', async () => {
    const deps = createSyncDeps();
    await seedConflict(deps, makeConflict('tcp-ip'));
    const onResolutionApplied = vi.fn();
    stubAuthedFetch();

    render(
      <SyncScreen
        db={deps.db}
        deviceId="device-1"
        isNativeApp={false}
        termsRepo={deps.termsRepo}
        notesRepo={deps.notesRepo}
        asksRepo={deps.asksRepo}
        noteConflictsRepo={deps.noteConflictsRepo}
        syncEventsRepo={deps.syncEventsRepo}
        syncStateRepo={deps.syncStateRepo}
        aiClient={fakeAiClient()}
        onResolutionApplied={onResolutionApplied}
      />,
    );
    await waitFor(() => expect(screen.getByText('tcp-ip')).toBeTruthy());

    const item = screen.getByText('tcp-ip').closest('li')!;
    fireEvent.click(within(item).getAllByRole('button', { name: 'こちらを採用' })[0]);

    await waitFor(() => expect(onResolutionApplied).toHaveBeenCalledTimes(1));
  });

  it('Androidネイティブでは競合カードを出さず、件数つきの案内文だけを表示する(#157, #165)', async () => {
    const deps = createSyncDeps();
    await seedConflict(deps, makeConflict('tcp-ip'));
    stubAuthedFetch();

    renderSyncScreen(deps, { isNativeApp: true });
    await waitFor(() => expect(screen.getByText(/競合が1件あります/)).toBeTruthy());

    // 案内文: 件数・PC側での解消・自分の内容の保持・次の同期での統一
    expect(screen.getByText(/解消はパソコン側で行ってください/)).toBeTruthy();
    expect(screen.getByText(/この端末で保存した内容を表示します/)).toBeTruthy();
    expect(screen.getByText(/次の同期で同じ内容に統一されます/)).toBeTruthy();
    // 競合カード(両側の内容表示)自体を出さない(#165)
    expect(screen.queryByText('tcp-ip')).toBeNull();
    expect(screen.queryByText('この端末の内容')).toBeNull();
    expect(screen.queryByText('相手の端末の内容')).toBeNull();
    // 解消操作も一切出さない
    expect(screen.queryByRole('button', { name: 'こちらを採用' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'この端末とAIで統合' })).toBeNull();
  });

  it('採用中の選択肢にはバッジが付く(#157)', async () => {
    const deps = createSyncDeps();
    await seedConflict(deps, makeConflict('tcp-ip'));
    stubAuthedFetch();

    renderSyncScreen(deps);
    await waitFor(() => expect(screen.getByText('tcp-ip')).toBeTruthy());
    expect(screen.queryByText('✓ 採用中')).toBeNull(); // 未解決の間はバッジ無し

    const item = screen.getByText('tcp-ip').closest('li')!;
    fireEvent.click(within(item).getAllByRole('button', { name: 'こちらを採用' })[0]); // この端末の内容

    await waitFor(() => expect(screen.getByText('✓ 採用中')).toBeTruthy());
    // 採用済み側にはボタンが出ず、未採用側の1つだけ残る
    const resolved = screen.getByText('tcp-ip').closest('li')!;
    expect(within(resolved).getAllByRole('button', { name: 'こちらを採用' })).toHaveLength(1);
  });

  it('解決済みの競合の一覧を表示する', async () => {
    const deps = createSyncDeps();
    await seedConflict(deps, makeConflict('tcp-ip'));
    stubAuthedFetch();

    renderSyncScreen(deps);
    await waitFor(() => expect(screen.getByText('tcp-ip')).toBeTruthy());
    expect(screen.queryByText(/解決済みの競合/)).toBeNull();

    const item = screen.getByText('tcp-ip').closest('li')!;
    fireEvent.click(within(item).getAllByRole('button', { name: 'こちらを採用' })[1]); // 「相手の端末の内容」を採用

    await waitFor(() => expect(screen.getByText('解決済みの競合(1件)')).toBeTruthy());
    expect(screen.queryByText(/未解決の競合/)).toBeNull();
    expect(screen.getByText(/現在の選択: 相手の端末の内容にしました。/)).toBeTruthy();
  });
});
