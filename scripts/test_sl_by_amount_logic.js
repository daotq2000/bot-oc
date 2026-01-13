/**
 * Test script to verify SL by amount calculation logic
 * This script tests if the calculated SL results in the correct loss amount
 */

// Test cases
const testCases = [
  {
    name: 'LONG: Entry=100, Quantity=1, SL Amount=50 USDT',
    entry: 100,
    quantity: 1,
    slAmount: 50,
    side: 'long',
    expectedSL: 50, // Entry - (50/1) = 100 - 50 = 50
    expectedLoss: 50 // |50 - 100| * 1 = 50
  },
  {
    name: 'LONG: Entry=100, Quantity=0.8, SL Amount=50 USDT',
    entry: 100,
    quantity: 0.8,
    slAmount: 50,
    side: 'long',
    expectedSL: 37.5, // Entry - (50/0.8) = 100 - 62.5 = 37.5
    expectedLoss: 50 // |37.5 - 100| * 0.8 = 62.5 * 0.8 = 50
  },
  {
    name: 'LONG: Entry=100, Quantity=1.2, SL Amount=50 USDT',
    entry: 100,
    quantity: 1.2,
    slAmount: 50,
    side: 'long',
    expectedSL: 58.333333333333336, // Entry - (50/1.2) = 100 - 41.666... = 58.333...
    expectedLoss: 50 // |58.333... - 100| * 1.2 = 41.666... * 1.2 = 50
  },
  {
    name: 'SHORT: Entry=100, Quantity=1, SL Amount=50 USDT',
    entry: 100,
    quantity: 1,
    slAmount: 50,
    side: 'short',
    expectedSL: 150, // Entry + (50/1) = 100 + 50 = 150
    expectedLoss: 50 // |150 - 100| * 1 = 50
  },
  {
    name: 'SHORT: Entry=100, Quantity=0.8, SL Amount=50 USDT',
    entry: 100,
    quantity: 0.8,
    slAmount: 50,
    side: 'short',
    expectedSL: 162.5, // Entry + (50/0.8) = 100 + 62.5 = 162.5
    expectedLoss: 50 // |162.5 - 100| * 0.8 = 62.5 * 0.8 = 50
  },
  {
    name: 'SHORT: Entry=100, Quantity=1.2, SL Amount=50 USDT',
    entry: 100,
    quantity: 1.2,
    slAmount: 50,
    side: 'short',
    expectedSL: 141.66666666666666, // Entry + (50/1.2) = 100 + 41.666... = 141.666...
    expectedLoss: 50 // |141.666... - 100| * 1.2 = 41.666... * 1.2 = 50
  }
];

// Import calculation function
function calculateInitialStopLossByAmount(entryPrice, quantity, stoplossAmount, side) {
  const entry = Number(entryPrice);
  const qty = Number(quantity);
  const slAmount = Number(stoplossAmount);
  
  if (!Number.isFinite(entry) || entry <= 0) return null;
  if (!Number.isFinite(qty) || qty <= 0) return null;
  if (!Number.isFinite(slAmount) || slAmount <= 0) return null;
  
  const priceDiff = slAmount / qty;
  
  if (side === 'long') {
    const slPrice = entry - priceDiff;
    if (slPrice <= 0 || slPrice >= entry) return null;
    return slPrice;
  } else {
    const slPrice = entry + priceDiff;
    if (slPrice <= entry) return null;
    return slPrice;
  }
}

// Calculate actual loss when SL is hit
function calculateLoss(entryPrice, slPrice, quantity, side) {
  const entry = Number(entryPrice);
  const sl = Number(slPrice);
  const qty = Number(quantity);
  
  if (side === 'long') {
    return Math.abs(sl - entry) * qty;
  } else {
    return Math.abs(sl - entry) * qty;
  }
}

// Run tests
console.log('🧪 Testing SL by Amount Calculation Logic\n');
console.log('='.repeat(80));

let passed = 0;
let failed = 0;

for (const testCase of testCases) {
  const { name, entry, quantity, slAmount, side, expectedSL, expectedLoss } = testCase;
  
  const calculatedSL = calculateInitialStopLossByAmount(entry, quantity, slAmount, side);
  const actualLoss = calculatedSL ? calculateLoss(entry, calculatedSL, quantity, side) : null;
  
  const slMatch = calculatedSL !== null && Math.abs(calculatedSL - expectedSL) < 0.01;
  const lossMatch = actualLoss !== null && Math.abs(actualLoss - expectedLoss) < 0.01;
  
  if (slMatch && lossMatch) {
    console.log(`✅ PASS: ${name}`);
    console.log(`   Calculated SL: ${calculatedSL.toFixed(8)} (expected: ${expectedSL})`);
    console.log(`   Actual Loss: ${actualLoss.toFixed(2)} USDT (expected: ${expectedLoss} USDT)`);
    passed++;
  } else {
    console.log(`❌ FAIL: ${name}`);
    console.log(`   Calculated SL: ${calculatedSL} (expected: ${expectedSL})`);
    console.log(`   Actual Loss: ${actualLoss} USDT (expected: ${expectedLoss} USDT)`);
    failed++;
  }
  console.log('');
}

console.log('='.repeat(80));
console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

// Test the PROBLEM scenario: What if quantity used for calculation is different from actual quantity?
console.log('🔍 Testing PROBLEM Scenario: Quantity Mismatch\n');
console.log('='.repeat(80));

const problemTestCases = [
  {
    name: 'LONG: Set SL with quantity=1, but actual quantity=1.2',
    entry: 100,
    quantityUsedForSL: 1,      // Quantity used when calculating SL
    quantityActual: 1.2,        // Actual quantity on exchange
    slAmount: 50,
    side: 'long'
  },
  {
    name: 'SHORT: Set SL with quantity=1, but actual quantity=1.2',
    entry: 100,
    quantityUsedForSL: 1,
    quantityActual: 1.2,
    slAmount: 50,
    side: 'short'
  }
];

for (const testCase of problemTestCases) {
  const { name, entry, quantityUsedForSL, quantityActual, slAmount, side } = testCase;
  
  // Calculate SL using quantityUsedForSL
  const calculatedSL = calculateInitialStopLossByAmount(entry, quantityUsedForSL, slAmount, side);
  
  // Calculate actual loss using quantityActual (what happens when SL is hit)
  const actualLoss = calculatedSL ? calculateLoss(entry, calculatedSL, quantityActual, side) : null;
  
  console.log(`${name}`);
  console.log(`   Entry: ${entry}`);
  console.log(`   Quantity used for SL calculation: ${quantityUsedForSL}`);
  console.log(`   Actual quantity on exchange: ${quantityActual}`);
  console.log(`   SL Amount set: ${slAmount} USDT`);
  console.log(`   Calculated SL price: ${calculatedSL?.toFixed(8) || 'null'}`);
  console.log(`   Actual loss when SL hit: ${actualLoss?.toFixed(2) || 'null'} USDT`);
  console.log(`   ⚠️  Loss difference: ${actualLoss ? (actualLoss - slAmount).toFixed(2) : 'N/A'} USDT`);
  console.log('');
}

console.log('='.repeat(80));
console.log('\n💡 Conclusion: If quantity used for SL calculation differs from actual quantity,');
console.log('   the actual loss will differ from the set SL amount!\n');

