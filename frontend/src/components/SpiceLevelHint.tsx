import { useTranslation } from 'react-i18next';

export type SpiceLevel = 0 | 1 | 2 | 3;

export function clampSpiceLevel(raw: unknown): SpiceLevel {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 0;
  if (n >= 3) return 3;
  return n as 1 | 2 | 3;
}

/** 菜单辣度：1–3 个辣椒；0 / 缺省不渲染 */
export default function SpiceLevelHint({ level }: { level?: number | null }) {
  const { t } = useTranslation();
  const n = clampSpiceLevel(level);
  if (n < 1) return null;
  const title =
    n === 1 ? t('customer.spiceMild') : n === 2 ? t('customer.spiceMedium') : t('customer.spiceHot');
  return (
    <span
      className="spice-level-hint"
      aria-label={title}
      title={title}
      style={{
        display: 'inline-flex',
        flexShrink: 0,
        letterSpacing: '-2px',
        lineHeight: 1,
        fontSize: '0.95em',
      }}
    >
      {'🌶️'.repeat(n)}
    </span>
  );
}
