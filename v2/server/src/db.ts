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
