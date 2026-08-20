// architecture.md §3・§4: サーバーはsync_blobsのpayloadの中身を解釈しない(マージしない)。
// ここで持つのは採番(seq)と保管・取得だけ。

export type SyncBlobRow = {
  seq: number;
  device_id: string;
  payload: string;
  created_at: number;
};

const MAX_INSERT_ATTEMPTS = 2;
const PULL_LIMIT = 100;

export function isUniqueConstraintError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('UNIQUE constraint failed') || message.includes('SQLITE_CONSTRAINT');
}

// seqはアカウント内で単調増加。MAX(seq)+1の算出とINSERTを1つのSQL文にまとめて
// アトミックにするが、同一アカウントへの並行pushでは稀に競合しうるため、
// PRIMARY KEY(account_id, seq)衝突を検出した場合に限り1回だけ再計算してリトライする。
export async function insertSyncBlob(
  db: D1Database,
  accountId: string,
  deviceId: string,
  payload: string
): Promise<number> {
  const createdAt = Date.now();
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_INSERT_ATTEMPTS; attempt++) {
    try {
      const row = await db
        .prepare(
          `INSERT INTO sync_blobs (account_id, seq, device_id, payload, created_at)
           VALUES (?1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_blobs WHERE account_id = ?1), ?2, ?3, ?4)
           RETURNING seq`
        )
        .bind(accountId, deviceId, payload, createdAt)
        .first<{ seq: number }>();
      if (!row) throw new Error('insert into sync_blobs returned no row');
      return row.seq;
    } catch (err) {
      lastError = err;
      if (!isUniqueConstraintError(err)) throw err;
    }
  }

  throw lastError;
}

// AIプロキシの回数上限(architecture.md §5)。全体上限はこの予約IDの行で数える。
export const AI_GLOBAL_USAGE_ACCOUNT_ID = '__global__';

