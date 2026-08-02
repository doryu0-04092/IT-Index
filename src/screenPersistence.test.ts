import { describe, expect, it } from 'vitest';
import { isPersistedScreen } from './screenPersistence';

// sessionStorage自体はブラウザAPIのためテスト対象外（src/ui/theme.tsと同じ方針）。
// ここではJSON検証ロジック（純関数）だけを検証する。
describe('isPersistedScreen', () => {
  it('accepts a search screen', () => {
    expect(isPersistedScreen({ name: 'search' })).toBe(true);
  });

  it('accepts a detail screen with a string termId', () => {
    expect(isPersistedScreen({ name: 'detail', termId: 'api' })).toBe(true);
  });

  it('rejects a detail screen without termId', () => {
    expect(isPersistedScreen({ name: 'detail' })).toBe(false);
  });

  it('accepts a chat screen with a term-linked returnTermId', () => {
    expect(isPersistedScreen({ name: 'chat', sessionId: 's1', returnTermId: 'api' })).toBe(true);
  });

  it('accepts a chat screen with returnTermId null (free mode)', () => {
    expect(isPersistedScreen({ name: 'chat', sessionId: 's1', returnTermId: null })).toBe(true);
  });

  it('rejects a chat screen without sessionId', () => {
    expect(isPersistedScreen({ name: 'chat', returnTermId: null })).toBe(false);
  });

  it('accepts a history screen with a valid view', () => {
    expect(isPersistedScreen({ name: 'history', view: 'weighted' })).toBe(true);
    expect(isPersistedScreen({ name: 'history', view: 'timeline' })).toBe(true);
  });

  it('rejects a history screen with an invalid view', () => {
    expect(isPersistedScreen({ name: 'history', view: 'bogus' })).toBe(false);
  });

  it('rejects an unknown screen name', () => {
    expect(isPersistedScreen({ name: 'unknown-screen' })).toBe(false);
  });

  it('rejects non-object values', () => {
    expect(isPersistedScreen(null)).toBe(false);
    expect(isPersistedScreen(undefined)).toBe(false);
    expect(isPersistedScreen('search')).toBe(false);
    expect(isPersistedScreen(42)).toBe(false);
  });

  it('rejects an object without a name field', () => {
    expect(isPersistedScreen({ termId: 'api' })).toBe(false);
  });
});
