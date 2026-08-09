import { useCallback, useState } from 'react';
import './App.css';
import { db } from './db';
import { backScreenFor, screenKey, type DetailFrom, type Screen } from './navigation';
import SearchScreen from './screens/SearchScreen';
import SyncScreen from './screens/SyncScreen';
import TermDetailScreen from './screens/TermDetailScreen';
import TermIndexScreen from './screens/TermIndexScreen';
import WeightedScreen from './screens/WeightedScreen';
import { useAppInit } from './useAppInit';

type NavTarget = 'search' | 'index' | 'weighted' | 'sync';

function navLabel(target: NavTarget): string {
  switch (target) {
    case 'search':
      return '検索';
    case 'index':
      return '索引';
    case 'weighted':
      return '重み付け';
    case 'sync':
      return '同期';
  }
}

/**
 * 統括(画面遷移・DB初期化・シード取り込みのオーケストレーション)を担う。
 * v1のApp.tsx(659行、AI/同期/認証まで抱えて責務が集中していた)を繰り返さないため、
 * DB初期化・シード取り込みはuseAppInit.tsへ、画面遷移の型はnavigation.tsへ分離する
 * (docs/v2/architecture.md §8)。単一レスポンシブUIのため画面はPC/スマホで分けず、
 * ルーターも追加せずstate(Screen)だけで遷移する(要件定義書§4.1)。
 */
export function App() {
  const {
    termsRepo,
    notesRepo,
    asksRepo,
    noteConflictsRepo,
    syncStateRepo,
    deviceId,
    seedError,
    seedSettled,
    seedRefreshTick,
    runSeedImport,
  } = useAppInit();
  const [screen, setScreen] = useState<Screen>({ name: 'search' });

  // 要件定義書§4.1「ローカル検索の確定」。検索・索引・重み付けのいずれから選んで
  // 単語詳細を開いた場合も「確定」として記録する(v1のApp.tsx openDetail相当。
  // AIチャット確定(source:'ai')より弱い重みで加算される。core/computeWeights.ts)。
  const openDetail = useCallback(
    (termId: string, from: DetailFrom) => {
      if (deviceId) {
        void asksRepo.addSearchConfirm(termId, deviceId, Date.now());
      }
      setScreen({ name: 'detail', termId, from });
    },
    [asksRepo, deviceId],
  );

  function handleTermDeleted() {
    setScreen({ name: 'search' });
  }

  const navCurrent: NavTarget | null =
    screen.name === 'search' || screen.name === 'index' || screen.name === 'weighted' || screen.name === 'sync'
      ? screen.name
      : null;

  return (
    <div className="app">
      <header className="app-header">
        <h1>IT-Index v2</h1>
        <nav className="app-nav" aria-label="画面切り替え">
          {(['search', 'index', 'weighted', 'sync'] as const).map((target) => (
            <button
              key={target}
              type="button"
              className={navCurrent === target ? 'app-nav-link app-nav-link-active' : 'app-nav-link'}
              onClick={() => setScreen({ name: target } as Screen)}
              aria-current={navCurrent === target ? 'page' : undefined}
            >
              {navLabel(target)}
            </button>
          ))}
        </nav>
      </header>

      <main key={screenKey(screen)} className="app-main">
        {!seedSettled ? (
          <p className="status-text">辞書を読み込み中です…</p>
        ) : screen.name === 'search' ? (
          <SearchScreen
            termsRepo={termsRepo}
            onSelectTerm={(termId) => openDetail(termId, 'search')}
            seedError={seedError}
            seedRefreshTick={seedRefreshTick}
            onRetrySeed={() => void runSeedImport()}
          />
        ) : screen.name === 'index' ? (
          <TermIndexScreen termsRepo={termsRepo} onSelectTerm={(termId) => openDetail(termId, 'index')} />
        ) : screen.name === 'weighted' ? (
          <WeightedScreen asksRepo={asksRepo} termsRepo={termsRepo} onSelectTerm={(termId) => openDetail(termId, 'weighted')} />
        ) : screen.name === 'sync' ? (
          <SyncScreen
            db={db}
            deviceId={deviceId}
            termsRepo={termsRepo}
            notesRepo={notesRepo}
            asksRepo={asksRepo}
            noteConflictsRepo={noteConflictsRepo}
            syncStateRepo={syncStateRepo}
          />
        ) : (
          <TermDetailScreen
            termId={screen.termId}
            termsRepo={termsRepo}
            notesRepo={notesRepo}
            deviceId={deviceId}
            onBack={() => setScreen(backScreenFor(screen.from))}
            onDeleted={handleTermDeleted}
          />
        )}
      </main>
    </div>
  );
}
