import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { PositionLimitService } from '../../src/services/PositionLimitService.js';
import { Bot } from '../../src/models/Bot.js';
import pool from '../../src/config/database.js';
import { Position } from '../../src/models/Position.js';
import { EntryOrder } from '../../src/models/EntryOrder.js';

/**
 * Concurrency test for PositionLimitService
 * Tests race condition scenarios with multiple concurrent requests
 */
describe('PositionLimitService - Concurrency Tests', () => {
  let positionLimitService;
  let testBotId = 9999;
  let testSymbol = 'TEST/USDT';
  let originalBotFindById;

  beforeEach(async () => {
    jest.clearAllMocks();
    positionLimitService = new PositionLimitService();

    // Mock Bot.findById
    originalBotFindById = Bot.findById;
    Bot.findById = jest.fn().mockResolvedValue({
      id: testBotId,
      bot_name: 'Test Bot',
      max_amount_per_coin: 30
    });

    // Clean up test data
    try {
      await pool.execute('DELETE FROM positions WHERE bot_id = ? AND symbol = ?', [testBotId, testSymbol]);
      await pool.execute('DELETE FROM entry_orders WHERE strategy_id IN (SELECT id FROM strategies WHERE bot_id = ? AND symbol = ?)', [testBotId, testSymbol]);
      await pool.execute('DELETE FROM strategies WHERE bot_id = ? AND symbol = ?', [testBotId, testSymbol]);
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  afterEach(async () => {
    // Restore original
    Bot.findById = originalBotFindById;

    // Clean up test data
    try {
      await pool.execute('DELETE FROM positions WHERE bot_id = ? AND symbol = ?', [testBotId, testSymbol]);
      await pool.execute('DELETE FROM entry_orders WHERE strategy_id IN (SELECT id FROM strategies WHERE bot_id = ? AND symbol = ?)', [testBotId, testSymbol]);
      await pool.execute('DELETE FROM strategies WHERE bot_id = ? AND symbol = ?', [testBotId, testSymbol]);
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  /**
   * Helper: Create test strategy
   */
  async function createTestStrategy() {
    const [result] = await pool.execute(
      'INSERT INTO strategies (bot_id, symbol, trade_type, `interval`, oc, amount, take_profit, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [testBotId, testSymbol, 'both', '1m', 2.0, 10, 50, true]
    );
    return result.insertId;
  }

  /**
   * Helper: Create test position
   */
  async function createTestPosition(strategyId, amount) {
    await pool.execute(
      `INSERT INTO positions (strategy_id, bot_id, symbol, side, entry_price, amount, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [strategyId, testBotId, testSymbol, 'long', 50000, amount, 'open']
    );
  }

  /**
   * Helper: Create test entry order
   */
  async function createTestEntryOrder(strategyId, amount) {
    await pool.execute(
      `INSERT INTO entry_orders (strategy_id, bot_id, symbol, side, amount, status) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [strategyId, testBotId, testSymbol, 'long', amount, 'open']
    );
  }

  describe('Concurrent limit checks', () => {
    it('should prevent race condition when multiple threads check limit simultaneously', async () => {
      // Setup: max = 30, current = 0
      // Scenario: 5 concurrent requests, each trying to add 10 USDT
      // Expected: Only 3 should pass (total = 30), 2 should be rejected

      const strategyId = await createTestStrategy();
      const numConcurrentRequests = 5;
      const amountPerRequest = 10;
      const maxAmount = 30;

      // Simulate concurrent requests
      const promises = Array.from({ length: numConcurrentRequests }, (_, i) => 
        positionLimitService.canOpenNewPosition({
          botId: testBotId,
          symbol: testSymbol,
          newOrderAmount: amountPerRequest
        })
      );

      const results = await Promise.all(promises);
      const allowedCount = results.filter(r => r === true).length;
      const rejectedCount = results.filter(r => r === false).length;

      // Verify: Exactly 3 should be allowed (30 / 10 = 3)
      expect(allowedCount).toBe(3);
      expect(rejectedCount).toBe(2);

      // Verify total doesn't exceed limit
      // Note: This test doesn't actually create orders, just checks the limit logic
      // In real scenario, orders would be created after check passes
    }, 30000); // 30s timeout for concurrency test

    it('should handle concurrent requests with existing positions', async () => {
      // Setup: max = 30, current = 20 (existing position)
      // Scenario: 3 concurrent requests, each trying to add 10 USDT
      // Expected: Only 1 should pass (20 + 10 = 30), 2 should be rejected

      const strategyId = await createTestStrategy();
      await createTestPosition(strategyId, 20); // Existing position

      const numConcurrentRequests = 3;
      const amountPerRequest = 10;

      const promises = Array.from({ length: numConcurrentRequests }, () => 
        positionLimitService.canOpenNewPosition({
          botId: testBotId,
          symbol: testSymbol,
          newOrderAmount: amountPerRequest
        })
      );

      const results = await Promise.all(promises);
      const allowedCount = results.filter(r => r === true).length;
      const rejectedCount = results.filter(r => r === false).length;

      // Verify: Only 1 should be allowed (20 + 10 = 30, remaining 2 would exceed)
      expect(allowedCount).toBe(1);
      expect(rejectedCount).toBe(2);
    }, 30000);

    it('should handle concurrent requests with pending orders', async () => {
      // Setup: max = 30, current = 15 (position) + 5 (pending) = 20
      // Scenario: 3 concurrent requests, each trying to add 10 USDT
      // Expected: Only 1 should pass (20 + 10 = 30), 2 should be rejected

      const strategyId = await createTestStrategy();
      await createTestPosition(strategyId, 15); // Existing position
      await createTestEntryOrder(strategyId, 5); // Pending order

      const numConcurrentRequests = 3;
      const amountPerRequest = 10;

      const promises = Array.from({ length: numConcurrentRequests }, () => 
        positionLimitService.canOpenNewPosition({
          botId: testBotId,
          symbol: testSymbol,
          newOrderAmount: amountPerRequest
        })
      );

      const results = await Promise.all(promises);
      const allowedCount = results.filter(r => r === true).length;
      const rejectedCount = results.filter(r => r === false).length;

      // Verify: Only 1 should be allowed
      expect(allowedCount).toBe(1);
      expect(rejectedCount).toBe(2);
    }, 30000);

    it('should reject all when limit already reached', async () => {
      // Setup: max = 30, current = 30 (exactly at limit)
      // Scenario: 3 concurrent requests, each trying to add 10 USDT
      // Expected: All should be rejected

      const strategyId = await createTestStrategy();
      await createTestPosition(strategyId, 30); // Already at limit

      const numConcurrentRequests = 3;
      const amountPerRequest = 10;

      const promises = Array.from({ length: numConcurrentRequests }, () => 
        positionLimitService.canOpenNewPosition({
          botId: testBotId,
          symbol: testSymbol,
          newOrderAmount: amountPerRequest
        })
      );

      const results = await Promise.all(promises);
      const allowedCount = results.filter(r => r === true).length;
      const rejectedCount = results.filter(r => r === false).length;

      // Verify: All should be rejected
      expect(allowedCount).toBe(0);
      expect(rejectedCount).toBe(3);
    }, 30000);

    it('should handle high concurrency (50+ requests)', async () => {
      // Stress test: 50 concurrent requests
      // Setup: max = 30, current = 0
      // Expected: Only 3 should pass

      const strategyId = await createTestStrategy();
      const numConcurrentRequests = 50;
      const amountPerRequest = 10;
      const maxAmount = 30;

      const promises = Array.from({ length: numConcurrentRequests }, () => 
        positionLimitService.canOpenNewPosition({
          botId: testBotId,
          symbol: testSymbol,
          newOrderAmount: amountPerRequest
        })
      );

      const results = await Promise.all(promises);
      const allowedCount = results.filter(r => r === true).length;
      const rejectedCount = results.filter(r => r === false).length;

      // Verify: Exactly 3 should be allowed
      expect(allowedCount).toBe(3);
      expect(rejectedCount).toBe(47);
    }, 60000); // 60s timeout for stress test

    it('should maintain consistency with sequential and concurrent checks', async () => {
      // Test: Sequential checks vs concurrent checks should give same result
      const strategyId = await createTestStrategy();
      await createTestPosition(strategyId, 10); // Current = 10

      // Sequential checks
      const sequentialResults = [];
      for (let i = 0; i < 3; i++) {
        const result = await positionLimitService.canOpenNewPosition({
          botId: testBotId,
          symbol: testSymbol,
          newOrderAmount: 10
        });
        sequentialResults.push(result);
        // If allowed, simulate creating position (for next check)
        if (result) {
          await createTestPosition(strategyId, 10);
        }
      }

      // Reset
      await pool.execute('DELETE FROM positions WHERE bot_id = ? AND symbol = ?', [testBotId, testSymbol]);
      await createTestPosition(strategyId, 10);

      // Concurrent checks
      const concurrentResults = await Promise.all([
        positionLimitService.canOpenNewPosition({ botId: testBotId, symbol: testSymbol, newOrderAmount: 10 }),
        positionLimitService.canOpenNewPosition({ botId: testBotId, symbol: testSymbol, newOrderAmount: 10 }),
        positionLimitService.canOpenNewPosition({ botId: testBotId, symbol: testSymbol, newOrderAmount: 10 })
      ]);

      // Both should allow exactly 2 more (10 + 10 + 10 = 30, max = 30)
      const sequentialAllowed = sequentialResults.filter(r => r === true).length;
      const concurrentAllowed = concurrentResults.filter(r => r === true).length;

      expect(sequentialAllowed).toBe(2); // Can add 2 more (10 + 10 = 20, total = 30)
      expect(concurrentAllowed).toBe(2); // Should be same
    }, 30000);
  });
});

