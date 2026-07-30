import { calculateTax } from './tax.mjs';

export function checkoutTotal(subtotal, rate) {
  return subtotal - calculateTax(subtotal, rate);
}
