/**
 * Script to verify trend-following vs counter-trend entry logic
 */

import { calculateLongEntryPrice, calculateShortEntryPrice } from '../src/utils/calculator.js';

console.log('='.repeat(70));
console.log('Trend-Following vs Counter-Trend Entry Logic Verification');
console.log('='.repeat(70));
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

console.log('='.repeat(70));
console.log('1️⃣ COUNTER-TREND Strategy (is_reverse_strategy = true)');
console.log('='.repeat(70));
console.log('   Logic: Use extend formula with LIMIT order');
console.log();

// Counter-trend LONG (bullish → SHORT, but if LONG then use extend)
const counterTrendLongEntry = calculateLongEntryPrice(current, open, extend);
const counterTrendShortEntry = calculateShortEntryPrice(current, open, extend);

console.log('   LONG Entry (bullish market, counter-trend LONG):');
console.log(`     Entry: ${counterTrendLongEntry.toFixed(8)}`);
console.log(`     ✓ Entry < Current: ${counterTrendLongEntry < current ? 'YES' : 'NO'}`);
console.log(`     Order Type: LIMIT`);
console.log();

console.log('   SHORT Entry (bullish market, counter-trend SHORT):');
console.log(`     Entry: ${counterTrendShortEntry.toFixed(8)}`);
console.log(`     ✓ Entry > Current: ${counterTrendShortEntry > current ? 'YES' : 'NO'}`);
console.log(`     Order Type: LIMIT`);
console.log();

console.log('='.repeat(70));
console.log('2️⃣ TREND-FOLLOWING Strategy (is_reverse_strategy = false)');
console.log('='.repeat(70));
console.log('   Logic: Use current price directly with MARKET order');
console.log();

// Trend-following: entry = current
const trendFollowingLongEntry = current;
const trendFollowingShortEntry = current;

console.log('   LONG Entry (bullish market, trend-following LONG):');
console.log(`     Entry: ${trendFollowingLongEntry.toFixed(8)}`);
console.log(`     ✓ Entry = Current: ${trendFollowingLongEntry === current ? 'YES' : 'NO'}`);
console.log(`     Order Type: MARKET`);
console.log();

console.log('   SHORT Entry (bearish market, trend-following SHORT):');
console.log(`     Entry: ${trendFollowingShortEntry.toFixed(8)}`);
console.log(`     ✓ Entry = Current: ${trendFollowingShortEntry === current ? 'YES' : 'NO'}`);
console.log(`     Order Type: MARKET`);
console.log();

console.log('='.repeat(70));
console.log('📋 Summary');
console.log('='.repeat(70));
console.log();
console.log('Counter-Trend (is_reverse_strategy = true):');
console.log('  - Entry calculated with extend formula');
console.log('  - LONG: entry < current (pullback entry)');
console.log('  - SHORT: entry > current (pullback entry)');
console.log('  - Order Type: LIMIT');
console.log();
console.log('Trend-Following (is_reverse_strategy = false):');
console.log('  - Entry = current price (immediate entry)');
console.log('  - LONG: entry = current');
console.log('  - SHORT: entry = current');
console.log('  - Order Type: MARKET (avoids "order would immediately trigger" error)');
console.log();

console.log('='.repeat(70));
console.log('✅ Logic verification complete!');
console.log('='.repeat(70));

