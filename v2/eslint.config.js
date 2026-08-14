// @ts-check
// v2ワークスペース専用のlint設定。ルールはv1(../eslint.config.js)と同水準に揃える。
// ルート側のlintはv2/**をignoresで除外しており、v2はCIのv2ジョブが検査する。
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default tseslint.config(
  {
    // flat configは.gitignoreを参照しないため、成果物はここで明示的に除外する
    // (v1で成果物混入がlintを機能不全にした再発防止)。
    // client/android/**: `npx cap sync`がWebビルド成果物(minifyされたJSバンドル)を
    // android/app/src/main/assets/public、ビルド生成物をandroid/app/buildへコピーする。
    // ルート側のeslint.config.js(android/app/build/**・android/app/src/main/assets/**)と
    // 同じ理由(2026-08-09: 全16677件中16648件が成果物由来だった)でv2側も除外する。
    ignores: ['**/dist/**', '**/node_modules/**', 'test-results/**', 'client/android/**'],
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
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
    },
  }
);
