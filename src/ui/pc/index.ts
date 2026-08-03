import type { UiSet } from '../uiSet';
import ChatScreen from './ChatScreen';
import HistoryScreen from './HistoryScreen';
import LinkModal from './LinkModal';
import OnboardingModal from './OnboardingModal';
import SearchScreen from './SearchScreen';
import SettingsModal from './SettingsModal';
import TermDetailScreen from './TermDetailScreen';
import TermIndexScreen from './TermIndexScreen';
import Toast from './Toast';
import TopNav from './TopNav';

/** ブラウザ・Electron（マウス／キーボード前提）向けの画面一式 */
export const pcUi: UiSet = {
  ChatScreen,
  HistoryScreen,
  LinkModal,
  OnboardingModal,
  SearchScreen,
  SettingsModal,
  TermDetailScreen,
  TermIndexScreen,
  Toast,
  TopNav,
};
