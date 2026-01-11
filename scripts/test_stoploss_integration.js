/**
 * Integration test script to verify Stop Loss calculation by USDT amount
 * in real service contexts (PositionService, OrderService, etc.)
 * 
 * This script tests the integration of calculateInitialStopLossByAmount
 * with actual services to ensure end-to-end functionality.
 * 
 * Usage: node scripts/test_stoploss_integration.js
 */

import { PositionService } from '../src/services/PositionService.js';
import { calculateInitialStopLossByAmount } from '../src/utils/calculator.js';
import logger from '../src/utils/logger.js';

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

function assertEqual(actual, expected, message, tolerance = 0.01) {
  const diff = Math.abs(actual - expected);
  const passed = diff <= tolerance;
  if (passed) {
    log(`  ✅ ${message}`, 'green');
    log(`     Expected: ${expected}, Got: ${actual}, Diff: ${diff.toFixed(4)}`, 'green');
  } else {
    log(`  ❌ ${message}`, 'red');
    log(`     Expected: ${expected}, Got: ${actual}, Diff: ${diff.toFixed(4)}`, 'red');
  }
  return passed;
}

// Test results tracking
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

async function runTest(testName, testFn) {
  totalTests++;
  try {
    logTest(testName);
    const result = await testFn();
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
// MOCK SERVICES FOR TESTING
// ============================================================================

class MockExchangeService {
  constructor() {
    this.quantityCache = new Map();
  }

  async getClosableQuantity(symbol, side) {
    // Return cached quantity or calculate from mock data
    const key = `${symbol}_${side}`;
    if (this.quantityCache.has(key)) {
      return this.quantityCache.get(key);
    }
    
    // Default mock quantity based on symbol
    const mockQuantities = {
      'BTCUSDT_long': 0.1,
      'BTCUSDT_short': 0.1,
      'ETHUSDT_long': 0.2,
      'ETHUSDT_short': 0.2,
    };
    
    return mockQuantities[key] || 0.1;
  }

  setQuantity(symbol, side, quantity) {
    const key = `${symbol}_${side}`;
    this.quantityCache.set(key, quantity);
  }
}

// ============================================================================
// TEST CASES
// ============================================================================

log('\n🧪 Integration Testing: Stop Loss Calculation by USDT Amount\n', 'blue');

// Test 1: PositionService.calculateUpdatedStopLoss with mock position
runTest('PositionService - Calculate SL for New Position (LONG)', async () => {
  const mockExchangeService = new MockExchangeService();
  const positionService = new PositionService(mockExchangeService);
  
  // Mock position data
  const mockPosition = {
    id: 1,
    strategy_id: 1,
    symbol: 'BTCUSDT',
    side: 'long',
    entry_price: 100000,
    amount: 10000, // $10,000 position
    stop_loss_price: null, // No SL yet
    strategy: {
      stoploss: 100 // 100 USDT loss
    }
  };
  
  // Set mock quantity
  mockExchangeService.setQuantity('BTCUSDT', 'long', 0.1);
  
  const slPrice = await positionService.calculateUpdatedStopLoss(mockPosition);
  
  // Expected: SL = 100000 - (100 / 0.1) = 100000 - 1000 = 99000
  const expectedSL = 99000;
  const lossAtSL = (mockPosition.entry_price - slPrice) * 0.1;
  
  let allPassed = true;
  allPassed = assert(slPrice !== null, 'SL price should not be null') && allPassed;
  allPassed = assertEqual(slPrice, expectedSL, `SL price should be ${expectedSL}`) && allPassed;
  allPassed = assertEqual(lossAtSL, 100, `Loss at SL should equal 100 USDT`) && allPassed;
  
  log(`     Entry: $${mockPosition.entry_price}`, 'yellow');
  log(`     Quantity: 0.1 BTC`, 'yellow');
  log(`     SL Amount: 100 USDT`, 'yellow');
  log(`     Calculated SL: $${slPrice}`, 'yellow');
  log(`     Loss at SL: $${lossAtSL} USDT`, 'yellow');
  
  return allPassed;
});

// Test 2: PositionService with existing SL (should not recalculate)
runTest('PositionService - Existing SL Should Not Be Recalculated', async () => {
  const mockExchangeService = new MockExchangeService();
  const positionService = new PositionService(mockExchangeService);
  
  const mockPosition = {
    id: 2,
    strategy_id: 1,
    symbol: 'BTCUSDT',
    side: 'long',
    entry_price: 100000,
    amount: 10000,
    stop_loss_price: 99000, // Already has SL
    strategy: {
      stoploss: 100
    }
  };
  
  const slPrice = await positionService.calculateUpdatedStopLoss(mockPosition);
  
  // Should return existing SL, not recalculate
  let allPassed = true;
  allPassed = assertEqual(slPrice, 99000, 'Should return existing SL price') && allPassed;
  
  return allPassed;
});

// Test 3: PositionService with quantity from amount/entry fallback
runTest('PositionService - Quantity Fallback from Amount/Entry', async () => {
  const mockExchangeService = new MockExchangeService();
  const positionService = new PositionService(mockExchangeService);
  
  // Mock exchange service that returns 0 (simulating failure)
  mockExchangeService.getClosableQuantity = async () => 0;
  
  const mockPosition = {
    id: 3,
    strategy_id: 1,
    symbol: 'ETHUSDT',
    side: 'short',
    entry_price: 2500,
    amount: 500, // $500 position
    stop_loss_price: null,
    strategy: {
      stoploss: 25 // 25 USDT loss
    }
  };
  
  const slPrice = await positionService.calculateUpdatedStopLoss(mockPosition);
  
  // Expected quantity: 500 / 2500 = 0.2 ETH
  // Expected SL: 2500 + (25 / 0.2) = 2500 + 125 = 2625
  const expectedSL = 2625;
  const expectedQuantity = 500 / 2500; // 0.2
  const lossAtSL = (slPrice - mockPosition.entry_price) * expectedQuantity;
  
  let allPassed = true;
  allPassed = assert(slPrice !== null, 'SL price should not be null') && allPassed;
  allPassed = assertEqual(slPrice, expectedSL, `SL price should be ${expectedSL}`) && allPassed;
  allPassed = assertEqual(lossAtSL, 25, `Loss at SL should equal 25 USDT`) && allPassed;
  
  log(`     Entry: $${mockPosition.entry_price}`, 'yellow');
  log(`     Amount: $${mockPosition.amount}`, 'yellow');
  log(`     Calculated Quantity: ${expectedQuantity} ETH`, 'yellow');
  log(`     SL Amount: 25 USDT`, 'yellow');
  log(`     Calculated SL: $${slPrice}`, 'yellow');
  log(`     Loss at SL: $${lossAtSL} USDT`, 'yellow');
  
  return allPassed;
});

// Test 4: PositionService with invalid stoploss (should return null)
runTest('PositionService - Invalid Stoploss Should Return Null', async () => {
  const mockExchangeService = new MockExchangeService();
  const positionService = new PositionService(mockExchangeService);
  
  const mockPosition = {
    id: 4,
    strategy_id: 1,
    symbol: 'BTCUSDT',
    side: 'long',
    entry_price: 100000,
    amount: 10000,
    stop_loss_price: null,
    strategy: {
      stoploss: 0 // Invalid: zero or null
    }
  };
  
  const slPrice = await positionService.calculateUpdatedStopLoss(mockPosition);
  
  let allPassed = true;
  allPassed = assert(slPrice === null, 'Should return null for invalid stoploss') && allPassed;
  
  return allPassed;
});

// Test 5: Verify calculation consistency across different scenarios
runTest('Calculation Consistency - Multiple Scenarios', () => {
  const testCases = [
    {
      name: 'BTC LONG - Small Position',
      entry: 45000,
      amount: 1000,
      slAmount: 50,
      side: 'long',
      expectedQuantity: 1000 / 45000
    },
    {
      name: 'ETH SHORT - Medium Position',
      entry: 2500,
      amount: 500,
      slAmount: 25,
      side: 'short',
      expectedQuantity: 500 / 2500
    },
    {
      name: 'BTC LONG - Large Position',
      entry: 100000,
      amount: 10000,
      slAmount: 200,
      side: 'long',
      expectedQuantity: 10000 / 100000
    }
  ];
  
  let allPassed = true;
  
  for (const testCase of testCases) {
    const quantity = testCase.expectedQuantity;
    const slPrice = calculateInitialStopLossByAmount(
      testCase.entry,
      quantity,
      testCase.slAmount,
      testCase.side
    );
    
    if (!slPrice) {
      log(`  ❌ ${testCase.name}: Failed to calculate SL`, 'red');
      allPassed = false;
      continue;
    }
    
    // Verify loss calculation
    let lossAtSL;
    if (testCase.side === 'long') {
      lossAtSL = (testCase.entry - slPrice) * quantity;
    } else {
      lossAtSL = (slPrice - testCase.entry) * quantity;
    }
    
    const lossMatch = Math.abs(lossAtSL - testCase.slAmount) < 0.01;
    
    if (lossMatch) {
      log(`  ✅ ${testCase.name}: Loss = $${lossAtSL.toFixed(2)} USDT`, 'green');
    } else {
      log(`  ❌ ${testCase.name}: Expected loss $${testCase.slAmount}, got $${lossAtSL.toFixed(2)}`, 'red');
      allPassed = false;
    }
  }
  
  return allPassed;
});

// Test 6: Edge case - Very large SL amount relative to position
runTest('Edge Case - Large SL Amount Relative to Position', async () => {
  const mockExchangeService = new MockExchangeService();
  const positionService = new PositionService(mockExchangeService);
  
  const mockPosition = {
    id: 5,
    strategy_id: 1,
    symbol: 'BTCUSDT',
    side: 'long',
    entry_price: 1000, // Low entry price
    amount: 100, // Small position
    stop_loss_price: null,
    strategy: {
      stoploss: 200 // SL amount larger than position value (would make SL negative)
    }
  };
  
  mockExchangeService.setQuantity('BTCUSDT', 'long', 0.1);
  
  const slPrice = await positionService.calculateUpdatedStopLoss(mockPosition);
  
  // Should return null because SL would be negative
  let allPassed = true;
  allPassed = assert(slPrice === null, 'Should return null when SL would be invalid (negative)') && allPassed;
  
  return allPassed;
});

// ============================================================================
// SUMMARY
// ============================================================================

async function runAllTests() {
  log('\n🚀 Running Integration Tests...\n', 'blue');
  
  // Run all tests
  await runTest('PositionService - Calculate SL for New Position (LONG)', async () => {
    const mockExchangeService = new MockExchangeService();
    const positionService = new PositionService(mockExchangeService);
    
    const mockPosition = {
      id: 1,
      strategy_id: 1,
      symbol: 'BTCUSDT',
      side: 'long',
      entry_price: 100000,
      amount: 10000,
      stop_loss_price: null,
      strategy: { stoploss: 100 }
    };
    
    mockExchangeService.setQuantity('BTCUSDT', 'long', 0.1);
    const slPrice = await positionService.calculateUpdatedStopLoss(mockPosition);
    
    const expectedSL = 99000;
    const lossAtSL = (mockPosition.entry_price - slPrice) * 0.1;
    
    let allPassed = true;
    allPassed = assert(slPrice !== null, 'SL price should not be null') && allPassed;
    allPassed = assertEqual(slPrice, expectedSL, `SL price should be ${expectedSL}`) && allPassed;
    allPassed = assertEqual(lossAtSL, 100, `Loss at SL should equal 100 USDT`) && allPassed;
    
    return allPassed;
  });
  
  await runTest('PositionService - Existing SL Should Not Be Recalculated', async () => {
    const mockExchangeService = new MockExchangeService();
    const positionService = new PositionService(mockExchangeService);
    
    const mockPosition = {
      id: 2,
      strategy_id: 1,
      symbol: 'BTCUSDT',
      side: 'long',
      entry_price: 100000,
      amount: 10000,
      stop_loss_price: 99000,
      strategy: { stoploss: 100 }
    };
    
    const slPrice = await positionService.calculateUpdatedStopLoss(mockPosition);
    return assertEqual(slPrice, 99000, 'Should return existing SL price');
  });
  
  await runTest('PositionService - Quantity Fallback from Amount/Entry', async () => {
    const mockExchangeService = new MockExchangeService();
    const positionService = new PositionService(mockExchangeService);
    
    mockExchangeService.getClosableQuantity = async () => 0;
    
    const mockPosition = {
      id: 3,
      strategy_id: 1,
      symbol: 'ETHUSDT',
      side: 'short',
      entry_price: 2500,
      amount: 500,
      stop_loss_price: null,
      strategy: { stoploss: 25 }
    };
    
    const slPrice = await positionService.calculateUpdatedStopLoss(mockPosition);
    const expectedSL = 2625;
    const expectedQuantity = 500 / 2500;
    const lossAtSL = (slPrice - mockPosition.entry_price) * expectedQuantity;
    
    let allPassed = true;
    allPassed = assert(slPrice !== null, 'SL price should not be null') && allPassed;
    allPassed = assertEqual(slPrice, expectedSL, `SL price should be ${expectedSL}`) && allPassed;
    allPassed = assertEqual(lossAtSL, 25, `Loss at SL should equal 25 USDT`) && allPassed;
    
    return allPassed;
  });
  
  await runTest('PositionService - Invalid Stoploss Should Return Null', async () => {
    const mockExchangeService = new MockExchangeService();
    const positionService = new PositionService(mockExchangeService);
    
    const mockPosition = {
      id: 4,
      strategy_id: 1,
      symbol: 'BTCUSDT',
      side: 'long',
      entry_price: 100000,
      amount: 10000,
      stop_loss_price: null,
      strategy: { stoploss: 0 }
    };
    
    const slPrice = await positionService.calculateUpdatedStopLoss(mockPosition);
    return assert(slPrice === null, 'Should return null for invalid stoploss');
  });
  
  runTest('Calculation Consistency - Multiple Scenarios', () => {
    const testCases = [
      { name: 'BTC LONG - Small', entry: 45000, amount: 1000, slAmount: 50, side: 'long' },
      { name: 'ETH SHORT - Medium', entry: 2500, amount: 500, slAmount: 25, side: 'short' },
      { name: 'BTC LONG - Large', entry: 100000, amount: 10000, slAmount: 200, side: 'long' }
    ];
    
    let allPassed = true;
    for (const testCase of testCases) {
      const quantity = testCase.amount / testCase.entry;
      const slPrice = calculateInitialStopLossByAmount(
        testCase.entry, quantity, testCase.slAmount, testCase.side
      );
      
      if (!slPrice) {
        allPassed = false;
        continue;
      }
      
      let lossAtSL;
      if (testCase.side === 'long') {
        lossAtSL = (testCase.entry - slPrice) * quantity;
      } else {
        lossAtSL = (slPrice - testCase.entry) * quantity;
      }
      
      const lossMatch = Math.abs(lossAtSL - testCase.slAmount) < 0.01;
      if (!lossMatch) allPassed = false;
    }
    return allPassed;
  });
  
  await runTest('Edge Case - Large SL Amount Relative to Position', async () => {
    const mockExchangeService = new MockExchangeService();
    const positionService = new PositionService(mockExchangeService);
    
    const mockPosition = {
      id: 5,
      strategy_id: 1,
      symbol: 'BTCUSDT',
      side: 'long',
      entry_price: 1000,
      amount: 100,
      stop_loss_price: null,
      strategy: { stoploss: 200 }
    };
    
    mockExchangeService.setQuantity('BTCUSDT', 'long', 0.1);
    const slPrice = await positionService.calculateUpdatedStopLoss(mockPosition);
    return assert(slPrice === null, 'Should return null when SL would be invalid');
  });
  
  log('\n' + '='.repeat(60), 'blue');
  log('📊 TEST SUMMARY', 'blue');
  log('='.repeat(60), 'blue');
  log(`Total Tests: ${totalTests}`, 'cyan');
  log(`✅ Passed: ${passedTests}`, 'green');
  log(`❌ Failed: ${failedTests}`, failedTests > 0 ? 'red' : 'green');
  log('='.repeat(60), 'blue');
  
  if (failedTests === 0) {
    log('\n🎉 All integration tests passed!', 'green');
    process.exit(0);
  } else {
    log('\n⚠️  Some tests failed. Please review the output above.', 'red');
    process.exit(1);
  }
}


// Run all tests
runAllTests().catch(error => {
  log(`\n❌ Fatal error: ${error.message}`, 'red');
  console.error(error);
  process.exit(1);
});

