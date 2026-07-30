import type { NoteRecord, TermRecord } from '../types';

/**
 * `data/notes/<termId>.md` の相互変換。docs/local-data.md 参照。
 *
 * front matter（`term`/`field`/`summary`/`updatedAt`）は参照専用——Claude Code が編集対象の語を
 * 把握しやすくするために書き出すが、取り込み時は無視する（`summary` 不変ルールを構造的に守るため）。
 * front matter 以降が `NoteRecord.body`。` ```mermaid ` フェンスは `NoteRecord.diagrams[]` として
 * 別枠に持つ既存スキーマに合わせ、書き出し時は本文の後ろに付け直す（往復で安定させる）。
 */

const FRONT_MATTER_DELIMITER = '---';

export function buildNoteFile(term: TermRecord, note: NoteRecord | undefined): string {
  const updatedAt = note?.updatedAt ?? term.updatedAt;
  const frontMatter = [
    FRONT_MATTER_DELIMITER,
    `term: ${escapeFrontMatterValue(term.term)}`,
    `field: ${escapeFrontMatterValue(term.field)}`,
    `summary: ${escapeFrontMatterValue(term.summary ?? '')}`,
    `updatedAt: ${new Date(updatedAt).toISOString()}`,
    FRONT_MATTER_DELIMITER,
    '',
  ].join('\n');

  const body = (note?.body ?? '').trim();
  const diagrams = note?.diagrams ?? [];
  const diagramBlocks = diagrams.map((d) => '```mermaid\n' + d.trim() + '\n```').join('\n\n');

  const content = [body, diagramBlocks].filter((part) => part !== '').join('\n\n');
  return content === '' ? `${frontMatter}\n` : `${frontMatter}${content}\n`;
}

export interface ParsedNoteFile {
  body: string;
  diagrams: string[];
}

export function parseNoteFile(raw: string): ParsedNoteFile {
  const withoutFrontMatter = stripFrontMatter(raw);

  const diagrams: string[] = [];
  const mermaidFence = /```mermaid\n([\s\S]*?)```/g;
  const body = withoutFrontMatter
    .replace(mermaidFence, (_match, code: string) => {
      diagrams.push(code.trim());
      return '';
    })
    .trim();

  return { body, diagrams };
}

function stripFrontMatter(raw: string): string {
  const trimmed = raw.replace(/^﻿/, ''); // BOM対策
  if (!trimmed.startsWith(FRONT_MATTER_DELIMITER)) return trimmed;

  const closingIndex = trimmed.indexOf(`\n${FRONT_MATTER_DELIMITER}`, FRONT_MATTER_DELIMITER.length);
  if (closingIndex === -1) return trimmed; // 閉じの --- が無い場合はfront matterではないとみなす

  const afterClosing = trimmed.indexOf('\n', closingIndex + 1);
  return afterClosing === -1 ? '' : trimmed.slice(afterClosing + 1);
}

/** 改行を含む値だけ気をつければよい（値に改行が入ることは想定していないので単純に除去する） */
function escapeFrontMatterValue(value: string): string {
  return value.replace(/\r?\n/g, ' ');
}
