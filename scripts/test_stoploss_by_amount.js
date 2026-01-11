/**
 * Test script to verify Stop Loss calculation by USDT amount
 * 
 * This script tests the new calculateInitialStopLossByAmount function
 * to ensure SL is calculated correctly based on USDT amount instead of percentage.
 * 
 * Usage: node scripts/test_stoploss_by_amount.js
 */

import { calculateInitialStopLoss, calculateInitialStopLossByAmount } from '../src/utils/calculator.js';

// Color codes for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logTest(name) {
  log(`\n${'='.repeat(60)}`, 'cyan');
  log(`Test: ${name}`, 'cyan');
  log('='.repeat(60), 'cyan');
}

function assert(condition, message) {
  if (condition) {
    log(`  ✅ ${message}`, 'green');
    return true;
  } else {
    log(`  ❌ ${message}`, 'red');
    return false;
  }
}

function assertEqual(actual, expected, message, tolerance = 0.0001) {
  const diff = Math.abs(actual - expected);
  const passed = diff <= tolerance;
  if (passed) {
    log(`  ✅ ${message}`, 'green');
    log(`     Expected: ${expected}, Got: ${actual}, Diff: ${diff.toFixed(8)}`, 'green');
  } else {
    log(`  ❌ ${message}`, 'red');
    log(`     Expected: ${expected}, Got: ${actual}, Diff: ${diff.toFixed(8)}`, 'red');
  }
  return passed;
}

function assertNull(actual, message) {
  if (actual === null) {
    log(`  ✅ ${message}`, 'green');
    return true;
  } else {
    log(`  ❌ ${message} - Expected null, got: ${actual}`, 'red');
    return false;
  }
}

// Test results tracking
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function runTest(testName, testFn) {
  totalTests++;
  try {
    logTest(testName);
    const result = testFn();
    if (result) {
      passedTests++;
    } else {
      failedTests++;
    }
  } catch (error) {
    failedTests++;
    log(`  ❌ Test failed with error: ${error.message}`, 'red');
    console.error(error);
  }
}

// ============================================================================
// TEST CASES
// ============================================================================

log('\n🧪 Testing Stop Loss Calculation by USDT Amount\n', 'blue');

// Test 1: Basic LONG position
runTest('LONG Position - Basic Calculation', () => {
  const entryPrice = 100000; // 100,000 USDT
  const quantity = 0.1; // 0.1 BTC
  const stoplossAmount = 100; // 100 USDT loss
  const side = 'long';
  
  const slPrice = calculateInitialStopLossByAmount(entryPrice, quantity, stoplossAmount, side);
  
  // Expected: SL = Entry - (SL_amount / quantity) = 100000 - (100 / 0.1) = 100000 - 1000 = 99000
  const expectedSL = 99000;
  
  // Verify calculation
  const priceDiff = stoplossAmount / quantity; // 100 / 0.1 = 1000
  const calculatedSL = entryPrice - priceDiff; // 100000 - 1000 = 99000
  
  // Verify loss when SL is hit
  const lossAtSL = (entryPrice - slPrice) * quantity; // (100000 - 99000) * 0.1 = 1000 * 0.1 = 100
  
  let allPassed = true;
  allPassed = assertEqual(slPrice, expectedSL, `SL price should be ${expectedSL}`) && allPassed;
  allPassed = assertEqual(priceDiff, 1000, `Price difference should be 1000`) && allPassed;
  allPassed = assertEqual(lossAtSL, stoplossAmount, `Loss at SL should equal stoploss amount (${stoplossAmount} USDT)`) && allPassed;
  allPassed = assert(slPrice < entryPrice, `SL price (${slPrice}) should be less than entry (${entryPrice}) for LONG`) && allPassed;
  allPassed = assert(slPrice > 0, `SL price should be positive`) && allPassed;
  
  return allPassed;
});

// Test 2: Basic SHORT position
runTest('SHORT Position - Basic Calculation', () => {
  const entryPrice = 50000; // 50,000 USDT
  const quantity = 0.2; // 0.2 BTC
  const stoplossAmount = 50; // 50 USDT loss
  const side = 'short';
  
  const slPrice = calculateInitialStopLossByAmount(entryPrice, quantity, stoplossAmount, side);
  
  // Expected: SL = Entry + (SL_amount / quantity) = 50000 + (50 / 0.2) = 50000 + 250 = 50250
  const expectedSL = 50250;
  
  // Verify calculation
  const priceDiff = stoplossAmount / quantity; // 50 / 0.2 = 250
  const calculatedSL = entryPrice + priceDiff; // 50000 + 250 = 50250
  
  // Verify loss when SL is hit
  const lossAtSL = (slPrice - entryPrice) * quantity; // (50250 - 50000) * 0.2 = 250 * 0.2 = 50
  
  let allPassed = true;
  allPassed = assertEqual(slPrice, expectedSL, `SL price should be ${expectedSL}`) && allPassed;
  allPassed = assertEqual(priceDiff, 250, `Price difference should be 250`) && allPassed;
  allPassed = assertEqual(lossAtSL, stoplossAmount, `Loss at SL should equal stoploss amount (${stoplossAmount} USDT)`) && allPassed;
  allPassed = assert(slPrice > entryPrice, `SL price (${slPrice}) should be greater than entry (${entryPrice}) for SHORT`) && allPassed;
  allPassed = assert(slPrice > 0, `SL price should be positive`) && allPassed;
  
  return allPassed;
});

