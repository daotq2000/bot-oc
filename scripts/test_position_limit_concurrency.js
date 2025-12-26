/**
 * Concurrency Test Script for PositionLimitService
 * 
 * Test race condition prevention với MySQL advisory lock
 * 
 * Usage:
 *   node scripts/test_position_limit_concurrency.js
 */

import { positionLimitService } from '../src/services/PositionLimitService.js';
import { Bot } from '../src/models/Bot.js';
import pool from '../src/config/database.js';

async function testConcurrency() {
  const botId = 1; // Change to your test bot ID
  const symbol = 'BTC/USDT'; // Change to your test symbol
  const maxAmount = 30;
  const amountPerRequest = 10;
  const numConcurrentRequests = 5;

  console.log('='.repeat(60));
  console.log('PositionLimitService - Concurrency Test');
  console.log('='.repeat(60));
  console.log(`Bot ID: ${botId}`);
  console.log(`Symbol: ${symbol}`);
  console.log(`Max Amount: ${maxAmount} USDT`);
  console.log(`Amount per request: ${amountPerRequest} USDT`);
  console.log(`Number of concurrent requests: ${numConcurrentRequests}`);
  console.log(`Expected: ${Math.floor(maxAmount / amountPerRequest)} allowed, ${numConcurrentRequests - Math.floor(maxAmount / amountPerRequest)} rejected`);
  console.log('='.repeat(60));
  console.log('');

  // Get current total before test
  const currentTotalBefore = await positionLimitService.getCurrentTotalAmount(botId, symbol);
  console.log(`Current total before test: ${currentTotalBefore.toFixed(2)} USDT`);
  console.log('');

  // Verify bot exists and has max_amount_per_coin set
  const bot = await Bot.findById(botId);
  if (!bot) {
    console.error(`❌ Bot ${botId} not found!`);
    process.exit(1);
  }

  if (bot.max_amount_per_coin !== maxAmount) {
    console.warn(`⚠️  Bot max_amount_per_coin is ${bot.max_amount_per_coin}, but test expects ${maxAmount}`);
    console.warn(`   Update bot or change test parameters`);
  }

  console.log('Starting concurrent requests...');
  console.log('');

  const startTime = Date.now();

  // Simulate concurrent requests
  const promises = Array.from({ length: numConcurrentRequests }, (_, i) => {
    const requestId = i + 1;
    return positionLimitService.canOpenNewPosition({
      botId,
      symbol,
      newOrderAmount: amountPerRequest
    }).then(result => {
      const status = result ? '✅ ALLOWED' : '❌ REJECTED';
      const timestamp = ((Date.now() - startTime) / 1000).toFixed(3);
      console.log(`[${timestamp}s] Request ${requestId}: ${status}`);
      return { requestId, result, timestamp: Date.now() };
    }).catch(error => {
      console.error(`[Request ${requestId}] Error:`, error.message);
      return { requestId, result: false, error: error.message };
    });
  });

  const results = await Promise.all(promises);
  const duration = ((Date.now() - startTime) / 1000).toFixed(3);

  console.log('');
  console.log('='.repeat(60));
  console.log('Results:');
  console.log('='.repeat(60));

  const allowedCount = results.filter(r => r.result === true).length;
  const rejectedCount = results.filter(r => r.result === false).length;
  const expectedAllowed = Math.floor((maxAmount - currentTotalBefore) / amountPerRequest);
  const expectedRejected = numConcurrentRequests - expectedAllowed;

  console.log(`Total requests: ${numConcurrentRequests}`);
  console.log(`Allowed: ${allowedCount} (expected: ${expectedAllowed})`);
  console.log(`Rejected: ${rejectedCount} (expected: ${expectedRejected})`);
  console.log(`Duration: ${duration}s`);
  console.log('');

  // Get current total after test (should not exceed limit)
  const currentTotalAfter = await positionLimitService.getCurrentTotalAmount(botId, symbol);
  console.log(`Current total after test: ${currentTotalAfter.toFixed(2)} USDT`);
  console.log('');

  // Verify results
  if (allowedCount === expectedAllowed && rejectedCount === expectedRejected) {
    console.log('✅ Test PASSED: Lock prevented race condition correctly!');
    console.log(`   Allowed exactly ${expectedAllowed} requests as expected`);
  } else {
    console.log('❌ Test FAILED: Race condition detected or unexpected results!');
    console.log(`   Expected ${expectedAllowed} allowed, got ${allowedCount}`);
    console.log(`   Expected ${expectedRejected} rejected, got ${rejectedCount}`);
    process.exit(1);
  }

  // Check if total would exceed limit (if we actually created orders)
  const projectedTotal = currentTotalBefore + (allowedCount * amountPerRequest);
  if (projectedTotal > maxAmount) {
    console.log('');
    console.log('⚠️  WARNING: Projected total would exceed limit!');
    console.log(`   Current: ${currentTotalBefore.toFixed(2)}`);
    console.log(`   Projected: ${projectedTotal.toFixed(2)}`);
    console.log(`   Max: ${maxAmount.toFixed(2)}`);
    process.exit(1);
  } else {
    console.log('');
    console.log(`✅ Projected total (${projectedTotal.toFixed(2)}) is within limit (${maxAmount})`);
  }

  console.log('='.repeat(60));
}

// Run test
testConcurrency().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
}).finally(() => {
  pool.end();
});

