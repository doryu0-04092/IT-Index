/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // v1と同じ理由: Electronはビルド後のdist/index.htmlをfile://で読むため相対パスで解決する。
  base: './',
  test: {
    environment: 'jsdom',
    // 非同期待ちの予算をここで一括設定する(#204)。理由と実測は src/test-setup.ts を参照
    setupFiles: ['./src/test-setup.ts'],
    globals: false,
  },
});
