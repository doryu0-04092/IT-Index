import { useEffect, useRef, useState } from 'react';
import {
  ApiRequestError,
  deleteKeyShare,
  deleteSyncBlobs,
  fetchKeyShare,
  putKeyShare,
} from './apiClient';
import { encodeAsQrSvg } from './qrCodec';
import { hasCameraDevice, startQrScan } from './qrScanner';
import {
  buildKeyQrPayload,
  formatTransferCode,
  generateTransferCode,
  normalizeTransferCode,
  parseKeyQrPayload,
  TRANSFER_CODE_DIGITS,
  unwrapDataKey,
  wrapDataKey,
} from './syncCrypto';
import { getOrCreateDataKey, regenerateDataKey, setDataKey } from './syncKeyStore';

/**
 * 同期の暗号鍵をもう一方の端末へ渡すUI(#182)。
 *
 * 同期データはこの端末の鍵で暗号化してから預けるため、**別の端末で読むには同じ鍵が要る**。
 * 渡し方は2通りで、既定はQR:
 *
 * - **QRで渡す(推奨)**: 鍵がサーバーを一切通らない。代わりに画面を第三者に見られると漏れる
 * - **8桁の数字コード**: カメラが使えない時の代替。包んだ鍵が5分だけサーバーに載る
 *
 * どちらを使っても、渡した後は両端末が同じ鍵を持つ。鍵を全部失った場合は
 * 「鍵を作り直す」でやり直せる(サーバー上の差分は読めなくなるため一緒に消す)。
 */

export interface KeyTransferSectionProps {
  token: string;
  accountId: string;
  /** 直前の同期で復号できなかった差分の件数。0より大きければ鍵が揃っていない */
  undecryptableBlobs: number;
}

type Mode = 'idle' | 'show-qr' | 'scan-qr' | 'show-code' | 'enter-code';

