// Hidden acceptance check: never copied into the scratch project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const project = process.env.BAKEOFF_PROJECT;
const { total } = await import(pathToFileURL(join(project, 'src/cart.mjs')).href);
const apples = [{ sku: 'apple', quantity: 3 }];
const big = [{ sku: 'cheese', quantity: 1 }, { sku: 'bread', quantity: 1 }];

test('coupons live in their own module', () => assert.ok(existsSync(join(project, 'src/coupons.mjs'))));

test('no coupon keeps the total', () => {
  assert.equal(total(apples), 360);
  assert.equal(total(apples, {}), 360);
});

test('SAVE10 takes 10% off, discount rounded down to whole cents', () => {
  assert.equal(total(apples, { coupon: 'SAVE10' }), 324);
  assert.equal(total([{ sku: 'cheese', quantity: 1 }], { coupon: 'SAVE10' }), 810);
  assert.equal(total(apples, { coupon: 'save10' }), 324);
});

test('FLAT500 takes 500 cents off, never below zero', () => {
  assert.equal(total(big, { coupon: 'FLAT500' }), 649);
  assert.equal(total(apples, { coupon: 'Flat500' }), 0);
});

test('unknown coupon throws with the code in the message', () => {
  assert.throws(() => total(apples, { coupon: 'BOGUS' }), /BOGUS/);
});
