import { describe, expect, it, vi } from 'vitest';
import type { NoteRecord } from '@it-index/shared';
import type { AiClient } from './aiClient';
import { resolveConflict } from './resolveConflict';

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
