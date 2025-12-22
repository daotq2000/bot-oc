/**
 * Trading calculation utilities
 */

/**
 * Calculate PnL (Profit and Loss)
 * @param {number} entryPrice - Entry price
 * @param {number} currentPrice - Current market price
 * @param {number} amount - Position amount
 * @param {'long'|'short'} side - Position side
 * @returns {number} PnL value
 */
export function calculatePnL(entryPrice, currentPrice, amount, side) {
  const entry = Number(entryPrice);
  const current = Number(currentPrice);
  const amt = Number(amount);
  
  if (!Number.isFinite(entry) || !Number.isFinite(current) || !Number.isFinite(amt)) {
    return 0;
  }
  
  if (side === 'long') {
    return (current - entry) * amt;
  } else {
    return (entry - current) * amt;
  }
}

/**
 * Calculate PnL percentage
 * @param {number} entryPrice - Entry price
 * @param {number} currentPrice - Current market price
 * @param {'long'|'short'} side - Position side
 * @returns {number} PnL percentage
 */
export function calculatePnLPercent(entryPrice, currentPrice, side) {
  const entry = Number(entryPrice);
  const current = Number(currentPrice);
  
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(current)) {
    return 0;
  }
  
  if (side === 'long') {
    return ((current - entry) / entry) * 100;
  } else {
    return ((entry - current) / entry) * 100;
  }
}

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
  const o = Number(open);
  const ocN = Number(oc);
  const ext = Number(extend);
  if (!Number.isFinite(o) || !Number.isFinite(ocN) || !Number.isFinite(ext)) return NaN;
  const entryOffset = (o * ocN * ext) / 10000;
  return o - entryOffset;
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
  const o = Number(open);
  const ocN = Number(oc);
  const ext = Number(extend);
  if (!Number.isFinite(o) || !Number.isFinite(ocN) || !Number.isFinite(ext)) return NaN;
  const entryOffset = (o * ocN * ext) / 10000;
  return o + entryOffset;
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
  const e = Number(entryPrice);
  const tp = Number(takeProfit);
  if (!Number.isFinite(e) || !Number.isFinite(tp)) return NaN;
  const actualTPPercent = tp / 10; // e.g., 35.5 -> 3.55%
  if (side === 'long') {
    return e * (1 + actualTPPercent / 100);
  } else {
    return e * (1 - actualTPPercent / 100);
  }
}

/**
 * Calculate initial stop loss price based on entry price and stoploss percentage (similar to take_profit)
 * @param {number} entryPrice - Entry price
 * @param {number} stoploss - Stop loss percentage value (e.g., 50 = 5% if divided by 10, same format as take_profit)
 * @param {'long'|'short'} side - Position side
 * @returns {number|null} Stop loss price, or null if stoploss <= 0
 */
export function calculateInitialStopLoss(entryPrice, stoploss, side) {
  const entry = Number(entryPrice);
  const sl = Number(stoploss);
  
  // If stoploss is not a valid number or <= 0, return null (no stoploss)
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(sl) || sl <= 0) {
    return null;
  }
  
  // Calculate stoploss percentage (same format as take_profit: divide by 10)
  // e.g., stoploss = 50 → actualSLPercent = 5%
  const actualSLPercent = sl / 10;
  
  if (side === 'long') {
    // LONG: SL < Entry, so SL = Entry * (1 - stoploss%)
    return entry * (1 - actualSLPercent / 100);
  } else {
    // SHORT: SL > Entry, so SL = Entry * (1 + stoploss%)
    return entry * (1 + actualSLPercent / 100);
  }
}

/**
 * Calculate next trailing take profit price - moves from initial TP towards entry
 * This is the NEW logic: TP trails from initial TP towards entry, NOT SL movement
 * @param {number} prevTP - Previous take profit price
 * @param {number} entryPrice - Entry price (target to trail towards)
 * @param {number} initialTP - Initial take profit price (starting point)
 * @param {number} reducePercent - Reduce percentage per minute (direct percentage, e.g., 40 = 40%)
 * @param {'long'|'short'} side - Position side
 * @returns {number} Next take profit price
 */
export function calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, reducePercent, side) {
  const prev = Number(prevTP);
  const entry = Number(entryPrice);
  const initial = Number(initialTP);
  const reduce = Number(reducePercent);
  
  if (!Number.isFinite(prev) || !Number.isFinite(entry) || !Number.isFinite(initial) || !Number.isFinite(reduce) || reduce <= 0) {
    return prev; // Return previous TP if inputs are invalid
  }
  
  // Calculate step value: percentage of the range from initial TP to Entry
  // reduce/up_reduce are direct percentages (e.g., 40 = 40%, not divided by 10)
  // This is different from take_profit which uses divide-by-10 format
  const range = Math.abs(initial - entry);
  const stepValue = range * (reduce / 100);
  
  if (side === 'long') {
    // LONG: TP moves DOWN (decreases) from initial TP towards entry
    // newTP = prevTP - stepValue (but don't go below entry)
    const newTP = prev - stepValue;
    return Math.max(newTP, entry); // Don't go below entry
  } else { // SHORT
    // SHORT: TP moves UP (increases) from initial TP towards entry
    // newTP = prevTP + stepValue (but don't go above entry)
    const newTP = prev + stepValue;
    return Math.min(newTP, entry); // Don't go above entry
  }
}

/**
 * Calculate next trailing stop loss price based on previous SL and reduce/up_reduce
 * @deprecated This function is no longer used for trailing - SL should remain static after initial setup
 * Only used for initial SL calculation
 */
export function calculateNextTrailingStop(prevSL, entryPrice, reducePercent, side, tpPrice = null) {
  // This function is deprecated - SL should not be moved after initial setup
  // Return previous SL to keep it static
  return Number(prevSL);
}

/**
 * Calculate dynamic stop loss based on elapsed time (converging from TP)
 * @deprecated This function is kept for backward compatibility but should not be used for trailing stops
 */
export function calculateDynamicStopLoss(tpPrice, oc, reduce, upReduce, minutesElapsed, side, entryPrice = null) {
  // Deprecated - not used anymore
  return null;
}