// Test 3: Small quantity, large SL amount
runTest('Small Quantity, Large SL Amount', () => {
  const entryPrice = 100000;
  const quantity = 0.01; // Very small quantity
  const stoplossAmount = 200; // Large SL amount
  const side = 'long';
  
  const slPrice = calculateInitialStopLossByAmount(entryPrice, quantity, stoplossAmount, side);
  
  // Expected: SL = 100000 - (200 / 0.01) = 100000 - 20000 = 80000
  const expectedSL = 80000;
  const lossAtSL = (entryPrice - slPrice) * quantity;
  
  let allPassed = true;
  allPassed = assertEqual(slPrice, expectedSL, `SL price should be ${expectedSL}`) && allPassed;
  allPassed = assertEqual(lossAtSL, stoplossAmount, `Loss at SL should equal ${stoplossAmount} USDT`) && allPassed;
  
  return allPassed;
});

// Test 4: Large quantity, small SL amount
runTest('Large Quantity, Small SL Amount', () => {
  const entryPrice = 50000;
  const quantity = 1.0; // 1 BTC
  const stoplossAmount = 10; // Small SL amount
  const side = 'short';
  
  const slPrice = calculateInitialStopLossByAmount(entryPrice, quantity, stoplossAmount, side);
  
  // Expected: SL = 50000 + (10 / 1.0) = 50000 + 10 = 50010
  const expectedSL = 50010;
  const lossAtSL = (slPrice - entryPrice) * quantity;
  
  let allPassed = true;
  allPassed = assertEqual(slPrice, expectedSL, `SL price should be ${expectedSL}`) && allPassed;
  allPassed = assertEqual(lossAtSL, stoplossAmount, `Loss at SL should equal ${stoplossAmount} USDT`) && allPassed;
  
  return allPassed;
});

// Test 5: Invalid inputs - zero entry price
runTest('Invalid Inputs - Zero Entry Price', () => {
  const slPrice = calculateInitialStopLossByAmount(0, 0.1, 100, 'long');
  return assertNull(slPrice, 'Should return null for zero entry price');
});

// Test 6: Invalid inputs - zero quantity
runTest('Invalid Inputs - Zero Quantity', () => {
  const slPrice = calculateInitialStopLossByAmount(100000, 0, 100, 'long');
  return assertNull(slPrice, 'Should return null for zero quantity');
});

// Test 7: Invalid inputs - zero SL amount
runTest('Invalid Inputs - Zero SL Amount', () => {
  const slPrice = calculateInitialStopLossByAmount(100000, 0.1, 0, 'long');
  return assertNull(slPrice, 'Should return null for zero SL amount');
});

// Test 8: Invalid inputs - negative values
runTest('Invalid Inputs - Negative Entry Price', () => {
  const slPrice = calculateInitialStopLossByAmount(-100000, 0.1, 100, 'long');
  return assertNull(slPrice, 'Should return null for negative entry price');
});

// Test 9: Edge case - SL would be negative (LONG)
runTest('Edge Case - SL Would Be Negative (LONG)', () => {
  const entryPrice = 1000;
  const quantity = 0.1;
  const stoplossAmount = 200; // This would make SL = 1000 - 2000 = -1000 (invalid)
  const side = 'long';
  
  const slPrice = calculateInitialStopLossByAmount(entryPrice, quantity, stoplossAmount, side);
  return assertNull(slPrice, 'Should return null when SL would be negative');
});

// Test 10: Edge case - SL equals entry (should be invalid)
runTest('Edge Case - SL Equals Entry (LONG)', () => {
  const entryPrice = 100000;
  const quantity = 0.1;
  const stoplossAmount = 0; // This would make SL = entry (invalid)
  const side = 'long';
  
  const slPrice = calculateInitialStopLossByAmount(entryPrice, quantity, stoplossAmount, side);
  return assertNull(slPrice, 'Should return null when SL equals entry');
});

// Test 11: Real-world scenario - BTC position
runTest('Real-world Scenario - BTC LONG Position', () => {
  const entryPrice = 45000; // BTC at $45,000
  const amount = 1000; // $1,000 position
  const quantity = amount / entryPrice; // 1000 / 45000 = 0.0222... BTC
  const stoplossAmount = 50; // $50 max loss
  const side = 'long';
  
  const slPrice = calculateInitialStopLossByAmount(entryPrice, quantity, stoplossAmount, side);
  
  // Verify loss calculation
  const lossAtSL = (entryPrice - slPrice) * quantity;
  
  let allPassed = true;
  allPassed = assert(slPrice > 0, `SL price should be positive`) && allPassed;
  allPassed = assert(slPrice < entryPrice, `SL price should be less than entry for LONG`) && allPassed;
  allPassed = assertEqual(lossAtSL, stoplossAmount, `Loss at SL should equal ${stoplossAmount} USDT`, 0.01) && allPassed;
  
  log(`     Entry: $${entryPrice.toFixed(2)}`, 'yellow');
  log(`     Quantity: ${quantity.toFixed(6)} BTC`, 'yellow');
  log(`     SL Price: $${slPrice.toFixed(2)}`, 'yellow');
  log(`     Loss at SL: $${lossAtSL.toFixed(2)} USDT`, 'yellow');
  log(`     Price difference: $${(entryPrice - slPrice).toFixed(2)}`, 'yellow');
  
  return allPassed;
});

