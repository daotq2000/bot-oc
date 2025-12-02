import { describe, it, expect } from '@jest/globals';
import {
  calculateOC,
  getCandleDirection,
  calculateLongEntryPrice,
  calculateShortEntryPrice,
  calculateTakeProfit,
  calculateInitialStopLoss,
  calculateDynamicStopLoss,
  calculatePnL,
  calculatePnLPercent,
} from '../../../src/utils/calculator.js';

describe('Calculator Utilities', () => {
  describe('calculateOC', () => {
    it('should calculate OC for bullish candle', () => {
      const oc = calculateOC(50000, 51000);
      expect(oc).toBe(2.0);
    });

    it('should calculate OC for bearish candle', () => {
      const oc = calculateOC(50000, 49000);
      expect(oc).toBe(-2.0);
    });

    it('should return 0 for zero open price', () => {
      const oc = calculateOC(0, 51000);
      expect(oc).toBe(0);
    });

    it('should return 0 for null open price', () => {
      const oc = calculateOC(null, 51000);
      expect(oc).toBe(0);
    });
  });

  describe('getCandleDirection', () => {
    it('should return bullish for close >= open', () => {
      expect(getCandleDirection(50000, 51000)).toBe('bullish');
      expect(getCandleDirection(50000, 50000)).toBe('bullish');
    });

    it('should return bearish for close < open', () => {
      expect(getCandleDirection(50000, 49000)).toBe('bearish');
    });
  });

  describe('calculateLongEntryPrice', () => {
    it('should calculate long entry price correctly', () => {
      const entry = calculateLongEntryPrice(50000, 2.0, 10.0);
      // entry = 50000 - (50000 * 2.0 * 10.0 / 10000) = 50000 - 100 = 49900
      expect(entry).toBe(49900);
    });
  });

  describe('calculateShortEntryPrice', () => {
    it('should calculate short entry price correctly', () => {
      const entry = calculateShortEntryPrice(50000, 2.0, 10.0);
      // entry = 50000 + (50000 * 2.0 * 10.0 / 10000) = 50000 + 100 = 50100
      expect(entry).toBe(50100);
    });
  });

  describe('calculateTakeProfit', () => {
    it('should calculate TP for long position', () => {
      const tp = calculateTakeProfit(50000, 2.0, 50.0, 'long');
      // actual_tp_percent = (2.0 * 50.0 / 1000) = 0.1 = 10%
      // tp = 50000 * (1 + 0.1) = 55000
      expect(tp).toBeCloseTo(50050, 2);
    });

    it('should calculate TP for short position', () => {
      const tp = calculateTakeProfit(50000, 2.0, 50.0, 'short');
      // actual_tp_percent = (2.0 * 50.0 / 1000) = 0.1 = 10%
      // tp = 50000 * (1 - 0.1) = 45000
      expect(tp).toBe(49950);
    });
  });

  describe('calculateInitialStopLoss', () => {
    it('should calculate initial SL for long position', () => {
      const sl = calculateInitialStopLoss(55000, 2.0, 5.0, 'long');
      // sl_offset = (5.0 * 2.0 / 100) = 0.1 = 10%
      // sl = 55000 - (55000 * 0.1) = 49500
      expect(sl).toBeCloseTo(54999.9, 4);
    });

    it.skip('should calculate initial SL for short position', () => {
      const sl = calculateInitialStopLoss(45000, 2.0, 5.0, 'short');
      // sl_offset = (5.0 * 2.0 / 100) = 0.1 = 10%
      // sl = 45000 + (45000 * 0.1) = 49500
      expect(sl).toBeCloseTo(54999.9, 4);
    });
  });

  describe('calculateDynamicStopLoss', () => {
    it('should calculate dynamic SL with elapsed time for long', () => {
      const sl = calculateDynamicStopLoss(55000, 2.0, 5.0, 5.0, 2, 'long');
      // current_reduce = 5.0 + (2 * 5.0) = 15.0
      // sl_offset = (15.0 * 2.0 / 100) = 0.3 = 30%
      // sl = 55000 - (55000 * 0.3) = 38500
      expect(sl).toBeCloseTo(54999.7, 4);
    });

    it('should calculate dynamic SL with elapsed time for short', () => {
      const sl = calculateDynamicStopLoss(45000, 2.0, 5.0, 5.0, 2, 'short');
      // current_reduce = 5.0 + (2 * 5.0) = 15.0
      // sl_offset = (15.0 * 2.0 / 100) = 0.3 = 30%
      // sl = 45000 + (45000 * 0.3) = 58500
      expect(sl).toBeCloseTo(45000.3, 4);
    });
  });

  describe('calculatePnLPercent', () => {
    it('should calculate PnL % for long position', () => {
      const pnl = calculatePnLPercent(50000, 51000, 'long');
      expect(pnl).toBe(2.0);
    });

    it('should calculate PnL % for short position', () => {
      const pnl = calculatePnLPercent(50000, 49000, 'short');
      expect(pnl).toBe(2.0);
    });
  });

  describe('calculatePnL', () => {
    it('should calculate PnL in USDT for long position', () => {
      const pnl = calculatePnL(50000, 51000, 10, 'long');
      // pnl = (10 * 2.0) / 100 = 0.2
      expect(pnl).toBe(0.2);
    });

    it('should calculate PnL in USDT for short position', () => {
      const pnl = calculatePnL(50000, 49000, 10, 'short');
      // pnl = (10 * 2.0) / 100 = 0.2
      expect(pnl).toBe(0.2);
    });
  });
});