// 接続テスト(POST /api/ai/test)の回数はチャットの上限と別枠で数える。ai_usageのスキーマを
// 変えずに済ませるため、実在のアカウントID(UUID)とは衝突しない'test:'前置の予約キーの行を使う
// (全体上限の'__global__'と同じ方式)。これによりテストはチャットの残量を1回も消費しない。
export function aiTestUsageAccountId(accountId: string): string {
  return `test:${accountId}`;
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// account_id×dayの行をアトミックにインクリメントし、インクリメント後のcountを返す。
// 呼び出し側はcountが上限を超えていたら429を返すが、その時点で既に1回分が
// 消費されている(超過時にカウントが1消費される点は許容。db.tsコメントとしても明記)。
export async function incrementAiUsage(
  db: D1Database,
  accountId: string,
  day: string
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO ai_usage (account_id, day, count) VALUES (?1, ?2, 1)
       ON CONFLICT(account_id, day) DO UPDATE SET count = count + 1
       RETURNING count`
    )
    .bind(accountId, day)
    .first<{ count: number }>();
  if (!row) throw new Error('insert into ai_usage returned no row');
  return row.count;
}

// クライアントの残量表示用。行が無ければ0(まだ一度も利用していない)。
export async function getAiUsageCount(
  db: D1Database,
  accountId: string,
  day: string
): Promise<number> {
  const row = await db
    .prepare('SELECT count FROM ai_usage WHERE account_id = ?1 AND day = ?2')
    .bind(accountId, day)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function pullSyncBlobs(
  db: D1Database,
  accountId: string,
  since: number
): Promise<{ blobs: SyncBlobRow[]; latest: number }> {
  const { results } = await db
    .prepare(
      `SELECT seq, device_id, payload, created_at
       FROM sync_blobs
       WHERE account_id = ?1 AND seq > ?2
       ORDER BY seq ASC
       LIMIT ${PULL_LIMIT}`
    )
    .bind(accountId, since)
    .all<SyncBlobRow>();

  const latestRow = await db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS latest FROM sync_blobs WHERE account_id = ?1')
    .bind(accountId)
    .first<{ latest: number }>();

  return { blobs: results ?? [], latest: latestRow?.latest ?? 0 };
}

/* ------------------------------------------------------------------ */
/* 鍵の受け渡し(#182)                                                  */
/* ------------------------------------------------------------------ */

/** 受け渡しの有効期間。短くすることで「置いてある間に記録される」窓を狭める */
export const KEY_SHARE_TTL_MS = 5 * 60 * 1000;

/**
 * 取り出せる回数の上限。復号の成否はサーバーには分からない(暗号文しか持たないため)ので、
 * 「何回引き出されたか」で総当たりを止める。正常な受け渡しは1回で済む。
 */
export const KEY_SHARE_MAX_FETCHES = 5;

export type KeyShareRow = {
  salt: string;
  wrapped_dk: string;
  fetch_count: number;
  expires_at: number;
};

/**
 * 鍵の受け渡しを置く(1アカウント1件。やり直しは上書き)。
 * サーバーが受け取るのは**暗号文とsaltだけ**で、データ鍵も受け渡しコードも渡らない。
 */
export async function putKeyShare(
  db: D1Database,
  accountId: string,
  salt: string,
  wrappedDk: string,
  now: number
): Promise<{ expiresAt: number }> {
  const expiresAt = now + KEY_SHARE_TTL_MS;
  await db
    .prepare(
      `INSERT INTO key_shares (account_id, salt, wrapped_dk, fetch_count, expires_at, created_at)
       VALUES (?1, ?2, ?3, 0, ?4, ?5)
       ON CONFLICT(account_id) DO UPDATE SET
         salt = excluded.salt,
         wrapped_dk = excluded.wrapped_dk,
         fetch_count = 0,
         expires_at = excluded.expires_at,
         created_at = excluded.created_at`
    )
    .bind(accountId, salt, wrappedDk, expiresAt, now)
    .run();
  return { expiresAt };
}

/**
 * 鍵の受け渡しを取り出す。取り出すたびに回数を数え、**上限を超えたら行ごと破棄する**
 * (期限切れも同様)。破棄した場合・存在しない場合はnullを返す——呼び出し側からは
 * 「無い」と区別せず扱えるようにして、当てずっぽうの試行に情報を与えない。
 */
export async function takeKeyShare(
  db: D1Database,
  accountId: string,
  now: number
): Promise<KeyShareRow | null> {
  const row = await db
    .prepare('SELECT salt, wrapped_dk, fetch_count, expires_at FROM key_shares WHERE account_id = ?1')
    .bind(accountId)
    .first<KeyShareRow>();
  if (!row) return null;

  if (row.expires_at <= now || row.fetch_count + 1 > KEY_SHARE_MAX_FETCHES) {
    await deleteKeyShare(db, accountId);
    return null;
  }

  await db
    .prepare('UPDATE key_shares SET fetch_count = fetch_count + 1 WHERE account_id = ?1')
    .bind(accountId)
    .run();
  return row;
}

/** 受け取りに成功した側が消す。取り残しはexpires_atで失効する(takeKeyShare側で破棄) */
export async function deleteKeyShare(db: D1Database, accountId: string): Promise<void> {
  await db.prepare('DELETE FROM key_shares WHERE account_id = ?1').bind(accountId).run();
}

/**
 * 自アカウントの同期差分をすべて消す(#182の暗号化切り替え・鍵の作り直し)。
 * 各行は端末の全量スナップショットのため、消しても情報は失われない——次のpushで作り直される。
 *
 * **seqは MAX(seq)+1 の採番なので、全削除すると1から振り直しになる。**
 * 手元のcursorが残った端末が何もpullしなくなるため、クライアント側に
 * 「latestが自分のcursorより小さければcursorを0へ戻す」自己修復を入れてある
 * (client/src/sync/syncEngine.ts)。
 */
export async function deleteSyncBlobs(db: D1Database, accountId: string): Promise<number> {
  const result = await db.prepare('DELETE FROM sync_blobs WHERE account_id = ?1').bind(accountId).run();
  return result.meta.changes ?? 0;
}
