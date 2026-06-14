import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { apiFetch } from '../api/client';
import { emptyBomSnapshot, type BomAvailabilitySnapshot } from '../utils/bomAvailability';
import type { OfferData } from '../utils/bundleMatcher';

export interface CustomerMenuCategory {
  _id: string;
  sortOrder: number;
  translations: { locale: string; name: string }[];
}

export interface CustomerMenuItem {
  _id: string;
  categoryId: string;
  price: number;
  calories?: number;
  avgWaitMinutes?: number;
  photoUrl?: string;
  arFileUrl?: string;
  isSoldOut?: boolean;
  translations: { locale: string; name: string; description?: string }[];
  allergenIds?: string[];
  optionGroups?: {
    _id: string;
    required: boolean;
    minSelect?: number;
    maxSelect?: number;
    translations: { locale: string; name: string }[];
    choices: { _id: string; extraPrice: number; translations: { locale: string; name: string }[] }[];
  }[];
}

export interface CustomerAllergen {
  _id: string;
  icon: string;
}

type BootstrapState = {
  ready: boolean;
  categories: CustomerMenuCategory[];
  items: CustomerMenuItem[];
  allergens: CustomerAllergen[];
  bomSnapshot: BomAvailabilitySnapshot;
  offers: OfferData[];
};

const emptyState: BootstrapState = {
  ready: false,
  categories: [],
  items: [],
  allergens: [],
  bomSnapshot: emptyBomSnapshot(),
  offers: [],
};

const CustomerMenuBootstrapContext = createContext<BootstrapState>(emptyState);

function asArray<T>(data: unknown): T[] {
  return Array.isArray(data) ? data : [];
}

export function CustomerMenuBootstrapProvider({
  children,
  lang,
}: {
  children: ReactNode;
  lang: string;
}) {
  const [state, setState] = useState<BootstrapState>(emptyState);

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, ready: false }));

    void Promise.all([
      apiFetch(`/api/menu/categories?lang=${encodeURIComponent(lang)}`).then((r) => r.json()),
      apiFetch(`/api/menu/items?lang=${encodeURIComponent(lang)}`).then((r) => r.json()),
      apiFetch('/api/menu/bom-availability').then((r) => (r.ok ? r.json() : emptyBomSnapshot())),
      apiFetch('/api/allergens').then((r) => r.json()),
      apiFetch('/api/offers').then((r) => (r.ok ? r.json() : [])),
    ])
      .then(([categoryData, itemData, bomData, allergenData, offerData]) => {
        if (cancelled) return;
        const bom =
          bomData && typeof bomData === 'object' && 'enabled' in (bomData as object)
            ? (bomData as BomAvailabilitySnapshot)
            : emptyBomSnapshot();
        setState({
          ready: true,
          categories: asArray<CustomerMenuCategory>(categoryData),
          items: asArray<CustomerMenuItem>(itemData),
          allergens: asArray<CustomerAllergen>(allergenData),
          bomSnapshot: bom,
          offers: asArray<OfferData>(offerData),
        });
      })
      .catch(() => {
        if (!cancelled) {
          setState((prev) => ({ ...prev, ready: true }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [lang]);

  return (
    <CustomerMenuBootstrapContext.Provider value={state}>
      {children}
    </CustomerMenuBootstrapContext.Provider>
  );
}

export function useCustomerMenuBootstrap(): BootstrapState {
  return useContext(CustomerMenuBootstrapContext);
}
