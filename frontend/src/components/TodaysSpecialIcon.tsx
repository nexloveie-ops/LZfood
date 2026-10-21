/** 今日特色：红色「特」标，放在菜名前 */
export default function TodaysSpecialIcon({
  size = 16,
  title,
}: {
  size?: number;
  title?: string;
}) {
  const fontSize = Math.max(9, Math.round(size * 0.62));
  return (
    <span
      className="todays-special-icon"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: Math.max(3, Math.round(size * 0.22)),
        background: '#C41E24',
        color: '#fff',
        fontSize,
        fontWeight: 800,
        lineHeight: 1,
        letterSpacing: 0,
        boxShadow: '0 0 0 1px rgba(139,16,20,0.25)',
      }}
    >
      特
    </span>
  );
}
