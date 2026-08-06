import { useEffect, useRef, useState } from 'react';
import { generatePairingKey, importPairingKey } from '../../pairing/crypto';
import { decodePairingPayload, encodePairingPayload } from '../../pairing/pairingCodec';
import { openAndMerge, sealSnapshot, type PairingResult } from '../../pairing/runPairingExchange';
import { describeSyncStatus } from '../../pairing/syncStatus';
import { encodeAsQrSvg } from '../../manualSync/qrCodec';
import { hasCameraDevice, startQrScan } from '../../manualSync/qrScanner';
import type { AiClient } from '../../ai/aiClient';
import type { ManualSyncDeps } from '../../manualSync/sync';
import type { SyncEventsRepository } from '../../repositories/syncEvents';
import ConflictResolver from '../shared/ConflictResolver';

export interface LinkModalProps {
  /** deviceId が読み込まれるまでは null（App.tsx の localFolderDeps と同じ理由） */
  deps: ManualSyncDeps | null;
  /** 競合を「2つをAIで統合する」ために使う（src/ui/shared/ConflictResolver.tsx） */
  claude: AiClient;
  /** 連携成立時に取り込み履歴（履歴画面の「取り込み履歴」タブ）へ記録する */
  syncEventsRepo: SyncEventsRepository;
  onClose: () => void;
}

/** 単語の増減が無いexchangeは履歴に残さない（asksのみのやり取り等） */
function recordSyncEvent(syncEventsRepo: SyncEventsRepository, result: Extract<Outcome, { ok: true }>) {
  if (result.receivedDelta.termIds.length === 0 && result.sentDelta.termIds.length === 0) return;
  const peerDeviceId = result.peerDeviceIds[0] ?? 'unknown';
  void syncEventsRepo.add(peerDeviceId, result.receivedDelta.termIds, result.sentDelta.termIds, Date.now());
}

type Outcome = PairingResult;

type View = 'menu' | 'host' | 'scan';

type HostState =
  | { phase: 'starting' }
  | { phase: 'showing'; svg: string }
  | { phase: 'processing'; svg: string }
  | { phase: 'done'; outcome: Outcome }
  | { phase: 'error'; message: string };

type ScanState =
  | { phase: 'scanning' }
  | { phase: 'invalidQr' }
  | { phase: 'processing' }
  | { phase: 'done'; outcome: Outcome }
  | { phase: 'error'; message: string };

/**
 * トップナビ「連携」の画面。同期のコアロジック（src/pairing/、src/manualSync/）は実装済みで、
 * ここではその配線とUIだけを行う。以前はモーダル表示だったが、他のナビ項目（検索・履歴・
 * 単語一覧）と同じ画面遷移先なのにここだけモーダルなのは違和感があるというユーザー指摘により、
 * 通常の画面表示に変更した（SettingsModal.tsx と同じ扱い）。`onClose` という名前のまま
 * 残しているが、実質は「検索へ戻る」（App.tsx側でその遷移をする）。
 *
 * 2経路（QR表示・カメラ読み取り）はどちらも「後始末を必ず呼ぶ」点が最重要
 * （docs/ui-pc.md §3のカメラ・タイマー・サーバー停止漏れの実バグ record を踏まえる）。
 * 「ファイルでやり取りする」経路は廃止した（ユーザー指摘）。
 */
