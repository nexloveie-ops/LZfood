import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useCustomerMenuBootstrap } from '../../context/CustomerMenuBootstrapContext';
import { useRestaurantConfig } from '../../hooks/useRestaurantConfig';
import { useStoreSlug } from '../../context/StoreContext';
import { resolveBackendAssetUrl } from '../../utils/backendPublicUrl';
import StorePreloader from './StorePreloader';

const MIN_VISIBLE_MS = 800;

export default function StorePreloaderGate({ children }: { children: ReactNode }) {
  const { ready } = useCustomerMenuBootstrap();
  const { config, displayName, configLoading } = useRestaurantConfig();
  const storeSlug = useStoreSlug();
  const { i18n } = useTranslation();
  const [visible, setVisible] = useState(true);
  const startedAtRef = useRef(Date.now());

  useEffect(() => {
    startedAtRef.current = Date.now();
    setVisible(true);
  }, [storeSlug, i18n.language]);

  useEffect(() => {
    if (configLoading || !ready) return;
    const elapsed = Date.now() - startedAtRef.current;
    const remaining = Math.max(0, MIN_VISIBLE_MS - elapsed);
    const timer = window.setTimeout(() => setVisible(false), remaining);
    return () => window.clearTimeout(timer);
  }, [configLoading, ready]);

  const rawLogo = config.restaurant_logo?.trim();
  const logoUrl = rawLogo ? resolveBackendAssetUrl(rawLogo) : '';

  return (
    <>
      <StorePreloader
        visible={visible}
        logoUrl={logoUrl}
        storeName={displayName || storeSlug}
      />
      {children}
    </>
  );
}
