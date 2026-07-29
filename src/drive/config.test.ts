import { describe, expect, it } from 'vitest';
import { getGoogleClientId } from './config';

describe('getGoogleClientId', () => {
  it('returns null when VITE_GOOGLE_CLIENT_ID is not set (Google Cloud setup not done yet)', () => {
    expect(getGoogleClientId()).toBeNull();
  });
});
