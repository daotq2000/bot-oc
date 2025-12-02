import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { OrderService } from '../../../src/services/OrderService.js';
import { mockExchangeService, mockTelegramService } from '../../utils/mocks.js';
import { Position } from '../../../src/models/Position.js';


describe('OrderService', () => {
  let orderService;

  beforeEach(() => {
    Position.create = jest.fn();
    orderService = new OrderService(mockExchangeService, mockTelegramService);
    jest.clearAllMocks();
  });

  describe('shouldUseMarketOrder', () => {
    it('should use market order when price is close to entry', () => {
      const result = orderService.shouldUseMarketOrder('long', 50000, 50010);
      expect(result).toBe(true); // Less than 0.5% difference
    });

    it('should use limit order when price is far from entry', () => {
      const result = orderService.shouldUseMarketOrder('long', 50000, 51000);
      expect(result).toBe(false); // More than 0.5% difference
    });
  });

  describe('executeSignal', () => {
    it('should execute signal and create position', async () => {
      const signal = {
        strategy: { id: 1, symbol: 'BTC/USDT' },
        side: 'long',
        entryPrice: 50000,
        amount: 10,
        tpPrice: 52500,
        slPrice: 47500,
      };

      mockExchangeService.getTickerPrice.mockResolvedValue(49900);
      mockExchangeService.createOrder.mockResolvedValue({ id: 'order_123' });
      Position.create.mockResolvedValue({
        id: 1,
        ...signal,
        status: 'open',
      });

      const position = await orderService.executeSignal(signal);

      expect(mockExchangeService.createOrder).toHaveBeenCalled();
      expect(Position.create).toHaveBeenCalled();
      expect(mockTelegramService.sendOrderNotification).toHaveBeenCalled();
      expect(position).not.toBeNull();
    });
  });
});

