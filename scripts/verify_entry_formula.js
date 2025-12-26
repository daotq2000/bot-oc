/**
 * Script to verify the new entry price formula
 * Example: YB signal with extend 60%
 */

import { calculateLongEntryPrice, calculateShortEntryPrice } from '../src/utils/calculator.js';

console.log('='.repeat(60));
console.log('Entry Price Formula Verification');
console.log('='.repeat(60));
console.log();

// Example from user: YB signal
const open = 0.3759;
const current = 0.45096606;
const extend = 60; // 60%

console.log('📊 Input Parameters:');
console.log(`   Open:    ${open}`);
console.log(`   Current: ${current}`);
console.log(`   Extend:  ${extend}%`);
console.log();

// Calculate delta
const delta = Math.abs(current - open);
const extendRatio = extend / 100;

console.log('📐 Calculations:');
console.log(`   Delta:       ${delta.toFixed(8)}`);
console.log(`   ExtendRatio: ${extendRatio}`);
console.log();

// LONG entry
const longEntry = calculateLongEntryPrice(current, open, extend);
const longExpected = current - extendRatio * delta;

console.log('🟢 LONG Entry (entry < current):');
console.log(`   Formula: entry = current - extendRatio * delta`);
console.log(`   Entry:   ${longEntry.toFixed(8)}`);
console.log(`   Expected: ${longExpected.toFixed(8)}`);
console.log(`   ✓ Entry < Current: ${longEntry < current ? 'YES' : 'NO'}`);
console.log(`   ✓ Entry > Open: ${longEntry > open ? 'YES' : 'NO'}`);
console.log();

// SHORT entry
const shortEntry = calculateShortEntryPrice(current, open, extend);
const shortExpected = current + extendRatio * delta;

console.log('🔴 SHORT Entry (entry > current):');
console.log(`   Formula: entry = current + extendRatio * delta`);
console.log(`   Entry:   ${shortEntry.toFixed(8)}`);
console.log(`   Expected: ${shortExpected.toFixed(8)}`);
console.log(`   ✓ Entry > Current: ${shortEntry > current ? 'YES' : 'NO'}`);
console.log();

console.log('='.repeat(60));
console.log('✅ Formula verification complete!');
console.log('='.repeat(60));

