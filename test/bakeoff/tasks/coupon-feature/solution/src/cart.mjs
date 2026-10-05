import { priceOf } from './catalog.mjs';
import { discountFor } from './coupons.mjs';

// Cart total in cents.
export function total(items, { coupon } = {}) {
  const subtotal = items.reduce((sum, item) => sum + priceOf(item.sku) * item.quantity, 0);
  return coupon === undefined ? subtotal : subtotal - discountFor(coupon, subtotal);
}
