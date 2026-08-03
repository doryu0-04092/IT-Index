import { useEffect, useRef, useState } from 'react';
import { PairingServer } from '../../native/pairingServer';
import type { NoteConflict } from '../../core/mergeSnapshot';
import { generatePairingKey, importPairingKey } from '../../pairing/crypto';
import { decodePairingPayload, encodePairingPayload } from '../../pairing/pairingCodec';
import { openAndMerge, sealSnapshot } from '../../pairing/runPairingExchange';
import { describeSyncStatus } from '../../pairing/syncStatus';
import Sheet from './Sheet';
import { readFilesAsRawFiles } from '../../manualSync/fileTransport';
import { encodeAsQrSvg } from '../../manualSync/qrCodec';
import { hasCameraDevice, startQrScan } from '../../manualSync/qrScanner';
import { exportOwnSyncFile, importSyncFiles, type ManualSyncDeps } from '../../manualSync/sync';
import { shareRawFile } from '../../native/shareFile';

export interface LinkModalProps {
  /** deviceId が読み込まれるまでは null（Android版Appのlocalの理由はPC版と同じ） */
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
 * 「連携」モーダル（Android版）。同期のコアロジック（src/pairing/、src/manualSync/）は
 * プラットフォーム非依存で、PC版とAndroid版で共有する。ここではその配線とUIだけを行う
 * （PC版 src/ui/pc/LinkModal.tsx と同じ方針）。
 *
 * PC版との唯一の違いは、待ち受け役（HostView）の実装が Electron の window.desktop ではなく
 * Capacitorプラグイン `PairingServer`（src/native/pairingServer.ts）になる点。
 * 3経路（QR表示・カメラ読み取り・ファイル）はどれも「後始末を必ず呼ぶ」点が最重要
 * （docs/ui-pc.md §3のカメラ・タイマー・サーバー停止漏れの実バグ記録を踏まえる）。
 */
export default function LinkModal({ deps, onClose }: LinkModalProps) {
  const [view, setView] = useState<View>('menu');

  // カメラの有無は非同期にしか分からない（hasCameraDevice の説明を参照）。
  // 判明するまでは出さない側に倒す。
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
    <Sheet title="連携" onClose={onClose}>
      <>
        {view === 'menu' && <LinkMenu cameraAvailable={cameraAvailable} onSelect={setView} depsReady={deps !== null} />}
        {view === 'host' && <HostView deps={deps} onBack={goMenu} />}
        {view === 'scan' && <ScanView deps={deps} onBack={goMenu} />}
        {view === 'file' && <FileView deps={deps} onBack={goMenu} />}
      </>
    </Sheet>
  );
}

