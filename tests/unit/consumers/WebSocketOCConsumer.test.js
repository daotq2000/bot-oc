import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

/**
 * Test helper function to determine side based on is_reverse_strategy
 * This replicates the logic from WebSocketOCConsumer.processMatch()
 */
function determineSide(direction, isReverseStrategy) {
  const isReverse = isReverseStrategy !== undefined 
    ? (isReverseStrategy === true || isReverseStrategy === 1 || isReverseStrategy === '1')
    : true; // Default to reverse strategy
  
  return isReverse
    ? (direction === 'bullish' ? 'short' : 'long')  // Reverse: bullish → SHORT, bearish → LONG
    : (direction === 'bullish' ? 'long' : 'short');  // Trend-following: bullish → LONG, bearish → SHORT
}

describe('WebSocketOCConsumer - is_reverse_strategy logic', () => {
  describe('determineSide helper function', () => {
    it('should use reverse strategy (bullish → SHORT, bearish → LONG) when is_reverse_strategy = true', () => {
      expect(determineSide('bullish', true)).toBe('short');
      expect(determineSide('bearish', true)).toBe('long');
    });

    it('should use trend-following strategy (bullish → LONG, bearish → SHORT) when is_reverse_strategy = false', () => {
      expect(determineSide('bullish', false)).toBe('long');
      expect(determineSide('bearish', false)).toBe('short');
    });

    it('should default to reverse strategy when is_reverse_strategy is undefined', () => {
      expect(determineSide('bullish', undefined)).toBe('short');
      expect(determineSide('bearish', undefined)).toBe('long');
    });

    it('should handle is_reverse_strategy as number 1 (true)', () => {
      expect(determineSide('bullish', 1)).toBe('short');
      expect(determineSide('bearish', 1)).toBe('long');
    });

    it('should handle is_reverse_strategy as string "1" (true)', () => {
      expect(determineSide('bullish', '1')).toBe('short');
      expect(determineSide('bearish', '1')).toBe('long');
    });

    it('should handle is_reverse_strategy as number 0 (false)', () => {
      expect(determineSide('bullish', 0)).toBe('long');
      expect(determineSide('bearish', 0)).toBe('short');
    });

    it('should handle is_reverse_strategy as string "0" (false)', () => {
      expect(determineSide('bullish', '0')).toBe('long');
      expect(determineSide('bearish', '0')).toBe('short');
    });

    it('should handle all combinations correctly', () => {
      // Reverse strategy (true)
      expect(determineSide('bullish', true)).toBe('short');
      expect(determineSide('bearish', true)).toBe('long');
      expect(determineSide('bullish', 1)).toBe('short');
      expect(determineSide('bearish', 1)).toBe('long');
      expect(determineSide('bullish', '1')).toBe('short');
      expect(determineSide('bearish', '1')).toBe('long');
      
      // Trend-following strategy (false)
      expect(determineSide('bullish', false)).toBe('long');
      expect(determineSide('bearish', false)).toBe('short');
      expect(determineSide('bullish', 0)).toBe('long');
      expect(determineSide('bearish', 0)).toBe('short');
      expect(determineSide('bullish', '0')).toBe('long');
      expect(determineSide('bearish', '0')).toBe('short');
      
      // Default (undefined)
      expect(determineSide('bullish', undefined)).toBe('short');
      expect(determineSide('bearish', undefined)).toBe('long');
    });
  });
});