// Test 12: Real-world scenario - ETH SHORT position
runTest('Real-world Scenario - ETH SHORT Position', () => {
  const entryPrice = 2500; // ETH at $2,500
  const amount = 500; // $500 position
  const quantity = amount / entryPrice; // 500 / 2500 = 0.2 ETH
  const stoplossAmount = 25; // $25 max loss
  const side = 'short';
  
  const slPrice = calculateInitialStopLossByAmount(entryPrice, quantity, stoplossAmount, side);
  
  // Verify loss calculation
  const lossAtSL = (slPrice - entryPrice) * quantity;
  
  let allPassed = true;
  allPassed = assert(slPrice > 0, `SL price should be positive`) && allPassed;
  allPassed = assert(slPrice > entryPrice, `SL price should be greater than entry for SHORT`) && allPassed;
  allPassed = assertEqual(lossAtSL, stoplossAmount, `Loss at SL should equal ${stoplossAmount} USDT`, 0.01) && allPassed;
  
  log(`     Entry: $${entryPrice.toFixed(2)}`, 'yellow');
  log(`     Quantity: ${quantity.toFixed(6)} ETH`, 'yellow');
  log(`     SL Price: $${slPrice.toFixed(2)}`, 'yellow');
  log(`     Loss at SL: $${lossAtSL.toFixed(2)} USDT`, 'yellow');
  log(`     Price difference: $${(slPrice - entryPrice).toFixed(2)}`, 'yellow');
  
  return allPassed;
});

// Test 13: Comparison with old percentage-based method
runTest('Comparison - Old vs New Method', () => {
  const entryPrice = 100000;
  const quantity = 0.1;
  const side = 'long';
  
  // Old method: percentage-based (e.g., 5% = 50 in old format)
  const oldStoplossPercent = 50; // 5% in old format (divided by 10)
  const oldSL = calculateInitialStopLoss(entryPrice, oldStoplossPercent, side);
  const oldLoss = (entryPrice - oldSL) * quantity;
  
  // New method: USDT-based
  const newStoplossAmount = oldLoss; // Use the same loss amount
  const newSL = calculateInitialStopLossByAmount(entryPrice, quantity, newStoplossAmount, side);
  
  log(`     Old method (5%): SL = $${oldSL.toFixed(2)}, Loss = $${oldLoss.toFixed(2)}`, 'yellow');
  log(`     New method ($${newStoplossAmount.toFixed(2)}): SL = $${newSL.toFixed(2)}, Loss = $${newStoplossAmount.toFixed(2)}`, 'yellow');
  
  let allPassed = true;
  allPassed = assert(Math.abs(newSL - oldSL) < 0.01, `New SL should be very close to old SL for same loss amount`) && allPassed;
  
  return allPassed;
});

// Test 14: Precision test - very small price difference
runTest('Precision Test - Very Small Price Difference', () => {
  const entryPrice = 100000;
  const quantity = 10; // Large quantity
  const stoplossAmount = 0.1; // Very small SL amount
  const side = 'long';
  
  const slPrice = calculateInitialStopLossByAmount(entryPrice, quantity, stoplossAmount, side);
  
  // Expected: SL = 100000 - (0.1 / 10) = 100000 - 0.01 = 99999.99
  const expectedSL = 99999.99;
  const lossAtSL = (entryPrice - slPrice) * quantity;
  
  let allPassed = true;
  allPassed = assertEqual(slPrice, expectedSL, `SL price should be ${expectedSL}`, 0.0001) && allPassed;
  allPassed = assertEqual(lossAtSL, stoplossAmount, `Loss at SL should equal ${stoplossAmount} USDT`, 0.0001) && allPassed;
  
  return allPassed;
});

// ============================================================================
// SUMMARY
// ============================================================================

log('\n' + '='.repeat(60), 'blue');
log('📊 TEST SUMMARY', 'blue');
log('='.repeat(60), 'blue');
log(`Total Tests: ${totalTests}`, 'cyan');
log(`✅ Passed: ${passedTests}`, 'green');
log(`❌ Failed: ${failedTests}`, failedTests > 0 ? 'red' : 'green');
log('='.repeat(60), 'blue');

if (failedTests === 0) {
  log('\n🎉 All tests passed!', 'green');
  process.exit(0);
} else {
  log('\n⚠️  Some tests failed. Please review the output above.', 'red');
  process.exit(1);
}

