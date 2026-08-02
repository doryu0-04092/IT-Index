import { useEffect, useRef, useState } from 'react';
// window.desktop のグローバル型宣言を取り込むだけ（electron/ 配下は変更しない。型参照のみ）。
import '../../../electron/desktopApi';
import type { NoteConflict } from '../../core/mergeSnapshot';
import { generatePairingKey, importPairingKey } from '../../pairing/crypto';
import { decodePairingPayload, encodePairingPayload } from '../../pairing/pairingCodec';
import { openAndMerge, sealSnapshot } from '../../pairing/runPairingExchange';
import { downloadRawFile, readFilesAsRawFiles } from '../../manualSync/fileTransport';
import { encodeAsQrSvg } from '../../manualSync/qrCodec';
import { isCameraAvailable, startQrScan } from '../../manualSync/qrScanner';
import { exportOwnSyncFile, importSyncFiles, type ManualSyncDeps } from '../../manualSync/sync';

export interface LinkModalProps {
  /** deviceId が読み込まれるまでは null（App.tsx の localFolderDeps と同じ理由） */
  deps: ManualSyncDeps | null;
  onClose: () => void;
}

type Outcome = { ok: true; mergedNoteCount: number; conflicts: NoteConflict[]; skippedFiles: string[] } | { ok: false; reason: string };

type View = 'menu' | 'host' | 'scan' | 'file';

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

type FileState =
  | { phase: 'idle' }
  | { phase: 'busy' }
  | { phase: 'done'; outcome: Outcome };

/**
 * 「連携」モーダル。同期のコアロジック（src/pairing/、src/manualSync/）は実装済みで、
 * ここではその配線とUIだけを行う。モーダルの書き方は SettingsModal.tsx に揃える
 * （共通の<Modal>コンポーネントが無く、.modal-overlay/.modal-content/.modal-header を
 * 各所で手書きする規約のため）。
 *
 * 3経路（QR表示・カメラ読み取り・ファイル）はどれも「後始末を必ず呼ぶ」点が最重要
 * （docs/ui-pc.md §3のカメラ・タイマー・サーバー停止漏れの実バグ record を踏まえる）。
 */
export default function LinkModal({ deps, onClose }: LinkModalProps) {
  const [view, setView] = useState<View>('menu');
  const isDesktop = typeof window !== 'undefined' && !!window.desktop;
  const cameraAvailable = isCameraAvailable();

  function goMenu() {
    setView('menu');
  }

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- SettingsModal.tsx と同じ「背景クリックで閉じる」規約。既存コードのパターンに揃えており、キーボード操作は✕ボタンで担保する
    <div className="modal-overlay" onClick={onClose}>
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- 上と同じ理由。オーバーレイへのクリック伝播だけを止める */}
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>連携</h2>
          <button type="button" className="dismiss-error" onClick={onClose}>
            ✕
          </button>
        </div>

        {view === 'menu' && (
          <LinkMenu isDesktop={isDesktop} cameraAvailable={cameraAvailable} onSelect={setView} depsReady={deps !== null} />
        )}
        {view === 'host' && <HostView deps={deps} onBack={goMenu} />}
        {view === 'scan' && <ScanView deps={deps} onBack={goMenu} />}
        {view === 'file' && <FileView deps={deps} onBack={goMenu} />}
      </div>
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
      <button type="button" className="btn-secondary link-menu-item" onClick={() => onSelect('file')} disabled={!depsReady}>
        ファイルでやり取りする
      </button>
    </div>
  );
}

function ResultView({ outcome }: { outcome: Outcome }) {
  if (!outcome.ok) {
    return <p className="chat-error">{outcome.reason}</p>;
  }
  return (
    <div className="link-result">
      <p className="search-status">{outcome.mergedNoteCount}件の単語データを取り込みました。</p>
      {outcome.skippedFiles.length > 0 && (
        <p className="search-status">
          読み込めなかったファイルが{outcome.skippedFiles.length}件あります: {outcome.skippedFiles.join('、')}
        </p>
      )}
      {outcome.conflicts.length > 0 && (
        <p className="search-status">
          自動で統合できなかった項目が{outcome.conflicts.length}件あります。後で確認できます。
        </p>
      )}
    </div>
  );
}

