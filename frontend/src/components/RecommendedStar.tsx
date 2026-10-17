/** 店家推荐菜：金色星星，放在菜名前（inline-block，避免被名字 overflow 裁掉） */
export default function RecommendedStar({
  size = 16,
  title,
}: {
  size?: number;
  title?: string;
}) {
  return (
    <span
      className="recommended-star"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        flexShrink: 0,
        width: size,
        height: size,
        lineHeight: 1,
        color: '#E8B923',
        fontSize: size,
        filter: 'drop-shadow(0 0 0.5px #C99212)',
      }}
    >
      ★
    </span>
  );
}
