export interface SkeletonProps {
  /** 生成する行数 */
  lines?: number;
}

/** データ読み込み中に内容の大まかな形を示すプレースホルダー（シマー効果付き） */
export default function Skeleton({ lines = 3 }: SkeletonProps) {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="skeleton-line" />
      ))}
    </div>
  );
}
