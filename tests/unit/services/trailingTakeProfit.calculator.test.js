import { describe, it, expect } from '@jest/globals';
import { calculateNextTrailingTakeProfit } from '../../../src/utils/calculator.js';

/**
 * These tests validate the core TP trailing math.
 * They are independent from PositionService time-gating (opened_at / minutes_elapsed).
 */

describe('Trailing Take Profit - calculator (regression)', () => {
  it('LONG: TP should move down towards entry each minute (reduce=10 => 1% per minute)', () => {
    const entry = 100000;
    const initialTP = 110000;
    const reduce = 10; // 1%

    // minute 1
    let tp = calculateNextTrailingTakeProfit(initialTP, entry, initialTP, reduce, 'long', 1);
    expect(tp).toBe(109000);

    // minute 2
    tp = calculateNextTrailingTakeProfit(tp, entry, initialTP, reduce, 'long', 1);
    expect(tp).toBe(108000);

    // minute 10
    for (let i = 0; i < 8; i++) {
      tp = calculateNextTrailingTakeProfit(tp, entry, initialTP, reduce, 'long', 1);
    }
    expect(tp).toBe(100000);
  });

  it('SHORT: TP should move up towards entry each minute (reduce=10 => 1% per minute)', () => {
    const entry = 100000;
    const initialTP = 90000;
    const reduce = 10; // 1%

    // minute 1
    let tp = calculateNextTrailingTakeProfit(initialTP, entry, initialTP, reduce, 'short', 1);
    expect(tp).toBe(91000);

    // minute 2
    tp = calculateNextTrailingTakeProfit(tp, entry, initialTP, reduce, 'short', 1);
    expect(tp).toBe(92000);
  });

  it('LONG: TP is clamped to entry only when step would pass entry', () => {
    const entry = 100000;
    const initialTP = 101000;

    // With current algorithm: step = (initial-entry) * (reduce/100)
    // range=1000. With reduce=50 => step=500 => newTP=100500 (not yet clamped)
    let tp = calculateNextTrailingTakeProfit(initialTP, entry, initialTP, 50, 'long', 1);
    expect(tp).toBe(100500);

    // With reduce=100 => step=1000 => newTP hits entry exactly
    tp = calculateNextTrailingTakeProfit(initialTP, entry, initialTP, 100, 'long', 1);
    expect(tp).toBe(entry);

    // With reduce=200 => step=2000 => would go below entry, should clamp to entry
    tp = calculateNextTrailingTakeProfit(initialTP, entry, initialTP, 200, 'long', 1);
    expect(tp).toBe(entry);
  });
});

