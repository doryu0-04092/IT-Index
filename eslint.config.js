// @ts-check
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default tseslint.config(
  {
    // ビルド成果物は lint 対象にしない。flat config は .gitignore を参照しないため、
    // ここに書かない限り Android/Electron のビルド出力（minify 済みバンドル）まで検査され、
    // 実コードの指摘がその中に埋没する（2026-08-09: 全16677件中16648件が成果物由来だった）。
    ignores: [
      'dist/**',
      'node_modules/**',
      'docs/review/logs/playwright-report/**',
      'e2e/**/*-snapshots/**',
      'android/app/build/**',
      'android/app/src/main/assets/**',
      'dist-electron/**',
      'release/**',
      'test-results/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
    },
  }
);
