/**
 * Script to calculate entry prices for YB signal with extend values from 0 to 100
 */

import { calculateLongEntryPrice, calculateShortEntryPrice } from '../src/utils/calculator.js';

console.log('='.repeat(100));
console.log('Entry Price Calculation for YB Signal');
console.log('='.repeat(100));
console.log();

// Example from user: YB signal
const open = 0.3759;
const current = 0.45096606;
const delta = Math.abs(current - open);

console.log('📊 Input Parameters:');
console.log(`   Open:    ${open}`);
console.log(`   Current: ${current}`);
console.log(`   Delta:   ${delta.toFixed(8)} (abs(current - open))`);
console.log();

console.log('='.repeat(100));
console.log('COUNTER-TREND Strategy (is_reverse_strategy = true)');
console.log('='.repeat(100));
console.log('Formula:');
console.log('  LONG:  entry = current - extendRatio * delta');
console.log('  SHORT: entry = current + extendRatio * delta');
console.log('  where extendRatio = extend / 100');
console.log();
console.log('┌─────────┬──────────────────────┬──────────────────────┬──────────────────────┐');
console.log('│ Extend  │   LONG Entry         │   SHORT Entry       │   Difference         │');
console.log('│   (%)   │   (entry < current)  │   (entry > current) │   (vs current)       │');
console.log('├─────────┼──────────────────────┼──────────────────────┼──────────────────────┤');

// Calculate for extend values: 0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100
const extendValues = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

for (const extend of extendValues) {
  const longEntry = calculateLongEntryPrice(current, open, extend);
  const shortEntry = calculateShortEntryPrice(current, open, extend);
  const longDiff = current - longEntry;
  const shortDiff = shortEntry - current;
  
  console.log(
    `│ ${String(extend).padStart(7)} │ ` +
    `${longEntry.toFixed(8).padStart(20)} │ ` +
    `${shortEntry.toFixed(8).padStart(20)} │ ` +
    `LONG: ${longDiff.toFixed(8).padStart(12)} │`
  );
}

console.log('└─────────┴──────────────────────┴──────────────────────┴──────────────────────┘');
console.log();

console.log('='.repeat(100));
console.log('TREND-FOLLOWING Strategy (is_reverse_strategy = false)');
console.log('='.repeat(100));
console.log('Formula:');
console.log('  LONG:  entry = current (always)');
console.log('  SHORT: entry = current (always)');
console.log('  Order Type: MARKET');
console.log();
console.log(`  Entry Price: ${current.toFixed(8)} (regardless of extend value)`);
console.log();

console.log('='.repeat(100));
console.log('📋 Detailed Analysis');
console.log('='.repeat(100));
console.log();

// Show some key examples
const keyExtends = [0, 50, 60, 100];
for (const extend of keyExtends) {
  const longEntry = calculateLongEntryPrice(current, open, extend);
  const shortEntry = calculateShortEntryPrice(current, open, extend);
  const extendRatio = extend / 100;
  const longOffset = extendRatio * delta;
  const shortOffset = extendRatio * delta;
  
  console.log(`Extend = ${extend}% (extendRatio = ${extendRatio}):`);
  console.log(`  LONG Entry:`);
  console.log(`    Formula: ${current.toFixed(8)} - ${extendRatio} × ${delta.toFixed(8)} = ${longEntry.toFixed(8)}`);
  console.log(`    Offset:  -${longOffset.toFixed(8)} (${((longOffset / current) * 100).toFixed(4)}% below current)`);
  console.log(`  SHORT Entry:`);
  console.log(`    Formula: ${current.toFixed(8)} + ${extendRatio} × ${delta.toFixed(8)} = ${shortEntry.toFixed(8)}`);
  console.log(`    Offset:  +${shortOffset.toFixed(8)} (${((shortOffset / current) * 100).toFixed(4)}% above current)`);
  console.log();
}

console.log('='.repeat(100));
console.log('💡 Key Insights');
console.log('='.repeat(100));
console.log();
console.log('1. Counter-Trend (is_reverse_strategy = true):');
console.log('   - Extend = 0%:   Entry = current (no pullback)');
console.log('   - Extend = 50%:  Entry = midpoint between open and current');
console.log('   - Extend = 100%: Entry = open (full pullback)');
console.log('   - LONG entry decreases as extend increases');
console.log('   - SHORT entry increases as extend increases');
console.log();
console.log('2. Trend-Following (is_reverse_strategy = false):');
console.log('   - Entry always equals current price');
console.log('   - Extend value is ignored');
console.log('   - Uses MARKET order to avoid "order would immediately trigger" error');
console.log();

console.log('='.repeat(100));
console.log('✅ Calculation complete!');
console.log('='.repeat(100));

