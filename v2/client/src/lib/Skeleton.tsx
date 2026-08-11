/**
 * ローディングスケルトン(移植元: ../../../src/index.css .skeleton/.skeleton-line。
 * v1にReactコンポーネントは無く素の<div>だったため、クラス名だけ移植しコンポーネント化する)。
 * 3本線でパルスさせる(App.css側の@keyframes skeleton-shimmer)。
 */
export default function Skeleton() {
  return (
    <div className="skeleton" aria-hidden="true">
      <div className="skeleton-line" />
      <div className="skeleton-line" />
      <div className="skeleton-line" />
    </div>
  );
}
