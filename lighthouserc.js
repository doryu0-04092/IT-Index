module.exports = {
  ci: {
    collect: {
      url: ['http://localhost:4173/'],
      startServerCommand: 'npm run preview -- --port 4173',
      numberOfRuns: 3, // 単発計測は誤結論を生む
      settings: { preset: 'desktop' },
    },
    assert: {
      assertions: {
        'categories:performance': ['error', { minScore: 0.9 }],
        'categories:accessibility': ['error', { minScore: 0.9 }],
        'categories:best-practices': ['warn', { minScore: 0.9 }],
      },
    },
    // 社内/個人アプリのURL・画面が外部の公開ストレージに出るのを避ける
    upload: { target: 'filesystem', outputDir: './docs/review/logs/lhci-report' },
  },
};
