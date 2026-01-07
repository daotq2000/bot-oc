import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { StrategyService } from '../../src/services/StrategyService.js';
import { OrderService } from '../../src/services/OrderService.js';
import { PositionService } from '../../src/services/PositionService.js';
import { mockExchangeService, mockTelegramService, mockStrategy, mockCandle } from '../utils/mocks.js';
import { CandleService } from '../../src/services/CandleService.js';

jest.mock('../../src/services/CandleService.js');
jest.mock('../../src/models/Position.js', () => ({
  Position: {
    create: jest.fn(),
    findOpen: jest.fn(),
    update: jest.fn(),
    findById: jest.fn(),
  },
}));

describe.skip('Trading Flow Integration', () => {
  let strategyService;
  let orderService;
  let positionService;
  let mockCandleService;

  beforeEach(() => {
    mockCandleService = {
      getLatestCandle: jest.fn(),
      getPreviousCandle: jest.fn(),
      isCandleClosed: jest.fn().mockReturnValue(true),
      calculateCandleMetrics: jest.fn(),
    };

    strategyService = new StrategyService(mockExchangeService, mockCandleService);
    orderService = new OrderService(mockExchangeService, mockTelegramService);
    positionService = new PositionService(mockExchangeService);

    jest.clearAllMocks();
  });

  describe('Complete Trading Flow', () => {
    it('should execute complete flow from signal to position', async () => {
      // Setup: Candle meets OC threshold
      const closedCandle = {
        ...mockCandle,
        open: 50000,
        close: 51000,
        close_time: Date.now() - 2000,
      };

      mockCandleService.getLatestCandle.mockResolvedValue(closedCandle);
      mockCandleService.calculateCandleMetrics.mockReturnValue({
        oc: 2.0,
        direction: 'bullish',
      });
      mockCandleService.getPreviousCandle.mockResolvedValue(null);
      mockExchangeService.getTickerPrice.mockResolvedValue(49900);

      // Step 1: Check signal
      const signal = await strategyService.checkSignal(mockStrategy);
      expect(signal).not.toBeNull();
      expect(signal.side).toBe('long');

      // Step 2: Execute order
      const { Position } = await import('../../src/models/Position.js');
      Position.create.mockResolvedValue({
        id: 1,
        ...signal,
        status: 'open',
      });

      const position = await orderService.executeSignal(signal);
      expect(position).not.toBeNull();
      expect(mockExchangeService.createOrder).toHaveBeenCalled();
      expect(mockTelegramService.sendOrderNotification).toHaveBeenCalled();
    });

    it('should monitor position and close on TP hit', async () => {
      const { Position } = await import('../../src/models/Position.js');
      const openPosition = {
        id: 1,
        strategy_id: 1,
        symbol: 'BTC/USDT',
        side: 'long',
        entry_price: 50000,
        amount: 10,
        take_profit_price: 52500,
        stop_loss_price: 47500,
        status: 'open',
        minutes_elapsed: 0,
        reduce: 5,
        up_reduce: 5,
        oc: 2.0,
      };

      Position.findById.mockResolvedValue(openPosition);
      mockExchangeService.getTickerPrice.mockResolvedValue(52500); // TP hit
      Position.update = jest.fn().mockResolvedValue({
        ...openPosition,
        status: 'closed',
        close_price: 52500,
        pnl: 0.5,
      });

      const updated = await positionService.updatePosition(openPosition);

      expect(updated.status).toBe('closed');
      expect(mockExchangeService.closePosition).toHaveBeenCalled();
    });
  });
});

