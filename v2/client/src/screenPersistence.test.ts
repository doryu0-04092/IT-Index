import { afterEach, describe, expect, it } from 'vitest';
import { clearPersistedScreen, isPersistedScreen, persistScreen, readPersistedScreen } from './screenPersistence';

describe('screenPersistence', () => {
  afterEach(() => {
    clearPersistedScreen();
  });

  it('保存した画面をそのまま復元できる(search)', () => {
    persistScreen({ name: 'search' });
    expect(readPersistedScreen()).toEqual({ name: 'search' });
  });

  it('detail(returnTo付き)を保存・復元できる', () => {
    const screen = { name: 'detail' as const, termId: 'tcp/ip', returnTo: { name: 'index' as const } };
    persistScreen(screen);
    expect(readPersistedScreen()).toEqual(screen);
  });

  it('chatはinitialQuestionを保存対象から除く(#39と同じ、二重送信防止)', () => {
    persistScreen({
      name: 'chat',
      sessionId: 'session-1',
      returnTo: { name: 'search' },
      initialQuestion: 'ゼロトラストとは',
    });
    expect(readPersistedScreen()).toEqual({ name: 'chat', sessionId: 'session-1', returnTo: { name: 'search' } });
  });

  it('下書き(sessionId:null)チャットは復元対象にしない(検索画面へ落とす。本人指定)', () => {
    persistScreen({
      name: 'chat',
      sessionId: null,
      termId: 'tcp/ip',
      subjectLabel: '',
      returnTo: { name: 'search' },
    });
    expect(readPersistedScreen()).toBeNull();
  });

  it('settingsをそのまま保存・復元できる(設定タブ新設)', () => {
    persistScreen({ name: 'settings' });
    expect(readPersistedScreen()).toEqual({ name: 'settings' });
  });

  it('historyはviewが妥当な値の場合のみ復元する', () => {
    persistScreen({ name: 'history', view: 'weighted' });
    expect(readPersistedScreen()).toEqual({ name: 'history', view: 'weighted' });
  });

  it('何も保存されていなければnull', () => {
    expect(readPersistedScreen()).toBeNull();
  });

  it('壊れたJSONはnullを返す(検索画面に落ちる)', () => {
    sessionStorage.setItem('it-index-v2:last-screen', '{not json');
    expect(readPersistedScreen()).toBeNull();
  });

  it('形が想定外のオブジェクトはnullを返す', () => {
    sessionStorage.setItem('it-index-v2:last-screen', JSON.stringify({ name: 'unknown-screen' }));
    expect(readPersistedScreen()).toBeNull();

    sessionStorage.setItem('it-index-v2:last-screen', JSON.stringify({ name: 'detail' })); // termId欠落
    expect(readPersistedScreen()).toBeNull();

    sessionStorage.setItem('it-index-v2:last-screen', JSON.stringify({ name: 'history', view: 'sync' })); // 不正なview
    expect(readPersistedScreen()).toBeNull();

    sessionStorage.setItem(
      'it-index-v2:last-screen',
      JSON.stringify({ name: 'chat', sessionId: 's1', returnTo: { name: 'unknown' } }), // returnToが不正
    );
    expect(readPersistedScreen()).toBeNull();

    sessionStorage.setItem(
      'it-index-v2:last-screen',
      JSON.stringify({ name: 'chat', sessionId: null, termId: null, subjectLabel: '', returnTo: { name: 'search' } }), // 下書き
    );
    expect(readPersistedScreen()).toBeNull();
  });

  it('isPersistedScreenは配列やnullを弾く', () => {
    expect(isPersistedScreen(null)).toBe(false);
    expect(isPersistedScreen([])).toBe(false);
    expect(isPersistedScreen('search')).toBe(false);
  });
});
