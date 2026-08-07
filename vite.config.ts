/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Electronはビルド後のdist/index.htmlをfile://で読むため、
  // 絶対パス('/assets/...')ではなく相対パスでアセットを解決する必要がある。
  base: './',
  test: {
    environment: 'node',
    globals: false,
    setupFiles: ['./src/test-setup.ts'],
    exclude: ['**/node_modules/**', '**/e2e/**'],
  },
});
