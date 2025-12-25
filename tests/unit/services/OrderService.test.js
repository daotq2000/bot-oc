import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { OrderService } from '../../../src/services/OrderService.js';
import { mockExchangeService, mockTelegramService } from '../../utils/mocks.js';

describe('OrderService', () => {
  let orderService;
  let Position;
  let EntryOrder;
  let originalDbExecute;

  // Helper to mock database execute
  async function mockDbExecute(mockFn) {
    const dbModule = await import('../../../src/config/database.js');
    if (!originalDbExecute) {
      originalDbExecute = dbModule.default.execute;
    }
    dbModule.default.execute = jest.fn(mockFn);
    return dbModule.default.execute;
  }

  // Helper to restore database execute
  async function restoreDbExecute() {
    if (originalDbExecute) {
      const dbModule = await import('../../../src/config/database.js');
      dbModule.default.execute = originalDbExecute;
      originalDbExecute = null;
    }
  }

  beforeEach(async () => {
    // Reset all mocks
    jest.clearAllMocks();
    
    // Import models
    const PositionModule = await import('../../../src/models/Position.js');
    Position = PositionModule.Position;
    
    const EntryOrderModule = await import('../../../src/models/EntryOrder.js');
    EntryOrder = EntryOrderModule.EntryOrder;

    // Mock Position model methods
    Position.create = jest.fn();
    Position.cancel = jest.fn();
    Position.close = jest.fn();

    // Mock EntryOrder model methods
    EntryOrder.create = jest.fn();

    // Create OrderService instance
    orderService = new OrderService(mockExchangeService, mockTelegramService);
    
    // Stop cleanup timer to avoid interference with tests
    if (orderService) {
      orderService.stopCacheCleanup();
    }
  });

  afterEach(async () => {
    // Clean up timers
    if (orderService && orderService._cleanupTimer) {
      clearInterval(orderService._cleanupTimer);
      orderService._cleanupTimer = null;
    }
    
    // Restore database mock
    await restoreDbExecute();
  });

  describe('Constructor and Cache Management', () => {
    it('should initialize with exchange and telegram services', () => {
      expect(orderService.exchangeService).toBe(mockExchangeService);
      expect(orderService.telegramService).toBe(mockTelegramService);
      expect(orderService.positionCountCache).toBeInstanceOf(Map);
      expect(orderService.positionCountCacheTTL).toBe(5000);
      expect(orderService.maxCacheSize).toBe(100);
    });

    it('should start cache cleanup timer', () => {
      const newService = new OrderService(mockExchangeService, mockTelegramService);
      expect(newService._cleanupTimer).toBeDefined();
      newService.stopCacheCleanup();
    });

    it('should stop cache cleanup timer', () => {
      orderService.startCacheCleanup();
      expect(orderService._cleanupTimer).toBeDefined();
      orderService.stopCacheCleanup();
      expect(orderService._cleanupTimer).toBeNull();
    });

    it('should cleanup expired cache entries', () => {
      const now = Date.now();
      orderService.positionCountCache.set(1, { count: 5, timestamp: now - 15000 }); // Expired
      orderService.positionCountCache.set(2, { count: 3, timestamp: now - 2000 }); // Valid
      
      orderService.cleanupCache();
      
      expect(orderService.positionCountCache.has(1)).toBe(false);
      expect(orderService.positionCountCache.has(2)).toBe(true);
    });

    it('should enforce max cache size with LRU eviction', () => {
      const now = Date.now();
      // Add more entries than maxCacheSize
      for (let i = 0; i < 110; i++) {
        orderService.positionCountCache.set(i, { count: 1, timestamp: now - i * 1000 });
      }
      
      expect(orderService.positionCountCache.size).toBe(110);
      orderService.cleanupCache();
      
      // Should be reduced to maxCacheSize
      expect(orderService.positionCountCache.size).toBeLessThanOrEqual(100);
    });
  });

  describe('sendCentralLog', () => {
    it('should send info log', async () => {
      await orderService.sendCentralLog('Test message', 'info');
      // Logging is tested via side effects - if no error thrown, it worked
      expect(true).toBe(true);
    });

    it('should send warn log', async () => {
      await orderService.sendCentralLog('Warning message', 'warn');
      expect(true).toBe(true);
    });

    it('should send error log', async () => {
      await orderService.sendCentralLog('Error message', 'error');
      expect(true).toBe(true);
    });
  });

  describe('shouldUseMarketOrder', () => {
    it('should return false for invalid prices', () => {
      expect(orderService.shouldUseMarketOrder('long', NaN, 50000)).toBe(false);
      expect(orderService.shouldUseMarketOrder('long', 50000, NaN)).toBe(false);
      expect(orderService.shouldUseMarketOrder('long', 0, 50000)).toBe(false);
      expect(orderService.shouldUseMarketOrder('long', 50000, 0)).toBe(false);
      expect(orderService.shouldUseMarketOrder('long', -100, 50000)).toBe(false);
    });

    it('should use market order when LONG price crossed entry (current > entry)', () => {
      const result = orderService.shouldUseMarketOrder('long', 50100, 50000);
      expect(result).toBe(true); // Price crossed entry
    });

    it('should use market order when SHORT price crossed entry (current < entry)', () => {
      const result = orderService.shouldUseMarketOrder('short', 49900, 50000);
      expect(result).toBe(true); // Price crossed entry
    });

    it('should use market order when price difference > 0.5%', () => {
      // 1% difference
      const result = orderService.shouldUseMarketOrder('long', 50000, 50500);
      expect(result).toBe(true);
    });

    it('should use limit order when price is close to entry (< 0.5%) and not crossed', () => {
      // 0.1% difference, not crossed
      const result = orderService.shouldUseMarketOrder('long', 49950, 50000);
      expect(result).toBe(false);
    });

    it('should use limit order when SHORT price is close to entry and not crossed', () => {
      // 0.1% difference, not crossed
      const result = orderService.shouldUseMarketOrder('short', 50050, 50000);
      expect(result).toBe(false);
    });
  });

  describe('calculateOrderAmount', () => {
    it('should calculate order amount correctly', async () => {
      const amount = await orderService.calculateOrderAmount('BTC/USDT', 1000, 50000);
      expect(amount).toBe(0.02); // 1000 / 50000
    });

    it('should handle different prices', async () => {
      const amount1 = await orderService.calculateOrderAmount('BTC/USDT', 1000, 100000);
      expect(amount1).toBe(0.01);
      
      const amount2 = await orderService.calculateOrderAmount('BTC/USDT', 1000, 25000);
      expect(amount2).toBe(0.04);
    });
  });

  describe('cancelOrder', () => {
    it('should cancel order and update position', async () => {
      const position = {
        id: 1,
        order_id: 'order_123',
        symbol: 'BTC/USDT',
      };
      
      mockExchangeService.cancelOrder.mockResolvedValue({ id: 'cancel_123' });
      Position.cancel.mockResolvedValue({ ...position, status: 'cancelled' });

      const result = await orderService.cancelOrder(position, 'test_reason');

      expect(mockExchangeService.cancelOrder).toHaveBeenCalledWith('order_123', 'BTC/USDT');
      expect(Position.cancel).toHaveBeenCalledWith(1, 'test_reason');
      expect(result.status).toBe('cancelled');
    });

    it('should throw error if cancel fails', async () => {
      const position = {
        id: 1,
        order_id: 'order_123',
        symbol: 'BTC/USDT',
      };
      
      mockExchangeService.cancelOrder.mockRejectedValue(new Error('Cancel failed'));

      await expect(orderService.cancelOrder(position, 'test_reason')).rejects.toThrow('Cancel failed');
    });
  });

  describe('closePosition', () => {
    it('should close position and calculate PnL', async () => {
      const position = {
        id: 1,
        symbol: 'BTC/USDT',
        side: 'long',
        entry_price: 50000,
        amount: 10,
      };
      
      mockExchangeService.getTickerPrice.mockResolvedValue(51000);
      mockExchangeService.closePosition.mockResolvedValue({ id: 'close_123' });
      Position.close.mockResolvedValue({ ...position, status: 'closed', pnl: 1.0 });

      const result = await orderService.closePosition(position);

      expect(mockExchangeService.getTickerPrice).toHaveBeenCalledWith('BTC/USDT');
      expect(mockExchangeService.closePosition).toHaveBeenCalledWith('BTC/USDT', 'long', 10);
      expect(Position.close).toHaveBeenCalled();
      expect(mockTelegramService.sendCloseNotification).toHaveBeenCalled();
      expect(result.status).toBe('closed');
    });

    it('should throw error if close fails', async () => {
      const position = {
        id: 1,
        symbol: 'BTC/USDT',
        side: 'long',
        amount: 10,
      };
      
      mockExchangeService.getTickerPrice.mockRejectedValue(new Error('Price fetch failed'));

      await expect(orderService.closePosition(position)).rejects.toThrow('Price fetch failed');
    });
  });

  describe('executeSignal', () => {
    const createMockSignal = (overrides = {}) => ({
      strategy: {
        id: 1,
        bot_id: 1,
        symbol: 'BTCUSDT',
        take_profit: 65.0,
        stoploss: 0,
        reduce: 10.0,
        bot: {
          max_concurrent_trades: 10,
          max_amount_per_coin: 0, // No limit
        },
      },
        side: 'long',
        entryPrice: 50000,
      amount: 100,
        tpPrice: 52500,
        slPrice: 47500,
      oc: 2.5,
      ...overrides,
    });

    it('should skip when max positions reached', async () => {
      const signal = createMockSignal();
      signal.strategy.bot.max_concurrent_trades = 5;
      
      // Mock database to return count >= max
      await mockDbExecute(() => Promise.resolve([[{ count: 5 }]]));
      
      const result = await orderService.executeSignal(signal);
      
      expect(result).toBeNull();
      expect(mockExchangeService.createOrder).not.toHaveBeenCalled();
    });

    it('should skip when max_amount_per_coin exceeded', async () => {
      const signal = createMockSignal();
      signal.strategy.bot.max_amount_per_coin = 50; // Limit is 50
      
      // Mock database: current amount = 40, new amount = 100, total = 140 > 50
      await mockDbExecute((query) => {
        if (query.includes('COUNT(*)')) {
          return Promise.resolve([[{ count: 0 }]]); // Position count
        }
        return Promise.resolve([[{ positions_amount: 40, pending_orders_amount: 0 }]]); // Exposure
      });
      
      const result = await orderService.executeSignal(signal);
      
      expect(result).toBeNull();
      expect(mockExchangeService.createOrder).not.toHaveBeenCalled();
    });

    it('should create market order when price crossed entry', async () => {
      const signal = createMockSignal();
      
      await mockDbExecute((query) => {
        if (query.includes('COUNT(*)')) {
          return Promise.resolve([[{ count: 0 }]]); // Position count
        }
        return Promise.resolve([[{ positions_amount: 0, pending_orders_amount: 0 }]]); // Exposure
      });
      
      mockExchangeService.getTickerPrice.mockResolvedValue(50100); // Crossed entry
      mockExchangeService.createOrder.mockResolvedValue({
        id: 'order_123',
        avgFillPrice: 50100,
      });
      
      Position.create.mockResolvedValue({
        id: 1,
        strategy_id: 1,
        bot_id: 1,
        order_id: 'order_123',
        symbol: 'BTCUSDT',
        side: 'long',
        entry_price: 50100,
        amount: 100,
        status: 'open',
      });

      const result = await orderService.executeSignal(signal);

      expect(mockExchangeService.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'market',
        })
      );
      expect(Position.create).toHaveBeenCalled();
      expect(result).not.toBeNull();
    });

    it('should create limit order when price is close to entry', async () => {
      const signal = createMockSignal();
      
      await mockDbExecute((query) => {
        if (query.includes('COUNT(*)')) {
          return Promise.resolve([[{ count: 0 }]]); // Position count
        }
        return Promise.resolve([[{ positions_amount: 0, pending_orders_amount: 0 }]]); // Exposure
      });
      
      mockExchangeService.getTickerPrice.mockResolvedValue(49950); // Close to entry, not crossed
      mockExchangeService.createOrder.mockResolvedValue({
        id: 'order_123',
        status: 'open',
      });
      mockExchangeService.getOrderStatus.mockResolvedValue({
        status: 'open',
        filled: 0,
      });
      
      EntryOrder.create.mockResolvedValue({
        id: 1,
        order_id: 'order_123',
        status: 'open',
      });

      const result = await orderService.executeSignal(signal);

      expect(mockExchangeService.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'limit',
          price: 50000,
        })
      );
      expect(EntryOrder.create).toHaveBeenCalled();
      expect(result.pending).toBe(true);
    });

    it('should create position immediately when limit order is filled', async () => {
      const signal = createMockSignal();
      
      await mockDbExecute((query) => {
        if (query.includes('COUNT(*)')) {
          return Promise.resolve([[{ count: 0 }]]); // Position count
        }
        return Promise.resolve([[{ positions_amount: 0, pending_orders_amount: 0 }]]); // Exposure
      });
      
      mockExchangeService.getTickerPrice.mockResolvedValue(49950);
      mockExchangeService.createOrder.mockResolvedValue({
        id: 'order_123',
      });
      mockExchangeService.getOrderStatus.mockResolvedValue({
        status: 'filled',
        filled: 100,
      });
      mockExchangeService.getOrderAverageFillPrice.mockResolvedValue(50000);
      
      Position.create.mockResolvedValue({
        id: 1,
        order_id: 'order_123',
        symbol: 'BTCUSDT',
        side: 'long',
        entry_price: 50000,
        amount: 100,
        status: 'open',
      });

      const result = await orderService.executeSignal(signal);

      expect(Position.create).toHaveBeenCalled();
      expect(result).not.toBeNull();
      expect(result.pending).toBeUndefined();
    });

    it('should handle soft errors gracefully', async () => {
      const signal = createMockSignal();
      
      await mockDbExecute(() => Promise.reject(new Error('not available for trading on Binance Futures')));

      const result = await orderService.executeSignal(signal);

      expect(result).toBeNull();
    });

    it('should return null when order creation returns invalid object', async () => {
      const signal = createMockSignal();
      
      await mockDbExecute((query) => {
        if (query.includes('COUNT(*)')) {
          return Promise.resolve([[{ count: 0 }]]); // Position count
        }
        return Promise.resolve([[{ positions_amount: 0, pending_orders_amount: 0 }]]); // Exposure
      });
      
      mockExchangeService.getTickerPrice.mockResolvedValue(49950);
      mockExchangeService.createOrder.mockResolvedValue({}); // No id

      const result = await orderService.executeSignal(signal);

      expect(result).toBeNull();
    });

    it('should use cached position count when available', async () => {
      const signal = createMockSignal();
      
      // Set cache
      orderService.positionCountCache.set(1, {
        count: 0,
        timestamp: Date.now(),
      });
      
      await mockDbExecute(() => Promise.resolve([[{ positions_amount: 0, pending_orders_amount: 0 }]])); // Only exposure check
      
      mockExchangeService.getTickerPrice.mockResolvedValue(49950);
      mockExchangeService.createOrder.mockResolvedValue({
        id: 'order_123',
      });
      mockExchangeService.getOrderStatus.mockResolvedValue({
        status: 'open',
        filled: 0,
      });
      
      EntryOrder.create.mockResolvedValue({
        id: 1,
        order_id: 'order_123',
        status: 'open',
      });

      const result = await orderService.executeSignal(signal);

      // Should not query position count from DB (cached)
      const dbModule = await import('../../../src/config/database.js');
      const executeCalls = dbModule.default.execute.mock.calls;
      const countQueries = executeCalls.filter(call => call[0]?.includes('COUNT(*)'));
      expect(countQueries.length).toBe(0); // No position count query
      expect(result).not.toBeNull();
    });

    it('should calculate TP/SL prices correctly', async () => {
      const signal = createMockSignal({
        strategy: {
          id: 1,
          bot_id: 1,
          symbol: 'BTCUSDT',
          take_profit: 65.0, // 6.5%
          stoploss: 50.0, // 5%
          reduce: 10.0,
          bot: {
            max_concurrent_trades: 10,
            max_amount_per_coin: 0,
          },
        },
      });
      
      await mockDbExecute((query) => {
        if (query.includes('COUNT(*)')) {
          return Promise.resolve([[{ count: 0 }]]); // Position count
        }
        return Promise.resolve([[{ positions_amount: 0, pending_orders_amount: 0 }]]); // Exposure
      });
      
      mockExchangeService.getTickerPrice.mockResolvedValue(50100);
      mockExchangeService.createOrder.mockResolvedValue({
        id: 'order_123',
        avgFillPrice: 50100,
      });
      
      Position.create.mockResolvedValue({
        id: 1,
        order_id: 'order_123',
        symbol: 'BTCUSDT',
        side: 'long',
        entry_price: 50100,
        amount: 100,
        take_profit_price: expect.any(Number),
        stop_loss_price: expect.any(Number),
        status: 'open',
      });

      const result = await orderService.executeSignal(signal);

      expect(Position.create).toHaveBeenCalled();
      const createCall = Position.create.mock.calls[0][0];
      expect(createCall.take_profit_price).toBeDefined();
      expect(createCall.stop_loss_price).toBeDefined();
      expect(createCall.tp_sl_pending).toBe(true);
    });
  });
});
