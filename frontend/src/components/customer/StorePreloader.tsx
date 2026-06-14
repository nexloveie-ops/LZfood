import './store-preloader.css';

type StorePreloaderProps = {
  visible: boolean;
  logoUrl?: string;
  storeName: string;
};

export default function StorePreloader({ visible, logoUrl, storeName }: StorePreloaderProps) {
  const initial = (storeName || '?').trim().slice(0, 1).toUpperCase();

  return (
    <div
      className={`store-preloader ${visible ? '' : 'store-preloader--done'}`.trim()}
      aria-hidden={!visible}
      aria-busy={visible}
      role="status"
    >
      <div className="store-preloader__inner">
        <div className="store-preloader__logo-wrap">
          {logoUrl ? (
            <img src={logoUrl} alt="" className="store-preloader__logo" decoding="async" />
          ) : (
            <span className="store-preloader__fallback" aria-hidden>
              {initial}
            </span>
          )}
        </div>
        {storeName ? <div className="store-preloader__name">{storeName}</div> : null}
        <span className="store-preloader__spinner" />
      </div>
    </div>
  );
}
