#!/usr/bin/env node

/**
 * Script to test PositionSync side determination logic
 * 
 * Usage:
 *   node scripts/test_position_sync_side.js
 */

console.log('\n' + '='.repeat(80));
console.log('POSITION SYNC SIDE DETERMINATION TEST');
console.log('='.repeat(80) + '\n');

// Simulate the logic from PositionSync.js
function determineSide(exPos) {
  const rawAmt = parseFloat(exPos.positionAmt ?? exPos.contracts ?? exPos.size ?? 0);
  const side = rawAmt > 0 ? 'long' : rawAmt < 0 ? 'short' : null;
  const contracts = Math.abs(rawAmt); // Absolute value AFTER determining side
  
  return { rawAmt, side, contracts };
}

// Test cases
const testCases = [
  { name: 'SHORT position (negative)', positionAmt: -100, contracts: 100, size: -100 },
  { name: 'LONG position (positive)', positionAmt: 100, contracts: 100, size: 100 },
  { name: 'SHORT position (contracts negative)', contracts: -50, positionAmt: -50 },
  { name: 'LONG position (contracts positive)', contracts: 50, positionAmt: 50 },
  { name: 'SHORT position (size negative)', size: -200, positionAmt: -200 },
  { name: 'LONG position (size positive)', size: 200, positionAmt: 200 },
  { name: 'Zero position', positionAmt: 0, contracts: 0 },
  { name: 'Missing positionAmt, use contracts', contracts: -75, positionAmt: null },
  { name: 'Missing positionAmt, use size', size: 75, positionAmt: null, contracts: null },
];

console.log('Testing side determination logic:\n');

let passed = 0;
let failed = 0;

for (const testCase of testCases) {
  const result = determineSide(testCase);
  const expectedSide = testCase.name.includes('SHORT') ? 'short' : 
                       testCase.name.includes('LONG') ? 'long' : 
                       testCase.name.includes('Zero') ? null : null;
  
  const isCorrect = result.side === expectedSide;
  
  if (isCorrect) {
    passed++;
    console.log(`✅ ${testCase.name}`);
  } else {
    failed++;
    console.log(`❌ ${testCase.name}`);
    console.log(`   Expected: ${expectedSide}, Got: ${result.side}`);
  }
  
  console.log(`   rawAmt: ${result.rawAmt}, side: ${result.side}, contracts: ${result.contracts}`);
  console.log('');
}

console.log('='.repeat(80));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(80) + '\n');

// Test edge cases
console.log('Testing edge cases:\n');

const edgeCases = [
  { name: 'String negative', positionAmt: '-100' },
  { name: 'String positive', positionAmt: '100' },
  { name: 'Very small negative', positionAmt: -0.0001 },
  { name: 'Very small positive', positionAmt: 0.0001 },
  { name: 'Large negative', positionAmt: -1000000 },
  { name: 'Large positive', positionAmt: 1000000 },
];

for (const testCase of edgeCases) {
  const result = determineSide(testCase);
  const isNegative = result.rawAmt < 0;
  const expectedSide = isNegative ? 'short' : (result.rawAmt > 0 ? 'long' : null);
  
  const isCorrect = result.side === expectedSide;
  
  if (isCorrect) {
    console.log(`✅ ${testCase.name}: side=${result.side}`);
  } else {
    console.log(`❌ ${testCase.name}: Expected ${expectedSide}, Got ${result.side}`);
  }
}

console.log('\n' + '='.repeat(80));
console.log('ANALYSIS');
console.log('='.repeat(80));
console.log(`
The logic in PositionSync.js (line 152-154):
  const rawAmt = parseFloat(exPos.positionAmt ?? exPos.contracts ?? exPos.size ?? 0);
  const side = rawAmt > 0 ? 'long' : rawAmt < 0 ? 'short' : null;
  const contracts = Math.abs(rawAmt);

This logic is CORRECT:
  ✅ Parse rawAmt FIRST
  ✅ Determine side based on rawAmt (positive = long, negative = short)
  ✅ Get absolute value AFTER determining side

However, there's a potential issue:
  ⚠️  If exPos.positionAmt is a STRING like "100" or "-100", parseFloat will work correctly
  ⚠️  But if it's already a NUMBER and somehow gets converted incorrectly, side could be wrong

Potential bugs to check:
  1. Check if ExchangeService.getOpenPositions() returns correct positionAmt values
  2. Check if Binance Direct Client returns positionAmt with correct sign
  3. Check if there's any transformation of positionAmt before it reaches PositionSync
`);

console.log('='.repeat(80) + '\n');

