import type { UiSet } from '../uiSet';
import ChatScreen from './ChatScreen';
import HistoryScreen from './HistoryScreen';
import LinkModal from './LinkModal';
import OnboardingModal from './OnboardingModal';
import SearchScreen from './SearchScreen';
import SettingsModal from './SettingsModal';
import TermDetailScreen from './TermDetailScreen';
import Toast from './Toast';
import TopNav from './TopNav';

/** Android（タップ操作・狭い画面幅）向けの画面一式。CSSは .android-app 配下に限定してある */
export const androidUi: UiSet = {
  rootClassName: 'android-app',
  ChatScreen,
  HistoryScreen,
  LinkModal,
  OnboardingModal,
  SearchScreen,
  SettingsModal,
  TermDetailScreen,
  Toast,
  TopNav,
};
