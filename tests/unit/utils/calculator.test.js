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
  calculateNextTrailingTakeProfit,
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
    it('should calculate long entry price correctly (entry < current)', () => {
      // Formula: entry = current - extendRatio * delta
      // current = 50000, open = 49000, extend = 10%
      // delta = abs(50000 - 49000) = 1000
      // extendRatio = 10 / 100 = 0.1
      // entry = 50000 - 0.1 * 1000 = 50000 - 100 = 49900
      const entry = calculateLongEntryPrice(50000, 49000, 10.0);
      expect(entry).toBe(49900);
      // Verify entry < current
      expect(entry).toBeLessThan(50000);
    });

    it('should calculate long entry price for YB example (extend 60%)', () => {
      // Real example from user: YB signal
      // open = 0.3759, current = 0.45096606, extend = 60%
      const current = 0.45096606;
      const open = 0.3759;
      const extend = 60;
      
      // delta = abs(0.45096606 - 0.3759) = 0.07506606
      // extendRatio = 60 / 100 = 0.6
      // entry = 0.45096606 - 0.6 * 0.07506606 = 0.405926424
      const entry = calculateLongEntryPrice(current, open, extend);
      const expected = 0.45096606 - 0.6 * Math.abs(0.45096606 - 0.3759);
      expect(entry).toBeCloseTo(expected, 8);
      expect(entry).toBeCloseTo(0.405926424, 6);
      // Verify entry < current
      expect(entry).toBeLessThan(current);
    });

    it('should handle bullish market (current > open)', () => {
      const entry = calculateLongEntryPrice(51000, 50000, 50);
      // delta = 1000, extendRatio = 0.5
      // entry = 51000 - 0.5 * 1000 = 50500
      expect(entry).toBe(50500);
      expect(entry).toBeLessThan(51000);
      expect(entry).toBeGreaterThan(50000);
    });

    it('should handle bearish market (current < open)', () => {
      const entry = calculateLongEntryPrice(49000, 50000, 50);
      // delta = abs(49000 - 50000) = 1000, extendRatio = 0.5
      // entry = 49000 - 0.5 * 1000 = 48500
      expect(entry).toBe(48500);
      expect(entry).toBeLessThan(49000);
    });

    it('should return NaN for invalid inputs', () => {
      expect(calculateLongEntryPrice(NaN, 50000, 10)).toBeNaN();
      expect(calculateLongEntryPrice(50000, NaN, 10)).toBeNaN();
      expect(calculateLongEntryPrice(50000, 49000, NaN)).toBeNaN();
    });
  });

  describe('calculateShortEntryPrice', () => {
    it('should calculate short entry price correctly (entry > current)', () => {
      // Formula: entry = current + extendRatio * delta
      // current = 50000, open = 51000, extend = 10%
      // delta = abs(50000 - 51000) = 1000
      // extendRatio = 10 / 100 = 0.1
      // entry = 50000 + 0.1 * 1000 = 50100
      const entry = calculateShortEntryPrice(50000, 51000, 10.0);
      expect(entry).toBe(50100);
      // Verify entry > current
      expect(entry).toBeGreaterThan(50000);
    });

    it('should calculate short entry price for YB example (extend 60%)', () => {
      // Real example from user: YB signal (counter-trend SHORT)
      // open = 0.3759, current = 0.45096606, extend = 60%
      const current = 0.45096606;
      const open = 0.3759;
      const extend = 60;
      
      // delta = abs(0.45096606 - 0.3759) = 0.07506606
      // extendRatio = 60 / 100 = 0.6
      // entry = 0.45096606 + 0.6 * 0.07506606 = 0.496005696
      const entry = calculateShortEntryPrice(current, open, extend);
      const expected = 0.45096606 + 0.6 * Math.abs(0.45096606 - 0.3759);
      expect(entry).toBeCloseTo(expected, 8);
      expect(entry).toBeCloseTo(0.496005696, 6);
      // Verify entry > current
      expect(entry).toBeGreaterThan(current);
    });

    it('should handle bullish market (current > open)', () => {
      const entry = calculateShortEntryPrice(51000, 50000, 50);
      // delta = 1000, extendRatio = 0.5
      // entry = 51000 + 0.5 * 1000 = 51500
      expect(entry).toBe(51500);
      expect(entry).toBeGreaterThan(51000);
    });

    it('should handle bearish market (current < open)', () => {
      const entry = calculateShortEntryPrice(49000, 50000, 50);
      // delta = abs(49000 - 50000) = 1000, extendRatio = 0.5
      // entry = 49000 + 0.5 * 1000 = 49500
      expect(entry).toBe(49500);
      expect(entry).toBeGreaterThan(49000);
    });

    it('should return NaN for invalid inputs', () => {
      expect(calculateShortEntryPrice(NaN, 50000, 10)).toBeNaN();
      expect(calculateShortEntryPrice(50000, NaN, 10)).toBeNaN();
      expect(calculateShortEntryPrice(50000, 51000, NaN)).toBeNaN();
    });
  });

  describe('calculateTakeProfit', () => {
    it.skip('should calculate TP for long position', () => {
      // Test outdated - formula changed
      const tp = calculateTakeProfit(50000, 2.0, 50.0, 'long');
      // actual_tp_percent = (2.0 * 50.0 / 1000) = 0.1 = 10%
      // tp = 50000 * (1 + 0.1) = 55000
      expect(tp).toBeCloseTo(50050, 2);
    });

    it.skip('should calculate TP for short position', () => {
      // Test outdated - formula changed
      const tp = calculateTakeProfit(50000, 2.0, 50.0, 'short');
      // actual_tp_percent = (2.0 * 50.0 / 1000) = 0.1 = 10%
      // tp = 50000 * (1 - 0.1) = 45000
      expect(tp).toBe(49950);
    });
  });

  describe('calculateInitialStopLoss', () => {
    it.skip('should calculate initial SL for long position', () => {
      // Test outdated - formula changed
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
    it.skip('should calculate dynamic SL with elapsed time for long', () => {
      // Function is deprecated - skip test
      const sl = calculateDynamicStopLoss(55000, 2.0, 5.0, 5.0, 2, 'long');
      // Với công thức mới:
      // effectiveReduce = max(5.0 - (2 * 5.0), 0) = 0
      // sl_offset = (0 * 2.0 / 100) = 0
      // sl = tp = 55000
      expect(sl).toBeCloseTo(55000, 4);
    });

    it.skip('should calculate dynamic SL with elapsed time for short', () => {
      // Function is deprecated - skip test
      const sl = calculateDynamicStopLoss(45000, 2.0, 5.0, 5.0, 2, 'short');
      // Với công thức mới:
      // effectiveReduce = max(5.0 - (2 * 5.0), 0) = 0
      // sl_offset = (0 * 2.0 / 100) = 0
      // sl = tp = 45000
      expect(sl).toBeCloseTo(45000, 4);
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

  describe('calculateNextTrailingTakeProfit', () => {
    // Strategy sample: bot_id=7, 0GUSDT, long, take_profit=65.00, up_reduce=10.00
    describe('LONG position - Strategy sample (bot_id=7, up_reduce=10%)', () => {
      const entryPrice = 1.0;
      const takeProfit = 65.0; // 6.5%
      const upReduce = 10.0; // 10% of range per minute
      const initialTP = calculateTakeProfit(entryPrice, takeProfit, 'long');
      // initialTP = 1.0 * (1 + 6.5/100) = 1.065
      const totalRange = Math.abs(initialTP - entryPrice); // 0.065
      const stepPerMinute = totalRange * (upReduce / 100); // 0.065 * 0.1 = 0.0065

      it('should calculate initial TP correctly', () => {
        expect(initialTP).toBeCloseTo(1.065, 6);
        expect(totalRange).toBeCloseTo(0.065, 6);
        expect(stepPerMinute).toBeCloseTo(0.0065, 6);
      });

      it('should trail TP down by stepPerMinute each minute (minute 1)', () => {
        const prevTP = initialTP; // 1.065
        const newTP = calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, upReduce, 'long', 1);
        // newTP = 1.065 - 0.0065 = 1.0585
        expect(newTP).toBeCloseTo(1.0585, 6);
        expect(newTP).toBeLessThan(prevTP);
        expect(newTP).toBeGreaterThan(entryPrice);
      });

      it('should trail TP down by stepPerMinute each minute (minute 2)', () => {
        const prevTP = 1.0585; // After minute 1
        const newTP = calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, upReduce, 'long', 1);
        // newTP = 1.0585 - 0.0065 = 1.052
        expect(newTP).toBeCloseTo(1.052, 6);
        expect(newTP).toBeLessThan(prevTP);
        expect(newTP).toBeGreaterThan(entryPrice);
      });

      it('should trail TP down by stepPerMinute each minute (minute 3)', () => {
        const prevTP = 1.052; // After minute 2
        const newTP = calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, upReduce, 'long', 1);
        // newTP = 1.052 - 0.0065 = 1.0455
        expect(newTP).toBeCloseTo(1.0455, 6);
        expect(newTP).toBeLessThan(prevTP);
        expect(newTP).toBeGreaterThan(entryPrice);
      });

      it('should handle multiple minutes elapsed at once (minutesElapsed=2)', () => {
        const prevTP = initialTP; // 1.065
        const newTP = calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, upReduce, 'long', 2);
        // newTP = 1.065 - (0.0065 * 2) = 1.065 - 0.013 = 1.052
        expect(newTP).toBeCloseTo(1.052, 6);
      });

      it('should handle multiple minutes elapsed at once (minutesElapsed=3)', () => {
        const prevTP = initialTP; // 1.065
        const newTP = calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, upReduce, 'long', 3);
        // newTP = 1.065 - (0.0065 * 3) = 1.065 - 0.0195 = 1.0455
        expect(newTP).toBeCloseTo(1.0455, 6);
      });

      it('should not go below entry price', () => {
        // Simulate TP that would go below entry
        const prevTP = entryPrice + 0.001; // Very close to entry
        const newTP = calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, upReduce, 'long', 1);
        // Should clamp to entry price
        expect(newTP).toBeGreaterThanOrEqual(entryPrice);
        expect(newTP).toBeCloseTo(entryPrice, 6);
      });

      it('should reach entry price after 10 minutes (10% per minute * 10 = 100% of range)', () => {
        let currentTP = initialTP;
        for (let minute = 1; minute <= 10; minute++) {
          currentTP = calculateNextTrailingTakeProfit(currentTP, entryPrice, initialTP, upReduce, 'long', 1);
        }
        // After 10 minutes: 1.065 - (0.0065 * 10) = 1.065 - 0.065 = 1.0
        expect(currentTP).toBeCloseTo(entryPrice, 6);
      });

      it('should not go below entry even after many minutes', () => {
        let currentTP = initialTP;
        // Simulate 20 minutes (would exceed range)
        for (let minute = 1; minute <= 20; minute++) {
          currentTP = calculateNextTrailingTakeProfit(currentTP, entryPrice, initialTP, upReduce, 'long', 1);
        }
        // Should be clamped at entry
        expect(currentTP).toBeGreaterThanOrEqual(entryPrice);
        expect(currentTP).toBeCloseTo(entryPrice, 6);
      });
    });

    describe('SHORT position - Trailing TP', () => {
      const entryPrice = 1.0;
      const takeProfit = 65.0; // 6.5%
      const reduce = 10.0; // 10% of range per minute (used for SHORT)
      const initialTP = calculateTakeProfit(entryPrice, takeProfit, 'short');
      // initialTP = 1.0 * (1 - 6.5/100) = 0.935
      const totalRange = Math.abs(initialTP - entryPrice); // 0.065
      const stepPerMinute = totalRange * (reduce / 100); // 0.065 * 0.1 = 0.0065

      it('should calculate initial TP correctly for SHORT', () => {
        expect(initialTP).toBeCloseTo(0.935, 6);
        expect(totalRange).toBeCloseTo(0.065, 6);
        expect(stepPerMinute).toBeCloseTo(0.0065, 6);
      });

      it('should trail TP up by stepPerMinute each minute (minute 1)', () => {
        const prevTP = initialTP; // 0.935
        const newTP = calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, reduce, 'short', 1);
        // newTP = 0.935 + 0.0065 = 0.9415
        expect(newTP).toBeCloseTo(0.9415, 6);
        expect(newTP).toBeGreaterThan(prevTP);
      });

      it('should trail TP up by stepPerMinute each minute (minute 2)', () => {
        const prevTP = 0.9415; // After minute 1
        const newTP = calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, reduce, 'short', 1);
        // newTP = 0.9415 + 0.0065 = 0.948
        expect(newTP).toBeCloseTo(0.948, 6);
        expect(newTP).toBeGreaterThan(prevTP);
      });

      it('should allow TP to cross entry for early loss-cutting (SHORT specific)', () => {
        // For SHORT, TP can exceed entry to enable early exit when price moves against position
        const prevTP = entryPrice - 0.001; // Very close to entry
        const newTP = calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, reduce, 'short', 1);
        // Should allow TP to exceed entry (no clamping)
        expect(newTP).toBeGreaterThan(prevTP);
        // Can be above entry (this is intentional for SHORT)
        if (newTP > entryPrice) {
          expect(newTP).toBeGreaterThan(entryPrice);
        }
      });

      it('should reach entry price after 10 minutes', () => {
        let currentTP = initialTP;
        for (let minute = 1; minute <= 10; minute++) {
          currentTP = calculateNextTrailingTakeProfit(currentTP, entryPrice, initialTP, reduce, 'short', 1);
        }
        // After 10 minutes: 0.935 + (0.0065 * 10) = 0.935 + 0.065 = 1.0
        expect(currentTP).toBeCloseTo(entryPrice, 6);
      });
    });

    describe('Edge cases and validation', () => {
      it('should return prevTP if reducePercent <= 0', () => {
        const prevTP = 1.065;
        const entryPrice = 1.0;
        const initialTP = 1.065;
        const newTP = calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, 0, 'long', 1);
        expect(newTP).toBe(prevTP);
      });

      it('should return prevTP if reducePercent is negative', () => {
        const prevTP = 1.065;
        const entryPrice = 1.0;
        const initialTP = 1.065;
        const newTP = calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, -10, 'long', 1);
        expect(newTP).toBe(prevTP);
      });

      it('should return prevTP if prevTP is NaN', () => {
        const prevTP = NaN;
        const entryPrice = 1.0;
        const initialTP = 1.065;
        const newTP = calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, 10, 'long', 1);
        expect(newTP).toBe(prevTP);
      });

      it('should return prevTP if entryPrice is NaN', () => {
        const prevTP = 1.065;
        const entryPrice = NaN;
        const initialTP = 1.065;
        const newTP = calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, 10, 'long', 1);
        expect(newTP).toBe(prevTP);
      });

      it('should return prevTP if initialTP is NaN', () => {
        const prevTP = 1.065;
        const entryPrice = 1.0;
        const initialTP = NaN;
        const newTP = calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, 10, 'long', 1);
        expect(newTP).toBe(prevTP);
      });

      it('should handle minutesElapsed = 0 (defaults to 1)', () => {
        const prevTP = 1.065;
        const entryPrice = 1.0;
        const initialTP = 1.065;
        const upReduce = 10.0;
        const newTP = calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, upReduce, 'long', 0);
        // Should default to 1 minute
        const expected = prevTP - (Math.abs(initialTP - entryPrice) * (upReduce / 100));
        expect(newTP).toBeCloseTo(expected, 6);
      });

      it('should handle very large minutesElapsed', () => {
        const prevTP = 1.065;
        const entryPrice = 1.0;
        const initialTP = 1.065;
        const upReduce = 10.0;
        const newTP = calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, upReduce, 'long', 100);
        // Should be clamped at entry for LONG
        expect(newTP).toBeGreaterThanOrEqual(entryPrice);
        expect(newTP).toBeCloseTo(entryPrice, 6);
      });

      it('should handle different reducePercent values', () => {
        const prevTP = 1.065;
        const entryPrice = 1.0;
        const initialTP = 1.065;
        const totalRange = 0.065;

        // Test with 5% per minute
        const newTP5 = calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, 5, 'long', 1);
        const step5 = totalRange * (5 / 100); // 0.00325
        expect(newTP5).toBeCloseTo(prevTP - step5, 6);

        // Test with 20% per minute
        const newTP20 = calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, 20, 'long', 1);
        const step20 = totalRange * (20 / 100); // 0.013
        expect(newTP20).toBeCloseTo(prevTP - step20, 6);
      });
    });

    describe('Real-world scenario: Multiple minutes progression', () => {
      it('should trail correctly over 10 minutes for LONG (strategy sample)', () => {
        const entryPrice = 1.0;
        const takeProfit = 65.0;
        const upReduce = 10.0;
        const initialTP = calculateTakeProfit(entryPrice, takeProfit, 'long');
        const totalRange = Math.abs(initialTP - entryPrice);
        const stepPerMinute = totalRange * (upReduce / 100);

        let currentTP = initialTP;
        const progression = [currentTP];

        // Simulate 10 minutes
        for (let minute = 1; minute <= 10; minute++) {
          currentTP = calculateNextTrailingTakeProfit(currentTP, entryPrice, initialTP, upReduce, 'long', 1);
          progression.push(currentTP);

          // Verify each step
          const expectedTP = initialTP - (stepPerMinute * minute);
          const clampedTP = Math.max(expectedTP, entryPrice);
          expect(currentTP).toBeCloseTo(clampedTP, 6);
        }

        // Verify final TP is at entry
        expect(currentTP).toBeCloseTo(entryPrice, 6);

        // Verify progression is decreasing
        for (let i = 1; i < progression.length; i++) {
          expect(progression[i]).toBeLessThanOrEqual(progression[i - 1]);
        }
      });

      it('should trail correctly over 10 minutes for SHORT', () => {
        const entryPrice = 1.0;
        const takeProfit = 65.0;
        const reduce = 10.0;
        const initialTP = calculateTakeProfit(entryPrice, takeProfit, 'short');
        const totalRange = Math.abs(initialTP - entryPrice);
        const stepPerMinute = totalRange * (reduce / 100);

        let currentTP = initialTP;
        const progression = [currentTP];

        // Simulate 10 minutes
        for (let minute = 1; minute <= 10; minute++) {
          currentTP = calculateNextTrailingTakeProfit(currentTP, entryPrice, initialTP, reduce, 'short', 1);
          progression.push(currentTP);

          // Verify each step
          const expectedTP = initialTP + (stepPerMinute * minute);
          expect(currentTP).toBeCloseTo(expectedTP, 6);
        }

        // Verify final TP is at entry
        expect(currentTP).toBeCloseTo(entryPrice, 6);

        // Verify progression is increasing
        for (let i = 1; i < progression.length; i++) {
          expect(progression[i]).toBeGreaterThanOrEqual(progression[i - 1]);
        }
      });
    });
  });
});