export default function LinkModal({ deps, claude, syncEventsRepo, onClose }: LinkModalProps) {
  const [view, setView] = useState<View>('menu');
  const isDesktop = typeof window !== 'undefined' && !!window.desktop;

  // カメラの有無は非同期にしか分からない（hasCameraDevice の説明を参照）。
  // 判明するまでは出さない側に倒す。カメラ非搭載のPCでも「QRを表示」だけで連携できる。
  const [cameraAvailable, setCameraAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void hasCameraDevice().then((found) => {
      if (!cancelled) setCameraAvailable(found);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function goMenu() {
    setView('menu');
  }

  return (
    <div className="link-screen">
      {view === 'menu' && (
        <>
          <button type="button" className="term-detail-back" onClick={onClose}>
            ← 検索に戻る
          </button>
          <LinkMenu isDesktop={isDesktop} cameraAvailable={cameraAvailable} onSelect={setView} depsReady={deps !== null} />
        </>
      )}
      {view === 'host' && <HostView deps={deps} claude={claude} syncEventsRepo={syncEventsRepo} onBack={goMenu} />}
      {view === 'scan' && <ScanView deps={deps} claude={claude} syncEventsRepo={syncEventsRepo} onBack={goMenu} />}
    </div>
  );
}

function LinkMenu({
  isDesktop,
  cameraAvailable,
  depsReady,
  onSelect,
}: {
  isDesktop: boolean;
  cameraAvailable: boolean;
  depsReady: boolean;
  onSelect: (view: View) => void;
}) {
  return (
    <div className="link-menu">
      <p className="search-status">同じ利用者の別端末と、AI補足を含む単語データを揃えます。</p>
      {!depsReady && <p className="search-status">準備中です。しばらくお待ちください。</p>}
      {isDesktop && (
        <button type="button" className="btn-secondary link-menu-item" onClick={() => onSelect('host')} disabled={!depsReady}>
          QRを表示する（この端末で待ち受ける）
        </button>
      )}
      {cameraAvailable && (
        <button type="button" className="btn-secondary link-menu-item" onClick={() => onSelect('scan')} disabled={!depsReady}>
          カメラで読み取る（相手のQRに接続する）
        </button>
      )}
    </div>
  );
}

function ResultView({ outcome, deps, claude }: { outcome: Outcome; deps: ManualSyncDeps | null; claude: AiClient }) {
  if (!outcome.ok) {
    return <p className="chat-error">{outcome.reason}</p>;
  }
  return (
    <div className="link-result">
      <p className="search-status">
        渡した: {outcome.sentDelta.termIds.length}件 / 受け取った: {outcome.receivedDelta.termIds.length}件
      </p>
      {outcome.skippedFiles.length > 0 && (
        <p className="search-status">
          読み込めなかったファイルが{outcome.skippedFiles.length}件あります: {outcome.skippedFiles.join('、')}
        </p>
      )}
      {outcome.conflicts.length > 0 && deps && (
        <ConflictResolver
          conflicts={outcome.conflicts}
          deps={{ notesRepo: deps.notesRepo, conflictsRepo: deps.conflictsRepo, deviceId: deps.deviceId, claude }}
        />
      )}
    </div>
  );
}

/** 「QRを表示する」（待ち受け役）。docs要件: 完了・中断・閉じるとき必ず stopPairingServer() を呼ぶ */
function HostView({
  deps,
  claude,
  syncEventsRepo,
  onBack,
}: {
  deps: ManualSyncDeps | null;
  claude: AiClient;
  syncEventsRepo: SyncEventsRepository;
  onBack: () => void;
}) {
  const [state, setState] = useState<HostState>({ phase: 'starting' });

  useEffect(() => {
    const desktop = window.desktop;
    if (!desktop || !deps) return;

    let cancelled = false;
    let unregister: (() => void) | null = null;

    (async () => {
      const key = generatePairingKey();
      const cryptoKey = await importPairingKey(key);
      if (cancelled) return;
      if (!cryptoKey) {
        setState({ phase: 'error', message: '鍵の準備に失敗しました。もう一度お試しください。' });
        return;
      }

      const started = await desktop.startPairingServer();
      if (cancelled) {
        // cleanup が既に走った後にサーバーが起動してしまった場合、誰にも止められず
        // 掴んだままになるのを防ぐ（StrictModeの二重effect実行対策）
        void desktop.stopPairingServer();
        return;
      }
      if (!started.url) {
        setState({ phase: 'error', message: started.reason ?? 'サーバーを起動できませんでした。' });
        return;
      }

      const payload = encodePairingPayload({ v: 1, url: started.url, k: key });
      const qr = await encodeAsQrSvg(payload);
      if (cancelled) return;
      if (!qr.ok) {
        setState({ phase: 'error', message: qr.reason });
        return;
      }
      setState({ phase: 'showing', svg: qr.svg });

      unregister = desktop.onPairingRequest((requestId, body) => {
        void (async () => {
          setState((prev) => (prev.phase === 'showing' ? { phase: 'processing', svg: prev.svg } : prev));
          try {
            const sealed = await sealSnapshot(cryptoKey, deps);
            if (cancelled) return;
            const result = await openAndMerge(cryptoKey, body, deps, sealed.file);
            if (cancelled) return;
            if (result.ok) {
              await desktop.respondPairing(requestId, sealed.envelope);
              recordSyncEvent(syncEventsRepo, result);
            } else {
              await desktop.respondPairing(requestId, null);
            }
            if (cancelled) return;
            setState({ phase: 'done', outcome: result });
          } catch (err) {
            await desktop.respondPairing(requestId, null).catch(() => {});
            if (cancelled) return;
            setState({
              phase: 'error',
              message: `連携中に問題が起きました。もう一度QRを表示し直してください（${err instanceof Error ? err.message : String(err)}）。`,
            });
          }
        })();
      });
    })();

    return () => {
      cancelled = true;
      unregister?.();
      void desktop.stopPairingServer();
    };
  }, [deps]);

  return (
    <div className="link-view">
      <button type="button" className="term-detail-back" onClick={onBack}>
        ← 連携の選択に戻る
      </button>

      {!window.desktop && <p className="chat-error">この画面はデスクトップ版でのみ使えます。</p>}
      {state.phase === 'starting' && <p className="search-status">QRコードを準備しています…</p>}
      {(state.phase === 'showing' || state.phase === 'processing') && (
        <div className="link-qr" dangerouslySetInnerHTML={{ __html: state.svg }} />
      )}
      {state.phase === 'processing' && <p className="search-status">受信したデータを取り込んでいます…</p>}
      {state.phase === 'showing' && <p className="search-status">相手の端末でこのQRコードを読み取ってください。</p>}
      {state.phase === 'error' && <p className="chat-error">{state.message}</p>}
      {state.phase === 'done' && <ResultView outcome={state.outcome} deps={deps} claude={claude} />}
    </div>
  );
}

/** 「カメラで読み取る」（接続役）。docs要件: 成功・失敗・画面離脱いずれでも必ずスキャン停止関数を呼ぶ */
function ScanView({
  deps,
  claude,
  syncEventsRepo,
  onBack,
}: {
  deps: ManualSyncDeps | null;
  claude: AiClient;
  syncEventsRepo: SyncEventsRepository;
  onBack: () => void;
}) {
  const [state, setState] = useState<ScanState>({ phase: 'scanning' });
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!deps) return;
    let cancelled = false;
    let stop: (() => void) | null = null;
    let busy = false; // 直前のデコードを処理中は次のデコードを無視する

    (async () => {
      const video = videoRef.current;
      if (!video) return;
      try {
        const stopFn = await startQrScan(video, (text) => {
          if (cancelled || busy) return;

          const payload = decodePairingPayload(text);
          if (!payload) {
            setState({ phase: 'invalidQr' });
            return;
          }

          busy = true;
          setState({ phase: 'processing' });
          void (async () => {
            try {
              const key = await importPairingKey(payload.k);
              if (!key) throw new Error('このQRコードの鍵を読み取れませんでした。');
              const sealed = await sealSnapshot(key, deps);

              // レンダラーから直接 fetch すると index.html の CSP `connect-src 'self'` に
              // 阻まれてLAN内へ出られない。メインプロセス経由で送る（electron/pairingClient.ts）。
              // 送信側でHTTPステータスも判定するため、409/413/504 を「鍵が合いません」と
              // 誤って案内することがない。
              const desktop = window.desktop;
              if (!desktop) throw new Error('この機能はデスクトップ版でのみ使えます。');
              const posted = await desktop.postPairing(payload.url, sealed.envelope);
              if (cancelled) return;
              if (!posted.ok) {
                const message =
                  posted.kind === 'status' ? describeSyncStatus(posted.status) : posted.reason;
                setState({ phase: 'error', message });
                stop?.();
                return;
              }

              const result = await openAndMerge(key, posted.body, deps, sealed.file);
              if (cancelled) return;
              if (result.ok) recordSyncEvent(syncEventsRepo, result);
              setState({ phase: 'done', outcome: result });
              stop?.();
            } catch (err) {
              if (cancelled) return;
              setState({
                phase: 'error',
                message: `接続できませんでした。相手の端末が同じWi-Fiに繋がっているか確認してください（${err instanceof Error ? err.message : String(err)}）。`,
              });
              stop?.();
            } finally {
              busy = false;
            }
          })();
        });

        if (cancelled) {
          // cleanup が既に走った後にカメラが起動してしまった場合、掴んだままにしない
          // （StrictModeの二重effect実行対策。HostViewのサーバー起動と同じ理由）
          stopFn();
          return;
        }
        stop = stopFn;
      } catch {
        if (cancelled) return;
        setState({ phase: 'error', message: 'カメラを起動できませんでした。カメラの使用を許可しているか確認してください。' });
      }
    })();

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [deps]);

  const showVideo = state.phase === 'scanning' || state.phase === 'invalidQr' || state.phase === 'processing';

  return (
    <div className="link-view">
      <button type="button" className="term-detail-back" onClick={onBack}>
        ← 連携の選択に戻る
      </button>

      {/* 常にマウントしておく（videoRef を useEffect 開始時点で確保するため）。非表示時は隠すのみ */}
      <video ref={videoRef} className="link-camera" muted playsInline style={{ display: showVideo ? 'block' : 'none' }} />

      {state.phase === 'scanning' && <p className="search-status">相手の端末に表示されたQRコードにカメラを向けてください。</p>}
      {state.phase === 'invalidQr' && <p className="chat-error">このQRコードは連携用ではありません。読み取りを続けます。</p>}
      {state.phase === 'processing' && <p className="search-status">接続して取り込んでいます…</p>}
      {state.phase === 'error' && <p className="chat-error">{state.message}</p>}
      {state.phase === 'done' && <ResultView outcome={state.outcome} deps={deps} claude={claude} />}
    </div>
  );
}

