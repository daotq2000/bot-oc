/**
 * Trading calculation utilities
 */

/**
 * Calculate OC (Open-Close) percentage
 * @param {number} open - Open price
 * @param {number} close - Close price
 * @returns {number} OC percentage
 */
export function calculateOC(open, close) {
  if (!open || open === 0) return 0;
  return ((close - open) / open) * 100;
}

/**
 * Get candle direction
 * @param {number} open - Open price
 * @param {number} close - Close price
 * @returns {'bullish'|'bearish'}
 */
export function getCandleDirection(open, close) {
  return close >= open ? 'bullish' : 'bearish';
}

/**
 * Calculate entry price for LONG position
 * Entry triggers when price drops below: open - (open * oc * extend / 10000)
 * @param {number} open - Candle open price
 * @param {number} oc - OC percentage
 * @param {number} extend - Extend percentage
 * @returns {number} Entry price
 */
export function calculateLongEntryPrice(open, oc, extend) {
  const entryOffset = (open * oc * extend) / 10000;
  return open - entryOffset;
}

/**
 * Calculate entry price for SHORT position
 * Entry triggers when price rises above: open + (open * oc * extend / 10000)
 * @param {number} open - Candle open price
 * @param {number} oc - OC percentage
 * @param {number} extend - Extend percentage
 * @returns {number} Entry price
 */
export function calculateShortEntryPrice(open, oc, extend) {
  const entryOffset = (open * oc * extend) / 10000;
  return open + entryOffset;
}

/**
 * Calculate take profit price
 * @param {number} entryPrice - Entry price
 * @param {number} oc - OC percentage
 * @param {number} takeProfit - Take profit value (e.g., 50 = 5%)
 * @param {'long'|'short'} side - Position side
 * @returns {number} Take profit price
 */
export function calculateTakeProfit(entryPrice, oc, takeProfit, side) {
  // actual_tp_percent = (oc * take_profit / 1000)
  const actualTPPercent = (oc * takeProfit) / 1000;
  
  if (side === 'long') {
    return entryPrice * (1 + actualTPPercent / 100);
  } else {
    return entryPrice * (1 - actualTPPercent / 100);
  }
}

/**
 * Calculate initial stop loss price
 * @param {number} tpPrice - Take profit price
 * @param {number} oc - OC percentage
 * @param {number} reduce - Initial reduce value
 * @param {'long'|'short'} side - Position side
 * @returns {number} Stop loss price
 */
export function calculateInitialStopLoss(tpPrice, oc, reduce, side) {
  // initial_sl = tp_price + (reduce * oc / 100)
  const slOffset = (reduce * oc) / 100;
  
  if (side === 'long') {
    return tpPrice - slOffset;
  } else {
    return tpPrice + slOffset;
  }
}

/**
 * Calculate dynamic stop loss based on elapsed time
 * @param {number} tpPrice - Take profit price
 * @param {number} oc - OC percentage
 * @param {number} reduce - Initial reduce value
 * @param {number} upReduce - Reduce acceleration per minute
 * @param {number} minutesElapsed - Minutes since position opened
 * @param {'long'|'short'} side - Position side
 * @returns {number} Updated stop loss price
 */
export function calculateDynamicStopLoss(tpPrice, oc, reduce, upReduce, minutesElapsed, side) {
  // current_sl = tp_price + ((reduce + minutes * up_reduce) * oc / 100)
  const currentReduce = reduce + (minutesElapsed * upReduce);
  const slOffset = (currentReduce * oc) / 100;
  
  if (side === 'long') {
    return tpPrice - slOffset;
  } else {
    return tpPrice + slOffset;
  }
}

/**
 * Calculate PnL percentage
 * @param {number} entryPrice - Entry price
 * @param {number} currentPrice - Current price
 * @param {'long'|'short'} side - Position side
 * @returns {number} PnL percentage
 */
export function calculatePnLPercent(entryPrice, currentPrice, side) {
  if (side === 'long') {
    return ((currentPrice - entryPrice) / entryPrice) * 100;
  } else {
    return ((entryPrice - currentPrice) / entryPrice) * 100;
  }
}

/**
 * Calculate PnL in USDT
 * @param {number} entryPrice - Entry price
 * @param {number} currentPrice - Current price
 * @param {number} amount - Position amount in USDT
 * @param {'long'|'short'} side - Position side
 * @returns {number} PnL in USDT
 */
export function calculatePnL(entryPrice, currentPrice, amount, side) {
  const pnlPercent = calculatePnLPercent(entryPrice, currentPrice, side);
  return (amount * pnlPercent) / 100;
}

/**
 * Calculate ignore threshold
 * @param {number} previousHigh - Previous candle high
 * @param {number} previousLow - Previous candle low
 * @param {number} ignore - Ignore percentage
 * @returns {number} Ignore threshold amount
 */
export function calculateIgnoreThreshold(previousHigh, previousLow, ignore) {
  const previousRange = Math.abs(previousHigh - previousLow);
  return (previousRange * ignore) / 100;
}

