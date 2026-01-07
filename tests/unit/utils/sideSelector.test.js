import { describe, it, expect } from '@jest/globals';
import { determineSide } from '../../../src/utils/sideSelector.js';

describe('determineSide', () => {
  describe('Trend-following (is_reverse_strategy = false)', () => {
    const isReverse = false;

    it('both + bullish → long', () => {
      expect(determineSide('bullish', 'both', isReverse)).toBe('long');
    });

    it('both + bearish → short', () => {
      expect(determineSide('bearish', 'both', isReverse)).toBe('short');
    });

    it('long + bullish → long', () => {
      expect(determineSide('bullish', 'long', isReverse)).toBe('long');
    });

    it('long + bearish → null (skip)', () => {
      expect(determineSide('bearish', 'long', isReverse)).toBeNull();
    });

    it('short + bearish → short', () => {
      expect(determineSide('bearish', 'short', isReverse)).toBe('short');
    });

    it('short + bullish → null (skip)', () => {
      expect(determineSide('bullish', 'short', isReverse)).toBeNull();
    });
  });

  describe('Counter-trend (is_reverse_strategy = true)', () => {
    const isReverse = true;

    it('both + bullish → short', () => {
      expect(determineSide('bullish', 'both', isReverse)).toBe('short');
    });

    it('both + bearish → long', () => {
      expect(determineSide('bearish', 'both', isReverse)).toBe('long');
    });

    it('short + bullish → short', () => {
      expect(determineSide('bullish', 'short', isReverse)).toBe('short');
    });

    it('short + bearish → null (skip)', () => {
      expect(determineSide('bearish', 'short', isReverse)).toBeNull();
    });

    it('long + bearish → long', () => {
      expect(determineSide('bearish', 'long', isReverse)).toBe('long');
    });

    it('long + bullish → null (skip)', () => {
      expect(determineSide('bullish', 'long', isReverse)).toBeNull();
    });
  });

  describe('is_reverse_strategy raw types', () => {
    it('treats 1 and "1" as true (reverse strategy)', () => {
      expect(determineSide('bullish', 'both', 1)).toBe('short');
      expect(determineSide('bullish', 'both', '1')).toBe('short');
    });

    it('treats 0 and "0" as false (trend-following)', () => {
      expect(determineSide('bullish', 'both', 0)).toBe('long');
      expect(determineSide('bullish', 'both', '0')).toBe('long');
    });

    it('default undefined → trend-following (false)', () => {
      expect(determineSide('bullish', 'both', undefined)).toBe('long');
    });

    it('handles invalid direction gracefully', () => {
      expect(determineSide('invalid', 'both', false)).toBeNull();
    });

    it('handles invalid trade_type gracefully', () => {
      expect(determineSide('bullish', 'invalid', false)).toBeNull();
    });
  });
});


