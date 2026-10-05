// Unit prices in cents.
const PRICES = { apple: 120, bread: 250, cheese: 899 };

export function priceOf(sku) {
  if (!Object.hasOwn(PRICES, sku)) throw new Error(`Unknown product: ${sku}`);
  return PRICES[sku];
}
