import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { StrategyService } from '../../../src/services/StrategyService.js';
import { mockExchangeService, mockStrategy, mockCandle } from '../../utils/mocks.js';
import { CandleService } from '../../../src/services/CandleService.js';


describe('StrategyService', () => {
  let strategyService;
  let mockCandleService;

  beforeEach(() => {
    mockCandleService = {
      getLatestCandle: jest.fn(),
      getPreviousCandle: jest.fn(),
      isCandleClosed: jest.fn(),
      calculateCandleMetrics: jest.fn().mockReturnValue({ oc: 2.0, direction: 'bullish' }),
    };
    strategyService = new StrategyService(mockExchangeService, mockCandleService);
    jest.clearAllMocks();
  });

  describe('checkSignal', () => {
    it('should return null if no candle data', async () => {
      mockCandleService.getLatestCandle.mockResolvedValue(null);

      const result = await strategyService.checkSignal(mockStrategy);

      expect(result).toBeNull();
    });

    it('should return null if candle not closed', async () => {
      mockCandleService.getLatestCandle.mockResolvedValue(mockCandle);
      mockCandleService.isCandleClosed.mockReturnValue(false);

      const result = await strategyService.checkSignal(mockStrategy);

      expect(result).toBeNull();
    });

    it('should return null if OC below threshold', async () => {
      mockCandleService.getLatestCandle.mockResolvedValue(mockCandle);
      mockCandleService.isCandleClosed.mockReturnValue(true);
      mockCandleService.calculateCandleMetrics.mockReturnValue({ oc: 1.0, direction: 'bullish' });

      const result = await strategyService.checkSignal(mockStrategy);

      expect(result).toBeNull();
    });

    it.skip('should return signal if conditions met', async () => {
      mockCandleService.getLatestCandle.mockResolvedValue(mockCandle);
      mockCandleService.isCandleClosed.mockReturnValue(true);
      mockCandleService.calculateCandleMetrics.mockReturnValue({ oc: 2.5, direction: 'bullish' });
      mockCandleService.getPreviousCandle.mockResolvedValue(null);
      mockExchangeService.getTickerPrice.mockResolvedValue(49900);

      const result = await strategyService.checkSignal(mockStrategy);

      expect(result).not.toBeNull();
      expect(result.side).toBe('long');
      expect(result.strategy).toEqual(mockStrategy);
    });
  });

  describe('checkExtendCondition', () => {
    it('should check extend condition for long', () => {
      const candle = { open: 50000 };
      const entryPrice = 49900;
      const currentPrice = 49800;

      const result = strategyService.checkExtendCondition('long', currentPrice, entryPrice, candle.open);

      expect(result).toBe(true);
    });

    it('should check extend condition for short', () => {
      const candle = { open: 50000 };
      const entryPrice = 50100;
      const currentPrice = 50200;

      const result = strategyService.checkExtendCondition('short', currentPrice, entryPrice, candle.open);

      expect(result).toBe(true);
    });
  });

  describe('calculateEntryPrice', () => {
    it('should calculate entry price for long', () => {
      const candle = { open: 50000 };
      const strategy = { ...mockStrategy, oc: 2.0, extend: 10.0 };

      const entryPrice = strategyService.calculateEntryPrice(candle, strategy, 'long');

      expect(entryPrice).toBe(49900);
    });

    it('should calculate entry price for short', () => {
      const candle = { open: 50000 };
      const strategy = { ...mockStrategy, oc: 2.0, extend: 10.0 };

      const entryPrice = strategyService.calculateEntryPrice(candle, strategy, 'short');

      expect(entryPrice).toBe(50100);
    });
  });
});

