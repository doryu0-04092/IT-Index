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
      // 2026-08-01の品質検証で使った使い捨ての調査spec。Playwrightの既定実行からも
      // 除外済み(playwright.config.ts の testIgnore)で、削除待ちの扱い。lintも見ない。
      'e2e/investigate-*/**',
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
      // アンダースコア始まりは「意図して使わない」ことの表明として許す
      // (例: keystore の互換のため残しているフィールド)。
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
      // effect内の同期setStateは連鎖レンダを招きうるという性能上の注意で、直すには
      // 状態の持ち方の再設計が要る。利用者に見える不具合の証拠が無い段階では既知の負債として
      // warn に留め、CIを塞がない(docs/review/2026-08-09-UI手触り検証.md §5)。新規の増加はレビューで見る。
      'react-hooks/set-state-in-effect': 'warn',
    },
  }
);
