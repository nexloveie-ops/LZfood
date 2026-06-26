import { useTranslation } from 'react-i18next';

const PLATFORM_CONTACT_EMAIL = 'info@lztechserve.com';

type Props = {
  variant?: 'onGradient' | 'onLight';
  /** 左侧店铺名（与当前语言一致）；不传则仅右侧平台署名 */
  storeTitle?: string;
  /** 另一语言店名等副文案 */
  storeSubtitle?: string;
};

/** 点餐流程横幅顶栏：可选左侧店铺信息 + 右侧 L&Z Techserve LTD / 联系邮箱 */
export default function BannerPlatformCredit({
  variant = 'onGradient',
  storeTitle,
  storeSubtitle,
}: Props) {
  const { t, i18n } = useTranslation();
  const email = PLATFORM_CONTACT_EMAIL;
  const onLight = variant === 'onLight';
  const lang = i18n.language || '';
  const wb = lang.startsWith('zh')
    ? { wordBreak: 'keep-all' as const }
    : { overflowWrap: 'break-word' as const };

  return (
    <div
      style={{
        position: 'absolute',
        top: 8,
        left: 12,
        right: 12,
        zIndex: 20,
        display: 'flex',
        justifyContent: storeTitle ? 'space-between' : 'flex-end',
        alignItems: 'flex-start',
        gap: 12,
        pointerEvents: 'none',
      }}
    >
      {storeTitle ? (
        <div
          style={{
            flex: '1 1 auto',
            minWidth: 0,
            maxWidth: 'min(52%, 58vw)',
            textAlign: 'left',
            fontSize: 9,
            lineHeight: 1.45,
            pointerEvents: 'auto',
            ...wb,
          }}
        >
          <div
            style={{
              fontWeight: 700,
              fontSize: 12,
              lineHeight: 1.3,
              fontFamily: "'Noto Serif SC', serif",
              marginBottom: storeSubtitle ? 2 : 0,
              ...(onLight
                ? { color: 'var(--text-dark)' }
                : { color: '#fff' }),
            }}
          >
            {storeTitle}
          </div>
          {storeSubtitle ? (
            <div
              style={{
                fontSize: 9,
                fontWeight: 500,
                lineHeight: 1.35,
                opacity: 0.95,
                ...(onLight
                  ? { color: 'var(--text-secondary)' }
                  : { color: '#F0D68A' }),
                ...wb,
              }}
            >
              {storeSubtitle}
            </div>
          ) : null}
        </div>
      ) : null}
      <div
        style={{
          flexShrink: 0,
          textAlign: 'right',
          fontSize: 9,
          lineHeight: 1.45,
          maxWidth: storeTitle ? 'min(200px, 44vw)' : 'min(220px, 48vw)',
          pointerEvents: 'auto',
        }}
      >
        <div
          style={{
            fontWeight: 700,
            marginBottom: 2,
            color: onLight ? 'var(--text-dark)' : '#F0D68A',
          }}
        >
          {t('customer.footerCompany')}
        </div>
        <div>
          <a
            href={`mailto:${email}`}
            style={{
              color: onLight ? 'var(--blue, #1565c0)' : '#F0D68A',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            {email}
          </a>
        </div>
      </div>
    </div>
  );
}
