/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // v1と同じ理由: Electronはビルド後のdist/index.htmlをfile://で読むため相対パスで解決する。
  base: './',
  test: {
    environment: 'jsdom',
    globals: false,
  },
});
