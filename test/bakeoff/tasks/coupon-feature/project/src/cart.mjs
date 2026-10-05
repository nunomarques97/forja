import { priceOf } from './catalog.mjs';

// Cart total in cents.
export function total(items) {
  return items.reduce((sum, item) => sum + priceOf(item.sku) * item.quantity, 0);
}