function LinkMenu({
  cameraAvailable,
  depsReady,
  onSelect,
}: {
  cameraAvailable: boolean;
  depsReady: boolean;
  onSelect: (view: View) => void;
}) {
  return (
    <div className="link-menu">
      <p className="search-status">同じ利用者の別端末と、AI補足を含む単語データを揃えます。</p>
      {!depsReady && <p className="search-status">準備中です。しばらくお待ちください。</p>}
      {/* Android版はPairingServerプラグインが常に使えるため、PC版のisDesktop相当の分岐は無い */}
      <button type="button" className="btn-secondary link-menu-item" onClick={() => onSelect('host')} disabled={!depsReady}>
        QRを表示する（この端末で待ち受ける）
      </button>
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

/**
 * 「QRを表示する」（待ち受け役、Android版）。
 * docs要件: 完了・中断・閉じるとき必ず PairingServer.stop() とリスナーの remove() を呼ぶ。
 * React 18 StrictModeの二重effect実行でサーバー・リスナーが二重に残らないよう、
 * PC版のHostViewと同じ `cancelled` フラグによる対策を踏襲する。
 */
function HostView({ deps, onBack }: { deps: ManualSyncDeps | null; onBack: () => void }) {
  const [state, setState] = useState<HostState>({ phase: 'starting' });

  useEffect(() => {
    if (!deps) return;

    let cancelled = false;
    let removeListener: (() => Promise<void>) | null = null;

    (async () => {
      const key = generatePairingKey();
      const cryptoKey = await importPairingKey(key);
      if (cancelled) return;
      if (!cryptoKey) {
        setState({ phase: 'error', message: '鍵の準備に失敗しました。もう一度お試しください。' });
        return;
      }

      const started = await PairingServer.start();
      if (cancelled) {
        // cleanup が既に走った後にサーバーが起動してしまった場合、誰にも止められず
        // 掴んだままになるのを防ぐ（StrictModeの二重effect実行対策）
        void PairingServer.stop();
        return;
      }
      if (!started.url) {
        setState({ phase: 'error', message: started.reason ?? 'サーバーを起動できませんでした。' });
        return;
      }

      const payload = encodePairingPayload({ v: 1, url: started.url, k: key });
      const qr = await encodeAsQrSvg(payload);
      if (cancelled) {
        void PairingServer.stop();
        return;
      }
      if (!qr.ok) {
        setState({ phase: 'error', message: qr.reason });
        void PairingServer.stop();
        return;
      }
      setState({ phase: 'showing', svg: qr.svg });

      const handle = await PairingServer.addListener('pairingRequest', (event) => {
        void (async () => {
          const { requestId, body } = event;
          setState((prev) => (prev.phase === 'showing' ? { phase: 'processing', svg: prev.svg } : prev));
          try {
            const result = await openAndMerge(cryptoKey, body, deps);
            if (cancelled) return;
            if (result.ok) {
              const envelope = await sealSnapshot(cryptoKey, deps);
              if (cancelled) return;
              await PairingServer.respond({ requestId, body: envelope });
            } else {
              await PairingServer.respond({ requestId, body: null });
            }
            if (cancelled) return;
            setState({ phase: 'done', outcome: result });
          } catch (err) {
            await PairingServer.respond({ requestId, body: null }).catch(() => {});
            if (cancelled) return;
            setState({
              phase: 'error',
              message: `連携中に問題が起きました。もう一度QRを表示し直してください（${err instanceof Error ? err.message : String(err)}）。`,
            });
          }
        })();
      });

      if (cancelled) {
        void handle.remove();
        void PairingServer.stop();
        return;
      }
      removeListener = handle.remove;
    })();

    return () => {
      cancelled = true;
      void removeListener?.();
      void PairingServer.stop();
    };
  }, [deps]);

  return (
    <div className="link-view">
      <button type="button" className="term-detail-back" onClick={onBack}>
        ← 連携の選択に戻る
      </button>

      {state.phase === 'starting' && <p className="search-status">QRコードを準備しています…</p>}
      {state.phase === 'showing' && (
        <>
          <div className="link-qr" dangerouslySetInnerHTML={{ __html: state.svg }} />
          <p className="search-status">相手の端末でこのQRコードを読み取ってください。</p>
        </>
      )}
      {/* 接続できたらQRコードは消し、スキャン側と同じ丸い回転（.chat-spinner）で
          「つながっている」ことが視覚的にわかるようにする */}
      {state.phase === 'processing' && (
        <div className="link-connecting">
          <span className="chat-spinner" aria-label="接続中" />
          <p className="search-status">受信したデータを取り込んでいます…</p>
        </div>
      )}
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
              // CapacitorHttp が有効なので fetch はネイティブ側で実行され、
              // WebViewの混在コンテンツ制限とCSPを回避してLAN内へ出られる（capacitor.config.ts）。
              const res = await fetch(`${payload.url}/sync`, { method: 'POST', body: envelope });
              if (cancelled) return;
              // ステータスを必ず見る。見ないと 409/413/504 の本文をそのまま復号にかけて
              // 「鍵が合いません」と案内してしまい、QRを読み直しても直らない。
              if (!res.ok) {
                setState({ phase: 'error', message: describeSyncStatus(res.status) });
                stop?.();
                return;
              }
              const responseBody = await res.text();
              const result = await openAndMerge(key, responseBody, deps);
              if (cancelled) return;
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

    // アプリがバックグラウンドへ回ってもモーダルはアンマウントされないため、effectの
    // cleanupだけではカメラが点いたまま残る（インジケータ点灯・電池消費）。
    // 待ち受けサーバー側は PairingServerPlugin.handleOnStop() で既に対策済みで、
    // カメラだけが抜けていた。
    const handleVisibility = () => {
      if (!document.hidden || cancelled || busy) return;
      stop?.();
      stop = null;
      setState({
        phase: 'error',
        message: 'アプリが他の画面に移ったため、カメラを止めました。もう一度「カメラで読み取る」を選んでください。',
      });
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibility);
      stop?.();
    };
  }, [deps]);

  // 接続できたらカメラは閉じ、ホスト側（HostView）と同じ丸い回転（.chat-spinner）に切り替える
  const showVideo = state.phase === 'scanning' || state.phase === 'invalidQr';

  return (
    <div className="link-view">
      <button type="button" className="term-detail-back" onClick={onBack}>
        ← 連携の選択に戻る
      </button>

      {/* 常にマウントしておく（videoRef を useEffect 開始時点で確保するため）。非表示時は隠すのみ */}
      <video ref={videoRef} className="link-camera" muted playsInline style={{ display: showVideo ? 'block' : 'none' }} />

      {state.phase === 'scanning' && <p className="search-status">相手の端末に表示されたQRコードにカメラを向けてください。</p>}
      {state.phase === 'invalidQr' && <p className="chat-error">このQRコードは連携用ではありません。読み取りを続けます。</p>}
      {state.phase === 'processing' && (
        <div className="link-connecting">
          <span className="chat-spinner" aria-label="接続中" />
          <p className="search-status">接続して取り込んでいます…</p>
        </div>
      )}
      {state.phase === 'error' && <p className="chat-error">{state.message}</p>}
      {state.phase === 'done' && <ResultView outcome={state.outcome} />}
    </div>
  );
}

/** 「ファイルでやり取りする」。ネットワーク不要のフォールバック */
function FileView({ deps, onBack }: { deps: ManualSyncDeps | null; onBack: () => void }) {
  const [state, setState] = useState<FileState>({ phase: 'idle' });
  const [exportState, setExportState] = useState<
    { phase: 'idle' } | { phase: 'busy' } | { phase: 'done' } | { phase: 'error'; message: string }
  >({ phase: 'idle' });
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  // PC版のdownloadRawFile（ブラウザの<a download>）はCapacitorのWebViewでは機能しないため、
  // Android版はFilesystem/Shareプラグイン経由でOSの共有シートを開く（src/native/shareFile.ts）。
  async function handleExport() {
    if (!deps) return;
    setExportState({ phase: 'busy' });
    try {
      const file = await exportOwnSyncFile(deps);
      await shareRawFile(file);
      if (!mountedRef.current) return;
      setExportState({ phase: 'done' });
    } catch (err) {
      if (!mountedRef.current) return;
      setExportState({
        phase: 'error',
        message: `書き出しに失敗しました（${err instanceof Error ? err.message : String(err)}）。`,
      });
    }
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
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void handleExport()}
          disabled={!deps || exportState.phase === 'busy'}
        >
          この端末のデータをファイルに書き出す
        </button>
        {exportState.phase === 'busy' && <p className="search-status">書き出しています…</p>}
        {exportState.phase === 'done' && <p className="search-status">共有シートを開きました。送り先を選んでください。</p>}
        {exportState.phase === 'error' && <p className="chat-error">{exportState.message}</p>}
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
