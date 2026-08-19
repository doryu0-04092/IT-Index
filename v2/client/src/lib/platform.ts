/**
 * プラットフォーム判定(#157)。「Androidネイティブ(Capacitorアプリ)かどうか」だけを返す。
 * PCブラウザ・スマートフォンのブラウザはどちらもfalse(=PC側扱い。競合解消が可能)。
 *
 * 動的import + try/catchはmain.tsxの起動フックと同じ理由: `@capacitor/core`が読み込めない
 * 環境(将来clientをCapacitor無しで単体配布する等)でも起動を失敗させない。
 */
export async function detectIsNativeApp(): Promise<boolean> {
  try {
    const { Capacitor } = await import('@capacitor/core');
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}
