#!/usr/bin/env node
'use strict';

/**
 * unit.js — Unit tests for matching engine helper functions.
 * Uses Node's built-in assert module (no test framework needed).
 *
 * Usage:
 *   node test/unit.js
 */

const assert = require('assert');
const { typesMatch, quantitiesMatch, timestampsMatch } = require('../src/matching/engine');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// typesMatch
// ---------------------------------------------------------------------------
console.log('\n--- typesMatch ---');

test('equal types (BUY)', () => {
  assert.strictEqual(typesMatch('BUY', 'BUY'), true);
});
test('equal types (case-insensitive)', () => {
  assert.strictEqual(typesMatch('sell', 'SELL'), true);
});
test('TRANSFER_IN ↔ TRANSFER_OUT', () => {
  assert.strictEqual(typesMatch('TRANSFER_IN', 'TRANSFER_OUT'), true);
  assert.strictEqual(typesMatch('TRANSFER_OUT', 'TRANSFER_IN'), true);
});
test('mismatched types', () => {
  assert.strictEqual(typesMatch('BUY', 'SELL'), false);
});
test('null inputs', () => {
  assert.strictEqual(typesMatch(null, 'BUY'), false);
  assert.strictEqual(typesMatch('BUY', null), false);
  assert.strictEqual(typesMatch(null, null), false);
});

// ---------------------------------------------------------------------------
// quantitiesMatch
// ---------------------------------------------------------------------------
console.log('\n--- quantitiesMatch ---');

test('exact match', () => {
  assert.strictEqual(quantitiesMatch(1.0, 1.0, 0.01), true);
});
test('within 1% tolerance', () => {
  assert.strictEqual(quantitiesMatch(1.0, 1.005, 0.01), true);
});
test('outside 1% tolerance', () => {
  assert.strictEqual(quantitiesMatch(1.0, 1.02, 0.01), false);
});
test('both zero', () => {
  assert.strictEqual(quantitiesMatch(0, 0, 0.01), true);
});
test('one null', () => {
  assert.strictEqual(quantitiesMatch(null, 1.0, 0.01), false);
  assert.strictEqual(quantitiesMatch(1.0, null, 0.01), false);
});
test('both null', () => {
  assert.strictEqual(quantitiesMatch(null, null, 0.01), false);
});
test('large values within tolerance', () => {
  assert.strictEqual(quantitiesMatch(10000, 10099, 0.01), true);
});
test('large values outside tolerance', () => {
  assert.strictEqual(quantitiesMatch(10000, 10200, 0.01), false);
});

// ---------------------------------------------------------------------------
// timestampsMatch
// ---------------------------------------------------------------------------
console.log('\n--- timestampsMatch ---');

const t0 = new Date('2024-01-15T10:00:00Z');
const t5 = new Date('2024-01-15T10:00:05Z');    // 5s later
const t300 = new Date('2024-01-15T10:05:00Z'); // 300s later
const t301 = new Date('2024-01-15T10:05:01Z'); // 301s later

test('exact same timestamp', () => {
  assert.strictEqual(timestampsMatch(t0, t0, 300), true);
});
test('within 300s tolerance', () => {
  assert.strictEqual(timestampsMatch(t0, t300, 300), true);
});
test('just outside tolerance (301s)', () => {
  assert.strictEqual(timestampsMatch(t0, t301, 300), false);
});
test('5 seconds apart, tolerance 300', () => {
  assert.strictEqual(timestampsMatch(t0, t5, 300), true);
});
test('null timestamp A', () => {
  assert.strictEqual(timestampsMatch(null, t0, 300), false);
});
test('null timestamp B', () => {
  assert.strictEqual(timestampsMatch(t0, null, 300), false);
});
test('both null', () => {
  assert.strictEqual(timestampsMatch(null, null, 300), false);
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
