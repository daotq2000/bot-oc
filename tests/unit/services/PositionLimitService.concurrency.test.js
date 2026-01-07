import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { PositionLimitService } from '../../../src/services/PositionLimitService.js';
import { Bot } from '../../../src/models/Bot.js';
import pool from '../../../src/config/database.js';

/**
 * Concurrency test for PositionLimitService
 * Tests race condition scenarios with mocked database
 */
describe('PositionLimitService - Concurrency Tests (Unit)', () => {
  let positionLimitService;
  let originalBotFindById;
  let originalDbExecute;
  let mockCurrentAmount = 0;

  beforeEach(() => {
    jest.clearAllMocks();
    positionLimitService = new PositionLimitService();
    mockCurrentAmount = 0;

    // Mock Bot.findById
    originalBotFindById = Bot.findById;
    Bot.findById = jest.fn().mockResolvedValue({
      id: 1,
      bot_name: 'Test Bot',
      max_amount_per_coin: 30
    });

    // Mock database pool.execute
    originalDbExecute = pool.execute;
    pool.execute = jest.fn().mockImplementation(async (query, params) => {
      // Mock GET_LOCK
      if (query.includes('GET_LOCK')) {
        return [[{ lock_acquired: 1 }]];
      }
      // Mock RELEASE_LOCK
      if (query.includes('RELEASE_LOCK')) {
        return [[{ 'RELEASE_LOCK(?)': 1 }]];
      }
      // Mock SELECT query for amount calculation
      if (query.includes('SUM(CASE WHEN')) {
        return [[{
          positions_amount: mockCurrentAmount,
          pending_orders_amount: 0
        }]];
      }
      return [[]];
    });

    // Mock pool.getConnection
    pool.getConnection = jest.fn().mockResolvedValue({
      execute: pool.execute,
      release: jest.fn()
    });
  });

  afterEach(() => {
    Bot.findById = originalBotFindById;
    pool.execute = originalDbExecute;
  });

  describe('Concurrent limit checks with lock', () => {
    it('should use advisory lock to prevent race condition', async () => {
      // Test: Verify that GET_LOCK is called
      let getLockCalled = false;
      let releaseLockCalled = false;

      pool.getConnection = jest.fn().mockResolvedValue({
        execute: jest.fn().mockImplementation(async (query, params) => {
          if (query.includes('GET_LOCK')) {
            getLockCalled = true;
            return [[{ lock_acquired: 1 }]];
          }
          if (query.includes('RELEASE_LOCK')) {
            releaseLockCalled = true;
            return [[{ 'RELEASE_LOCK(?)': 1 }]];
          }
          if (query.includes('SUM(CASE WHEN')) {
            return [[{
              positions_amount: 0,
              pending_orders_amount: 0
            }]];
          }
          return [[]];
        }),
        release: jest.fn()
      });

      const result = await positionLimitService.canOpenNewPosition({
        botId: 1,
        symbol: 'BTC/USDT',
        newOrderAmount: 10
      });

      // Verify lock was acquired and released
      expect(getLockCalled).toBe(true);
      expect(releaseLockCalled).toBe(true);
      expect(result).toBe(true);
    });

    it('should check limit correctly with existing positions', async () => {
      // Test: Verify limit check with existing positions
      pool.getConnection = jest.fn().mockResolvedValue({
        execute: jest.fn().mockImplementation(async (query, params) => {
          if (query.includes('GET_LOCK')) {
            return [[{ lock_acquired: 1 }]];
          }
          if (query.includes('RELEASE_LOCK')) {
            return [[{ 'RELEASE_LOCK(?)': 1 }]];
          }
          if (query.includes('SUM(CASE WHEN')) {
            // Simulate existing position: 20 USDT
            return [[{
              positions_amount: 20,
              pending_orders_amount: 0
            }]];
          }
          return [[]];
        }),
        release: jest.fn()
      });

      // Try to add 10 USDT: 20 + 10 = 30, should pass (30 < 30 is false, but 30 >= 30 is true)
      const result1 = await positionLimitService.canOpenNewPosition({
        botId: 1,
        symbol: 'BTC/USDT',
        newOrderAmount: 10
      });

      // Should reject: 20 + 10 = 30 >= 30
      expect(result1).toBe(false);

      // Try to add 5 USDT: 20 + 5 = 25, should pass
      const result2 = await positionLimitService.canOpenNewPosition({
        botId: 1,
        symbol: 'BTC/USDT',
        newOrderAmount: 5
      });

      // Should allow: 20 + 5 = 25 < 30
      expect(result2).toBe(true);
    });

    it('should reject all when limit already reached', async () => {
      // Setup: max = 30, current = 30
      // Scenario: 3 concurrent requests
      // Expected: All should be rejected

      mockCurrentAmount = 30;

      pool.execute = jest.fn().mockImplementation(async (query, params) => {
        if (query.includes('GET_LOCK')) {
          return [[{ lock_acquired: 1 }]];
        }
        if (query.includes('RELEASE_LOCK')) {
          return [[{ 'RELEASE_LOCK(?)': 1 }]];
        }
        if (query.includes('SUM(CASE WHEN')) {
          return [[{
            positions_amount: mockCurrentAmount,
            pending_orders_amount: 0
          }]];
        }
        return [[]];
      });

      const promises = Array.from({ length: 3 }, () => 
        positionLimitService.canOpenNewPosition({
          botId: 1,
          symbol: 'BTC/USDT',
          newOrderAmount: 10
        })
      );

      const results = await Promise.all(promises);
      const resultAllowedCount = results.filter(r => r === true).length;

      // Verify: All should be rejected
      expect(resultAllowedCount).toBe(0);
    }, 30000);

    it('should handle lock timeout gracefully', async () => {
      // Test: When lock acquisition fails (timeout)
      // Mock getConnection to return a connection that fails to acquire lock
      pool.getConnection = jest.fn().mockResolvedValue({
        execute: jest.fn().mockImplementation(async (query, params) => {
          if (query.includes('GET_LOCK')) {
            return [[{ lock_acquired: 0 }]]; // Lock acquisition failed
          }
          return [[]];
        }),
        release: jest.fn()
      });

      const result = await positionLimitService.canOpenNewPosition({
        botId: 1,
        symbol: 'BTC/USDT',
        newOrderAmount: 10
      });

      // Should reject when lock fails (fail-safe)
      expect(result).toBe(false);
    });

    it('should always release lock even on error', async () => {
      let releaseLockCalled = false;
      let getLockCalled = false;

      // Mock getConnection to return a connection
      pool.getConnection = jest.fn().mockResolvedValue({
        execute: jest.fn().mockImplementation(async (query, params) => {
          if (query.includes('GET_LOCK')) {
            getLockCalled = true;
            return [[{ lock_acquired: 1 }]];
          }
          if (query.includes('RELEASE_LOCK')) {
            releaseLockCalled = true;
            return [[{ 'RELEASE_LOCK(?)': 1 }]];
          }
          if (query.includes('SUM(CASE WHEN')) {
            throw new Error('Database error');
          }
          return [[]];
        }),
        release: jest.fn()
      });

      // Mock Bot.findById to throw error after lock is acquired
      Bot.findById = jest.fn().mockRejectedValue(new Error('Bot not found'));

      const result = await positionLimitService.canOpenNewPosition({
        botId: 1,
        symbol: 'BTC/USDT',
        newOrderAmount: 10
      });

      // Should return true (error handling allows to prevent blocking)
      // But lock should still be released
      expect(getLockCalled).toBe(true);
      expect(releaseLockCalled).toBe(true);
    });
  });
});

