import type ChatScreen from './pc/ChatScreen';
import type HistoryScreen from './pc/HistoryScreen';
import type LinkModal from './pc/LinkModal';
import type OnboardingModal from './pc/OnboardingModal';
import type SearchScreen from './pc/SearchScreen';
import type SettingsModal from './pc/SettingsModal';
import type TermDetailScreen from './pc/TermDetailScreen';
import type Toast from './pc/Toast';
import type TopNav from './pc/TopNav';

/**
 * プラットフォームごとに差し替える画面コンポーネント一式。
 *
 * PC版とAndroid版は独立したコンポーネント一式として作る（docs/ui-pc.md:8）が、
 * **統括ロジック（App.tsx）は共有する**。以前はAndroid版のApp.tsxを別に持っていたが、
 * シード取り込み・確定オーケストレーション・画面遷移・認証バナーという同じ処理が
 * 2箇所に並存する形になり、docs/ui-pc.md §3 バグ9「同じ意味の状態を複数箇所に
 * 別々に持つと、片方だけ更新される経路が必ず生まれる」と同じ構造の危険があった。
 *
 * 型をPC版のコンポーネントから導出しているため、**Android版のpropsがPC版と
 * ずれると型エラーになる**。差し替え可能であることをコンパイル時に強制する。
 */
export interface UiSet {
  /** ルート要素に足すクラス名。Android版のCSSは .android-app 配下に限定してある */
  rootClassName?: string;
  ChatScreen: typeof ChatScreen;
  HistoryScreen: typeof HistoryScreen;
  LinkModal: typeof LinkModal;
  OnboardingModal: typeof OnboardingModal;
  SearchScreen: typeof SearchScreen;
  SettingsModal: typeof SettingsModal;
  TermDetailScreen: typeof TermDetailScreen;
  Toast: typeof Toast;
  TopNav: typeof TopNav;
}
