import { describe, expect, it, vi } from 'vitest';
import type { NoteRecord } from '@it-index/shared';
import type { AiClient } from './aiClient';
import { resolveConflictAll } from './resolveConflict';

function note(body: string, updatedAt: number, lastEditedBy: string): NoteRecord {
  return { termId: 'tcp/ip', body, diagrams: [], updatedAt, lastEditedBy, resolvedAt: null, noteHistory: [] };
}

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

