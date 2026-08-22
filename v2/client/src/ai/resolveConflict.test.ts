import { describe, expect, it, vi } from 'vitest';
import type { NoteRecord } from '@it-index/shared';
import type { AiClient } from './aiClient';
import { resolveConflict, resolveConflictAll } from './resolveConflict';

function note(body: string, updatedAt: number, lastEditedBy: string): NoteRecord {
  return { termId: 'tcp/ip', body, diagrams: [], updatedAt, lastEditedBy, resolvedAt: null, noteHistory: [] };
}

describe('resolveConflict', () => {
  it('両方の内容をAIに渡し、統合結果を返す', async () => {
    const aiClient: AiClient = {
      send: vi.fn().mockResolvedValue({
        text: JSON.stringify({ body: '統合された説明', diagrams: [] }),
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };

    const proposal = await resolveConflict('tcp/ip', note('Aの説明', 1, 'A'), note('Bの説明', 2, 'B'), aiClient);

    expect(proposal?.body).toBe('統合された説明');
    expect(aiClient.send).toHaveBeenCalledTimes(1);
  });

  it('AIの応答をJSONとして解釈できない場合はnullを返す(呼び出し元がエラーにする)', async () => {
    const aiClient: AiClient = {
      send: vi.fn().mockResolvedValue({ text: '壊れた応答', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }),
    };

    const proposal = await resolveConflict('tcp/ip', note('Aの説明', 1, 'A'), note('Bの説明', 2, 'B'), aiClient);

    expect(proposal).toBeNull();
  });

  it('AiClient.sendが失敗した場合はそのまま例外を投げる(未ログイン・license_required等の既存経路)', async () => {
    const aiClient: AiClient = { send: vi.fn().mockRejectedValue(new Error('AIチャットにはログインが必要です')) };

    await expect(resolveConflict('tcp/ip', note('Aの説明', 1, 'A'), note('Bの説明', 2, 'B'), aiClient)).rejects.toThrow(
      'AIチャットにはログインが必要です',
    );
  });
});
/**
 * **全端末を1回で統一する(#238)。**
 *
 * 以前は相手端末ごとに2版だけを統合していた。3台以上だと、
 * 1回目の統合結果を2回目でもう一度AIに通すことになり**要約の要約で情報が薄まる**うえ、
 * 決定が2回に分かれて相手が収束しなかった（実機で報告された）。
 */
describe('resolveConflictAll', () => {
  function aiReturning(text: string): AiClient {
    return {
      send: vi.fn().mockResolvedValue({
        text,
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
  }

  it('この端末＋相手全部を1回のAI呼び出しで統合する', async () => {
    const aiClient = aiReturning(JSON.stringify({ body: '全部入りの説明', diagrams: ['graph TD;A-->B;'] }));

    const proposal = await resolveConflictAll(
      'tcp/ip',
      note('この端末の説明', 5, 'device-pc'),
      [note('Android1の説明', 3, 'device-a1'), note('Android2の説明', 4, 'device-a2')],
      aiClient,
    );

    expect(proposal?.body).toBe('全部入りの説明');
    expect(proposal?.diagrams).toEqual(['graph TD;A-->B;']);
    // **1回だけ。** 相手ごとに呼ぶと情報が薄まるうえ決定が分裂する
    expect(aiClient.send).toHaveBeenCalledTimes(1);
  });

  it('渡した全端末の内容がプロンプトに載る(1台ぶんも落とさない)', async () => {
    const aiClient = aiReturning(JSON.stringify({ body: 'x', diagrams: [] }));

    await resolveConflictAll(
      'tcp/ip',
      note('この端末の説明', 5, 'device-pc'),
      [note('Android1の説明', 3, 'device-a1'), note('Android2の説明', 4, 'device-a2')],
      aiClient,
    );

    const sent = vi.mocked(aiClient.send).mock.calls[0][0];
    const content = sent.messages.map((m) => m.content).join(String.fromCharCode(10));
    expect(content).toContain('この端末の説明');
    expect(content).toContain('Android1の説明');
    expect(content).toContain('Android2の説明');
  });

  it('相手が1台でも同じ経路で統合できる', async () => {
    const aiClient = aiReturning(JSON.stringify({ body: '2版の統合', diagrams: [] }));

    const proposal = await resolveConflictAll(
      'tcp/ip',
      note('この端末の説明', 5, 'device-pc'),
      [note('相手の説明', 3, 'device-a1')],
      aiClient,
    );

    expect(proposal?.body).toBe('2版の統合');
    expect(aiClient.send).toHaveBeenCalledTimes(1);
  });

  it('AIの応答を解釈できない場合はnullを返す(呼び出し元が何も適用しない)', async () => {
    const aiClient = aiReturning('壊れた応答');

    const proposal = await resolveConflictAll(
      'tcp/ip',
      note('この端末の説明', 5, 'device-pc'),
      [note('相手の説明', 3, 'device-a1')],
      aiClient,
    );

    expect(proposal).toBeNull();
  });
});