export default function KeyTransferSection({
  token,
  accountId,
  undecryptableBlobs,
}: KeyTransferSectionProps) {
  const [mode, setMode] = useState<Mode>('idle');
  const [cameraAvailable, setCameraAvailable] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // QR表示・コード表示の中身
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [codeDraft, setCodeDraft] = useState('');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stopScanRef = useRef<(() => void) | null>(null);

  // カメラの有無は「APIがあるか」ではなく「実機が繋がっているか」で見る(qrScanner.ts参照)。
  // 無い端末に「QRを読み取る」を出すと、押して初めて失敗することになる
  useEffect(() => {
    void hasCameraDevice().then(setCameraAvailable);
  }, []);

  // 画面を離れる・モードを変える時にカメラを必ず解放する
  useEffect(() => {
    return () => {
      stopScanRef.current?.();
      stopScanRef.current = null;
    };
  }, []);

  function resetTo(next: Mode) {
    stopScanRef.current?.();
    stopScanRef.current = null;
    setError(null);
    setMessage(null);
    setQrSvg(null);
    setIssuedCode(null);
    setCodeDraft('');
    setMode(next);
  }

  /* ---------------- QRで渡す ---------------- */

  async function handleShowQr() {
    resetTo('show-qr');
    const result = await encodeAsQrSvg(buildKeyQrPayload(getOrCreateDataKey(accountId)));
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setQrSvg(result.svg);
  }

  /* ---------------- QRで受け取る ---------------- */

  async function handleStartScan() {
    resetTo('scan-qr');
    // videoRefはこのレンダー後に生える。1フレーム待ってから掴む
    await Promise.resolve();
    const video = videoRef.current;
    if (!video) return;

    try {
      stopScanRef.current = await startQrScan(video, (text) => {
        void handleScanned(text);
      });
    } catch {
      setError('カメラを開けませんでした。カメラの使用を許可してください。');
      setMode('idle');
    }
  }

  async function handleScanned(text: string) {
    const dataKey = await parseKeyQrPayload(text);
    if (dataKey === null) {
      // 別のQRを読んだ場合。読み取りは続けたままにする(かざし直せば通る)
      setError('このQRコードは同期の鍵ではありません。相手の画面のQRをかざしてください。');
      return;
    }
    stopScanRef.current?.();
    stopScanRef.current = null;
    setDataKey(accountId, dataKey);
    setError(null);
    setMode('idle');
    setMessage('鍵を受け取りました。「今すぐ同期」で相手のデータを読み込めます。');
  }

  /* ---------------- 数字コードで渡す ---------------- */

  async function handleIssueCode() {
    resetTo('show-code');
    setBusy(true);
    try {
      const code = generateTransferCode();
      const wrapped = await wrapDataKey(getOrCreateDataKey(accountId), code);
      await putKeyShare(token, wrapped);
      setIssuedCode(code);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'サーバーに接続できませんでした');
      setMode('idle');
    } finally {
      setBusy(false);
    }
  }

  /* ---------------- 数字コードで受け取る ---------------- */

  async function handleSubmitCode() {
    const code = normalizeTransferCode(codeDraft);
    if (code.length !== TRANSFER_CODE_DIGITS || busy) return;

    setBusy(true);
    setError(null);
    try {
      const share = await fetchKeyShare(token);
      const dataKey = await unwrapDataKey(share, code);
      if (dataKey === null) {
        // 判定はクライアント側で閉じる(サーバーは復号の成否を知らない)
        setError('コードが違います。相手の画面に出ている8桁を確認してください。');
        return;
      }
      setDataKey(accountId, dataKey);
      // 受け取れたらサーバーの預かりを消す(取り残しは期限切れでも失効する。二段で残さない)
      await deleteKeyShare(token).catch(() => undefined);
      resetTo('idle');
      setMessage('鍵を受け取りました。「今すぐ同期」で相手のデータを読み込めます。');
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) {
        setError('受け渡しの有効期限(5分)が切れています。相手の画面でコードを出し直してください。');
      } else {
        setError(err instanceof ApiRequestError ? err.message : 'サーバーに接続できませんでした');
      }
    } finally {
      setBusy(false);
    }
  }

  /* ---------------- 鍵の作り直し ---------------- */

  const [resetOpen, setResetOpen] = useState(false);

  async function handleRegenerate() {
    setBusy(true);
    setError(null);
    try {
      regenerateDataKey(accountId);
      // 古い鍵で暗号化された差分は誰にも復号できない。残しても読めないまま溜まるので消す
      await deleteSyncBlobs(token);
      setResetOpen(false);
      resetTo('idle');
      setMessage(
        '鍵を作り直しました。サーバー上の差分を消したので、各端末で「今すぐ同期」を1回ずつ実行してください。',
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'サーバーに接続できませんでした');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="key-transfer" data-testid="key-transfer">
      <h3>同期の鍵</h3>

      {undecryptableBlobs > 0 && (
        <p className="sync-error" data-testid="undecryptable-notice" role="alert">
          他の端末のデータを{undecryptableBlobs}件読めませんでした。この端末はまだ同じ鍵を持っていません。
          下の手順で鍵を受け取ると読めるようになります(データは失われていません)。
        </p>
      )}

      <p className="status-text-small">
        同期データはこの端末の鍵で暗号化してから預けています。別の端末で読むには、同じ鍵を渡してください。
      </p>

      {message && <p className="status-text key-transfer-done">{message}</p>}
      {error && <p className="sync-error">{error}</p>}

      {mode === 'idle' && (
        <div className="key-transfer-actions">
          <button type="button" className="btn-primary" onClick={() => void handleShowQr()}>
            QRを表示する(渡す側)
          </button>
          {cameraAvailable && (
            <button type="button" className="btn-secondary" onClick={() => void handleStartScan()}>
              QRを読み取る(受け取る側)
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={() => void handleIssueCode()}>
            数字コードを表示する(渡す側)
          </button>
          <button type="button" className="btn-secondary" onClick={() => resetTo('enter-code')}>
            数字コードを入力する(受け取る側)
          </button>
        </div>
      )}

      {mode === 'show-qr' && (
        <div className="key-transfer-panel">
          <p className="status-text-small">
            もう一方の端末で「QRを読み取る」を選び、この画面を写してください。
          </p>
          <p className="key-transfer-warning">
            このQRには鍵そのものが入っています。他の人に見せないでください。
          </p>
          {qrSvg && (
            <div
              className="key-transfer-qr"
              // 生成元はqrcodeライブラリのSVG文字列で、利用者入力は含まれない
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
          )}
          <button type="button" className="btn-secondary" onClick={() => resetTo('idle')}>
            閉じる
          </button>
        </div>
      )}

      {mode === 'scan-qr' && (
        <div className="key-transfer-panel">
          <p className="status-text-small">相手の端末に表示されたQRコードを写してください。</p>
          <video ref={videoRef} className="key-transfer-video" playsInline muted />
          <button type="button" className="btn-secondary" onClick={() => resetTo('idle')}>
            やめる
          </button>
        </div>
      )}

      {mode === 'show-code' && (
        <div className="key-transfer-panel">
          <p className="status-text-small">
            もう一方の端末で「数字コードを入力する」を選び、この8桁を入力してください。
            <strong>5分で使えなくなります。</strong>
          </p>
          {busy && <p className="status-text">準備しています…</p>}
          {issuedCode && (
            <p className="key-transfer-code" data-testid="issued-code">
              {formatTransferCode(issuedCode)}
            </p>
          )}
          <button type="button" className="btn-secondary" onClick={() => resetTo('idle')}>
            閉じる
          </button>
        </div>
      )}

      {mode === 'enter-code' && (
        <div className="key-transfer-panel">
          <label htmlFor="key-transfer-code-input">相手の画面に出ている8桁</label>
          <input
            id="key-transfer-code-input"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={codeDraft}
            onChange={(e) => setCodeDraft(e.target.value)}
            disabled={busy}
          />
          <button
            type="button"
            className="btn-primary"
            onClick={() => void handleSubmitCode()}
            disabled={busy || normalizeTransferCode(codeDraft).length !== TRANSFER_CODE_DIGITS}
          >
            {busy ? '受け取っています…' : '鍵を受け取る'}
          </button>
          <button type="button" className="btn-secondary" onClick={() => resetTo('idle')}>
            やめる
          </button>
        </div>
      )}

      {/* 全端末の鍵を失った時の復旧。取り消せない操作なので二段確認にする
          (設定タブのオールクリア・解約と同じ作法) */}
      <div className="key-transfer-reset">
        {!resetOpen ? (
          <button type="button" className="btn-text" onClick={() => setResetOpen(true)}>
            鍵を作り直す
          </button>
        ) : (
          <div className="key-transfer-reset-panel">
            <p className="status-text-small">
              すべての端末で鍵が分からなくなった場合の操作です。実行すると
              <strong>サーバー上の同期データを削除します</strong>
              (古い鍵で暗号化されており、もう誰にも読めないため)。
              各端末のデータは消えません——作り直した後、各端末で「今すぐ同期」を1回ずつ実行すると揃います。
            </p>
            <button
              type="button"
              className="btn-danger"
              onClick={() => void handleRegenerate()}
              disabled={busy}
            >
              {busy ? '実行しています…' : '鍵を作り直してサーバー上の差分を削除する'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setResetOpen(false)}>
              やめる
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
