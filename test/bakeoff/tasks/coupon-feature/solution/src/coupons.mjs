// Coupon rules: each returns the discount in cents for a subtotal in cents.
const COUPONS = {
  SAVE10: subtotal => Math.floor(subtotal / 10),
  FLAT500: subtotal => Math.min(500, subtotal),
};

export function discountFor(code, subtotal) {
  const rule = COUPONS[String(code).toUpperCase()];
  if (!rule) throw new Error(`Unknown coupon: ${code}`);
  return rule(subtotal);
}
