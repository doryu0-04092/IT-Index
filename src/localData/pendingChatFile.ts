import type { ChatMessageRecord, TermRecord } from '../types';

/**
 * `data/pending/<termId>.md`（docs/local-data.md）。確定ボタンを押す前のチャットのやり取りを
 * Claude Code が読めるようにするための書き出し専用ファイル。アプリはこのファイルを取り込まない
 * （front matter と同じく参照専用。Claude Code は `data/terms.json`/`data/notes/*.md` の方を編集する）。
 */

const FRONT_MATTER_DELIMITER = '---';

export function buildPendingChatFile(term: TermRecord, messages: ChatMessageRecord[]): string {
  const frontMatter = [
    FRONT_MATTER_DELIMITER,
    `term: ${escapeFrontMatterValue(term.term)}`,
    `status: 未確定（確定ボタンを押すか、この内容をもとに data/terms.json・data/notes/${term.id}.md を編集してください）`,
    FRONT_MATTER_DELIMITER,
    '',
  ].join('\n');

  const body = messages.map((m) => `**${m.role === 'user' ? '利用者' : 'AI'}:** ${m.content}`).join('\n\n');

  return `${frontMatter}${body}\n`;
}

function escapeFrontMatterValue(value: string): string {
  return value.replace(/\r?\n/g, ' ');
}