/** 「QRを表示する」（待ち受け役）。docs要件: 完了・中断・閉じるとき必ず stopPairingServer() を呼ぶ */
function HostView({ deps, onBack }: { deps: ManualSyncDeps | null; onBack: () => void }) {
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
            const result = await openAndMerge(cryptoKey, body, deps);
            if (cancelled) return;
            if (result.ok) {
              const envelope = await sealSnapshot(cryptoKey, deps);
              if (cancelled) return;
              await desktop.respondPairing(requestId, envelope);
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
      {state.phase === 'done' && <ResultView outcome={state.outcome} />}
    </div>
  );
}

/** 「カメラで読み取る」（接続役）。docs要件: 成功・失敗・画面離脱いずれでも必ずスキャン停止関数を呼ぶ */
function ScanView({ deps, onBack }: { deps: ManualSyncDeps | null; onBack: () => void }) {
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
              const envelope = await sealSnapshot(key, deps);
              const res = await fetch(`${payload.url}/sync`, { method: 'POST', body: envelope });
              const responseBody = await res.text();
              const result = await openAndMerge(key, responseBody, deps);
              if (cancelled) return;
              setState({ phase: 'done', outcome: result });
              stop?.();
            } catch (err) {
              if (cancelled) return;
              setState({
                phase: 'error',
                message: `接続できませんでした。相手の端末が同じネットワークにあるか確認してください（${err instanceof Error ? err.message : String(err)}）。`,
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
      {state.phase === 'done' && <ResultView outcome={state.outcome} />}
    </div>
  );
}

/** 「ファイルでやり取りする」。ネットワーク不要のフォールバック */
function FileView({ deps, onBack }: { deps: ManualSyncDeps | null; onBack: () => void }) {
  const [state, setState] = useState<FileState>({ phase: 'idle' });
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  function handleExport() {
    if (!deps) return;
    void exportOwnSyncFile(deps).then(downloadRawFile);
  }

  async function handleImport(fileList: FileList | null) {
    if (!fileList || fileList.length === 0 || !deps) return;
    setState({ phase: 'busy' });
    try {
      const rawFiles = await readFilesAsRawFiles(fileList);
      const result = await importSyncFiles(rawFiles, deps);
      if (!mountedRef.current) return;
      setState({ phase: 'done', outcome: { ok: true, ...result } });
    } catch (err) {
      if (!mountedRef.current) return;
      setState({
        phase: 'done',
        outcome: {
          ok: false,
          reason: `ファイルを読み込めませんでした。他の端末から書き出したファイルか確認してください（${err instanceof Error ? err.message : String(err)}）。`,
        },
      });
    }
  }

  return (
    <div className="link-view">
      <button type="button" className="term-detail-back" onClick={onBack}>
        ← 連携の選択に戻る
      </button>

      <section className="settings-section">
        <h3>送る</h3>
        <button type="button" className="btn-secondary" onClick={handleExport} disabled={!deps}>
          この端末のデータをファイルに書き出す
        </button>
      </section>

      <section className="settings-section">
        <h3>受け取る</h3>
        <label className="link-file-input">
          <span>連携ファイルを選択（複数可）</span>
          <input
            type="file"
            multiple
            accept="application/json"
            disabled={!deps || state.phase === 'busy'}
            onChange={(e) => void handleImport(e.target.files)}
          />
        </label>
        {state.phase === 'busy' && <p className="search-status">取り込んでいます…</p>}
      </section>

      {state.phase === 'done' && <ResultView outcome={state.outcome} />}
    </div>
  );
}
