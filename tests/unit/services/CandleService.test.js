import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { CandleService } from '../../../src/services/CandleService.js';
import { Candle } from '../../../src/models/Candle.js';
import { mockExchangeService, mockCandle } from '../../utils/mocks.js';


describe('CandleService', () => {
  let candleService;

  beforeEach(() => {
    candleService = new CandleService(mockExchangeService);
    jest.clearAllMocks();
  });

  describe('updateCandles', () => {
    it('should fetch and update candles from exchange', async () => {
      const candles = [{ ...mockCandle, exchange: undefined }]; // Remove exchange, will be added by service
      mockExchangeService.fetchOHLCV.mockResolvedValue(candles);
      Candle.bulkInsert = jest.fn().mockResolvedValue(1);

      const result = await candleService.updateCandles('BTC/USDT', '1m');

      expect(mockExchangeService.fetchOHLCV).toHaveBeenCalledWith('BTC/USDT', '1m', 100, 'swap');
      // Verify exchange was added to candles
      expect(Candle.bulkInsert).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ exchange: 'mexc', symbol: 'BTC/USDT' })
        ])
      );
      expect(result).toBe(1);
    });

    it('should return 0 if no candles fetched', async () => {
      mockExchangeService.fetchOHLCV.mockResolvedValue([]);

      const result = await candleService.updateCandles('BTC/USDT', '1m');

      expect(result).toBe(0);
      expect(Candle.bulkInsert).not.toHaveBeenCalled();
    });
  });

  describe('getLatestCandle', () => {
    it('should get latest candle from database', async () => {
      Candle.getLatest = jest.fn().mockResolvedValue(mockCandle);

      const result = await candleService.getLatestCandle('BTC/USDT', '1m');

      expect(Candle.getLatest).toHaveBeenCalledWith('mexc', 'BTC/USDT', '1m');
      expect(result).toEqual(mockCandle);
    });
  });

  describe('getPreviousCandle', () => {
    it('should get previous candle from database', async () => {
      const previousCandle = { ...mockCandle, open_time: mockCandle.open_time - 60000 };
      Candle.getPrevious = jest.fn().mockResolvedValue(previousCandle);

      const result = await candleService.getPreviousCandle('BTC/USDT', '1m');

      expect(Candle.getPrevious).toHaveBeenCalledWith('mexc', 'BTC/USDT', '1m');
      expect(result).toEqual(previousCandle);
    });
  });

  describe('calculateCandleMetrics', () => {
    it('should calculate OC and direction for bullish candle', () => {
      const candle = { open: 50000, close: 51000 };
      const metrics = candleService.calculateCandleMetrics(candle);

      expect(metrics.oc).toBe(2.0);
      expect(metrics.direction).toBe('bullish');
    });

    it('should calculate OC and direction for bearish candle', () => {
      const candle = { open: 50000, close: 49000 };
      const metrics = candleService.calculateCandleMetrics(candle);

      expect(metrics.oc).toBe(-2.0);
      expect(metrics.direction).toBe('bearish');
    });

    it('should return neutral for null candle', () => {
      const metrics = candleService.calculateCandleMetrics(null);
      expect(metrics.oc).toBe(0);
      expect(metrics.direction).toBe('neutral');
    });
  });

  describe('isCandleClosed', () => {
    it('should return true if candle is closed', () => {
      const candle = { close_time: Date.now() - 2000 };
      expect(candleService.isCandleClosed(candle)).toBe(true);
    });

    it('should return false if candle is not closed', () => {
      const candle = { close_time: Date.now() + 60000 };
      expect(candleService.isCandleClosed(candle)).toBe(false);
    });

    it('should return false for null candle', () => {
      expect(candleService.isCandleClosed(null)).toBe(false);
    });
  });
});

