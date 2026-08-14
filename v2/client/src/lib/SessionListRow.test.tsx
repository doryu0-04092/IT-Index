import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ChatSessionRecord } from '../types';
import SessionListRow from './SessionListRow';

function fakeRow(overrides: Partial<ChatSessionRecord> = {}) {
  const session: ChatSessionRecord = {
    id: 'session-1',
    termId: null,
    subjectLabel: 'ゼロトラスト',
    startedAt: 1,
    lastActiveAt: 1,
    status: 'open',
    ...overrides,
  };
  return { session, label: session.subjectLabel ?? '' };
}

describe('SessionListRow', () => {
  afterEach(cleanup);

  it('ラベルを表示し、押すとonSelectが呼ばれる', () => {
    const onSelect = vi.fn();
    render(
      <SessionListRow row={fakeRow()} onSelect={onSelect}>
        <button type="button">取り込む</button>
      </SessionListRow>,
    );

    fireEvent.click(screen.getByText('ゼロトラスト'));
    expect(onSelect).toHaveBeenCalled();
  });

  it('failedがtrueのときだけ失敗マークを表示する(検索画面「取り込み待ち」用)', () => {
    const { rerender } = render(
      <SessionListRow row={fakeRow()} onSelect={() => {}} failed={false}>
        <button type="button">取り込む</button>
      </SessionListRow>,
    );
    expect(screen.queryByText('前回の取り込みに失敗しました')).toBeNull();

    rerender(
      <SessionListRow row={fakeRow()} onSelect={() => {}} failed={true}>
        <button type="button">取り込む</button>
      </SessionListRow>,
    );
    expect(screen.getByText('前回の取り込みに失敗しました')).toBeTruthy();
  });

  it('metaを渡すとラベルの隣に補足(履歴画面の日時等)が表示される', () => {
    render(
      <SessionListRow row={fakeRow()} onSelect={() => {}} meta={<span>2026/1/1</span>}>
        <button type="button">取り込む</button>
      </SessionListRow>,
    );
    expect(screen.getByText('2026/1/1')).toBeTruthy();
  });

  it('childrenで渡した操作ボタン群をそのまま右側に描画する', () => {
    render(
      <SessionListRow row={fakeRow()} onSelect={() => {}}>
        <button type="button">取り込む</button>
        <button type="button">登録しない</button>
      </SessionListRow>,
    );
    expect(screen.getByText('取り込む')).toBeTruthy();
    expect(screen.getByText('登録しない')).toBeTruthy();
  });

  it('時系列・重み付けタブの行と同じ.result-row/.result-buttonクラスを使う(依頼者指定: 見た目を揃える)', () => {
    render(
      <SessionListRow row={fakeRow()} onSelect={() => {}}>
        <button type="button">取り込む</button>
      </SessionListRow>,
    );
    expect(document.querySelector('li.result-row')).toBeTruthy();
    expect(document.querySelector('div.result-button.session-list-row')).toBeTruthy();
    expect(document.querySelector('button.search-pending-item')).toBeTruthy();
  });

  it('セッションのlastActiveAtを時系列の行と同じtoLocaleString(ja-JP)書式で表示する', () => {
    const at = new Date('2026-03-04T05:06:07').getTime();
    render(
      <SessionListRow row={fakeRow({ lastActiveAt: at })} onSelect={() => {}}>
        <button type="button">取り込む</button>
      </SessionListRow>,
    );
    expect(screen.getByText(new Date(at).toLocaleString('ja-JP'))).toBeTruthy();
  });

  it('操作ボタン群は行の右側(.session-list-actions)に描画される', () => {
    render(
      <SessionListRow row={fakeRow()} onSelect={() => {}}>
        <button type="button">取り込む</button>
      </SessionListRow>,
    );
    const actions = document.querySelector('.session-list-actions');
    expect(actions).toBeTruthy();
    expect(actions && within(actions as HTMLElement).getByText('取り込む')).toBeTruthy();
  });
});
