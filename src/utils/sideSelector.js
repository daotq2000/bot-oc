/**
 * Determine side (long/short) based on direction, trade_type, is_reverse_strategy.
 *
 * @param {'bullish'|'bearish'} direction
 * @param {'long'|'short'|'both'} tradeType
 * @param {boolean|number|string|null|undefined} isReverseStrategyRaw - from DB (true/false/1/0/'1'/'0')
 * @returns {'long'|'short'|null} side - null nếu nên skip (không vào lệnh)
 */
export function determineSide(direction, tradeType, isReverseStrategyRaw) {
  const normalizedDirection = String(direction || '').toLowerCase();
  const normalizedTradeType = String(tradeType || 'both').toLowerCase();

  // Normalize is_reverse_strategy (DB có thể trả về 0/1, '0'/'1', boolean)
  const isReverse =
    isReverseStrategyRaw === true ||
    isReverseStrategyRaw === 1 ||
    isReverseStrategyRaw === '1';

  // Trend-following: is_reverse_strategy = false
  if (!isReverse) {
    if (normalizedDirection === 'bullish') {
      // Thị trường tăng → LONG
      if (normalizedTradeType === 'both' || normalizedTradeType === 'long') {
        return 'long';
      }
      return null; // trade_type = 'short' → skip
    } else if (normalizedDirection === 'bearish') {
      // Thị trường giảm → SHORT
      if (normalizedTradeType === 'both' || normalizedTradeType === 'short') {
        return 'short';
      }
      return null; // trade_type = 'long' → skip
    }
    return null;
  }

  // Counter-trend: is_reverse_strategy = true
  if (isReverse) {
    if (normalizedDirection === 'bullish') {
      // Thị trường tăng → SHORT (đánh ngược)
      if (normalizedTradeType === 'both' || normalizedTradeType === 'short') {
        return 'short';
      }
      return null; // trade_type = 'long' → skip
    } else if (normalizedDirection === 'bearish') {
      // Thị trường giảm → LONG (đánh ngược)
      if (normalizedTradeType === 'both' || normalizedTradeType === 'long') {
        return 'long';
      }
      return null; // trade_type = 'short' → skip
    }
    return null;
  }

  return null;
}


