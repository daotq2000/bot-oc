import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { PositionLimitService } from '../../../src/services/PositionLimitService.js';
import { Bot } from '../../../src/models/Bot.js';
import pool from '../../../src/config/database.js';

describe('PositionLimitService', () => {
  let positionLimitService;
  let originalDbExecute;
  let originalBotFindById;

  beforeEach(() => {
    jest.clearAllMocks();
    positionLimitService = new PositionLimitService();

    // Mock Bot.findById
    originalBotFindById = Bot.findById;
    Bot.findById = jest.fn();

    // Mock database pool.execute
    originalDbExecute = pool.execute;
    pool.execute = jest.fn();
  });

  afterEach(() => {
    // Restore original functions
    Bot.findById = originalBotFindById;
    pool.execute = originalDbExecute;
  });

  describe('canOpenNewPosition', () => {
    it('should allow opening when total < max', async () => {
      // Setup: current = 20, new = 5, max = 30 => projected = 25 < 30 => allow
      Bot.findById.mockResolvedValue({
        id: 1,
        bot_name: 'Test Bot',
        max_amount_per_coin: 30
      });

      pool.execute.mockResolvedValue([[
        {
          positions_amount: 20,
          pending_orders_amount: 0
        }
      ]]);

      const result = await positionLimitService.canOpenNewPosition({
        botId: 1,
        symbol: 'BTC/USDT',
        newOrderAmount: 5
      });

      expect(result).toBe(true);
      expect(Bot.findById).toHaveBeenCalledWith(1);
      expect(pool.execute).toHaveBeenCalled();
    });

    it('should reject when exactly hitting the limit (current + new = max)', async () => {
      // Setup: current = 30, new = 10, max = 30 => projected = 40 > 30
      // Actually: current = 20, new = 10, max = 30 => projected = 30 >= 30
      Bot.findById.mockResolvedValue({
        id: 1,
        bot_name: 'Test Bot',
        max_amount_per_coin: 30
      });

      pool.execute.mockResolvedValue([[
        {
          positions_amount: 20,
          pending_orders_amount: 0
        }
      ]]);

      const result = await positionLimitService.canOpenNewPosition({
        botId: 1,
        symbol: 'BTC/USDT',
        newOrderAmount: 10
      });

      // current = 20, new = 10, projected = 30, max = 30 => 30 >= 30 => reject
      expect(result).toBe(false);
    });

    it('should reject when exceeding the limit (current + new > max)', async () => {
      // Setup: current = 25, new = 10, max = 30 => projected = 35 > 30
      Bot.findById.mockResolvedValue({
        id: 1,
        bot_name: 'Test Bot',
        max_amount_per_coin: 30
      });

      pool.execute.mockResolvedValue([[
        {
          positions_amount: 20,
          pending_orders_amount: 5
        }
      ]]);

      const result = await positionLimitService.canOpenNewPosition({
        botId: 1,
        symbol: 'BTC/USDT',
        newOrderAmount: 10
      });

      // current = 25, new = 10, projected = 35, max = 30 => 35 >= 30 => reject
      expect(result).toBe(false);
    });

    it('should reject when current = 0, new = max (edge case - exactly at limit)', async () => {
      // Setup: current = 0, new = 30, max = 30 => projected = 30 >= 30 => reject
      // Business rule: reject when reach or exceed threshold
      Bot.findById.mockResolvedValue({
        id: 1,
        bot_name: 'Test Bot',
        max_amount_per_coin: 30
      });

      pool.execute.mockResolvedValue([[
        {
          positions_amount: 0,
          pending_orders_amount: 0
        }
      ]]);

      const result = await positionLimitService.canOpenNewPosition({
        botId: 1,
        symbol: 'BTC/USDT',
        newOrderAmount: 30
      });

      // current = 0, new = 30, projected = 30, max = 30 => 30 >= 30 => reject
      expect(result).toBe(false);
    });

    it('should allow when current = 0, new < max', async () => {
      // Setup: current = 0, new = 20, max = 30 => projected = 20 < 30 => allow
      Bot.findById.mockResolvedValue({
        id: 1,
        bot_name: 'Test Bot',
        max_amount_per_coin: 30
      });

      pool.execute.mockResolvedValue([[
        {
          positions_amount: 0,
          pending_orders_amount: 0
        }
      ]]);

      const result = await positionLimitService.canOpenNewPosition({
        botId: 1,
        symbol: 'BTC/USDT',
        newOrderAmount: 20
      });

      expect(result).toBe(true);
    });

    it('should reject all orders when max_amount_per_coin = 0', async () => {
      Bot.findById.mockResolvedValue({
        id: 1,
        bot_name: 'Test Bot',
        max_amount_per_coin: 0
      });

      const result = await positionLimitService.canOpenNewPosition({
        botId: 1,
        symbol: 'BTC/USDT',
        newOrderAmount: 10
      });

      expect(result).toBe(false);
      // Should not query database when max = 0
      expect(pool.execute).not.toHaveBeenCalled();
    });

    it('should allow when max_amount_per_coin is not set (null/undefined)', async () => {
      Bot.findById.mockResolvedValue({
        id: 1,
        bot_name: 'Test Bot',
        max_amount_per_coin: null
      });

      const result = await positionLimitService.canOpenNewPosition({
        botId: 1,
        symbol: 'BTC/USDT',
        newOrderAmount: 10
      });

      expect(result).toBe(true);
    });

    it('should allow when max_amount_per_coin is negative (invalid)', async () => {
      Bot.findById.mockResolvedValue({
        id: 1,
        bot_name: 'Test Bot',
        max_amount_per_coin: -10
      });

      const result = await positionLimitService.canOpenNewPosition({
        botId: 1,
        symbol: 'BTC/USDT',
        newOrderAmount: 10
      });

      expect(result).toBe(true);
    });

    it('should include both open positions and pending orders in calculation', async () => {
      Bot.findById.mockResolvedValue({
        id: 1,
        bot_name: 'Test Bot',
        max_amount_per_coin: 30
      });

      pool.execute.mockResolvedValue([[
        {
          positions_amount: 15,
          pending_orders_amount: 10
        }
      ]]);

      const result = await positionLimitService.canOpenNewPosition({
        botId: 1,
        symbol: 'BTC/USDT',
        newOrderAmount: 5
      });

      // current = 15 + 10 = 25, new = 5, projected = 30, max = 30 => 30 >= 30 => reject
      expect(result).toBe(false);
    });

    it('should allow when including pending orders still below max', async () => {
      Bot.findById.mockResolvedValue({
        id: 1,
        bot_name: 'Test Bot',
        max_amount_per_coin: 30
      });

      pool.execute.mockResolvedValue([[
        {
          positions_amount: 10,
          pending_orders_amount: 5
        }
      ]]);

      const result = await positionLimitService.canOpenNewPosition({
        botId: 1,
        symbol: 'BTC/USDT',
        newOrderAmount: 10
      });

      // current = 10 + 5 = 15, new = 10, projected = 25, max = 30 => 25 < 30 => allow
      expect(result).toBe(true);
    });

    it('should handle bot not found gracefully', async () => {
      Bot.findById.mockResolvedValue(null);

      const result = await positionLimitService.canOpenNewPosition({
        botId: 999,
        symbol: 'BTC/USDT',
        newOrderAmount: 10
      });

      // Should allow when bot not found to avoid blocking system
      expect(result).toBe(true);
    });

    it('should handle database errors gracefully', async () => {
      Bot.findById.mockResolvedValue({
        id: 1,
        bot_name: 'Test Bot',
        max_amount_per_coin: 30
      });

      pool.execute.mockRejectedValue(new Error('Database connection failed'));

      const result = await positionLimitService.canOpenNewPosition({
        botId: 1,
        symbol: 'BTC/USDT',
        newOrderAmount: 10
      });

      // Should allow when database error to avoid blocking system
      expect(result).toBe(true);
    });

    it('should handle empty query result (no positions/orders)', async () => {
      Bot.findById.mockResolvedValue({
        id: 1,
        bot_name: 'Test Bot',
        max_amount_per_coin: 30
      });

      pool.execute.mockResolvedValue([[]]);

      const result = await positionLimitService.canOpenNewPosition({
        botId: 1,
        symbol: 'BTC/USDT',
        newOrderAmount: 10
      });

      // current = 0, new = 10, projected = 10, max = 30 => 10 < 30 => allow
      expect(result).toBe(true);
    });

    it('should handle null/undefined amounts correctly', async () => {
      Bot.findById.mockResolvedValue({
        id: 1,
        bot_name: 'Test Bot',
        max_amount_per_coin: 30
      });

      pool.execute.mockResolvedValue([[
        {
          positions_amount: 20,
          pending_orders_amount: null
        }
      ]]);

      const result = await positionLimitService.canOpenNewPosition({
        botId: 1,
        symbol: 'BTC/USDT',
        newOrderAmount: null
      });

      // current = 20 + 0 = 20, new = 0, projected = 20, max = 30 => 20 < 30 => allow
      expect(result).toBe(true);
    });
  });

  describe('getCurrentTotalAmount', () => {
    it('should return sum of positions and pending orders', async () => {
      pool.execute.mockResolvedValue([[
        {
          positions_amount: 15,
          pending_orders_amount: 10
        }
      ]]);

      const result = await positionLimitService.getCurrentTotalAmount(1, 'BTC/USDT');

      expect(result).toBe(25);
      expect(pool.execute).toHaveBeenCalled();
    });

    it('should return 0 when no positions or orders', async () => {
      pool.execute.mockResolvedValue([[
        {
          positions_amount: 0,
          pending_orders_amount: 0
        }
      ]]);

      const result = await positionLimitService.getCurrentTotalAmount(1, 'BTC/USDT');

      expect(result).toBe(0);
    });

    it('should handle database errors and return 0', async () => {
      pool.execute.mockRejectedValue(new Error('Database error'));

      const result = await positionLimitService.getCurrentTotalAmount(1, 'BTC/USDT');

      expect(result).toBe(0);
    });
  });
});

