import { formatMenuMarketPrice } from '../utils/marketPriceDisplay';
import { menuItemHasDiscount, menuItemSellPriceEuro } from '../utils/menuItemSellPrice';

type Props = {
  price: number;
  discountPrice?: number | null;
  categoryDiscountZhe?: unknown;
  isMarketPrice?: boolean;
  todayPricePerKg?: number | null;
  isEn?: boolean;
};

export default function MenuPriceLabel({
  price,
  discountPrice,
  categoryDiscountZhe,
  isMarketPrice,
  todayPricePerKg,
  isEn = false,
}: Props) {
  if (isMarketPrice) {
    return <span>{formatMenuMarketPrice(todayPricePerKg, isEn)}</span>;
  }
  const sell = menuItemSellPriceEuro({ price, discountPrice }, categoryDiscountZhe);
  if (menuItemHasDiscount({ price, discountPrice }, categoryDiscountZhe)) {
    return (
      <span>
        <span style={{ textDecoration: 'line-through', color: 'var(--text-light, #94a3b8)', fontWeight: 500, fontSize: '0.82em', marginRight: 6 }}>€{price}</span>
        €{sell}
      </span>
    );
  }
  return <span>€{sell}</span>;
}
