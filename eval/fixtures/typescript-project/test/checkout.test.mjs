import assert from 'node:assert/strict';
import test from 'node:test';
import { checkoutTotal } from '../src/checkout.mjs';

test('adds tax to the subtotal', () => {
  assert.equal(checkoutTotal(100, 0.1), 110);
});
