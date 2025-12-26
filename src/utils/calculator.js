/**
 * Trading calculation utilities
 */

/**
 * Calculate PnL (Profit and Loss)
 * @param {number} entryPrice - Entry price
 * @param {number} currentPrice - Current market price
 * @param {number} amount - Position amount in USDT (not quantity!)
 * @param {'long'|'short'} side - Position side
 * @returns {number} PnL value in USDT
 */
export function calculatePnL(entryPrice, currentPrice, amount, side) {
  const entry = Number(entryPrice);
  const current = Number(currentPrice);
  const amt = Number(amount);
  
  if (!Number.isFinite(entry) || !Number.isFinite(current) || !Number.isFinite(amt)) {
    return 0;
  }
  
  // Convert USDT amount to quantity
  const quantity = amt / entry;
  
  if (side === 'long') {
    return (current - entry) * quantity;
  } else {
    return (entry - current) * quantity;
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
  const o = Number(open);
  const c = Number(close);
  if (!Number.isFinite(o) || o === 0 || !Number.isFinite(c)) return 0;
  return ((c - o) / o) * 100;
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
 * Entry must be LOWER than current price (pullback entry)
 * Formula: entry = current - extendRatio * delta
 * where delta = abs(current - open), extendRatio = extend / 100
 * 
 * @param {number} current - Current market price (price at signal detection)
 * @param {number} open - Candle open price (base price of OC)
 * @param {number} extend - Extend percentage (e.g., 60 = 60%)
 * @returns {number} Entry price (always < current)
 */
export function calculateLongEntryPrice(current, open, extend) {
  const curr = Number(current);
  const o = Number(open);
  const ext = Number(extend);
  
  if (!Number.isFinite(curr) || !Number.isFinite(o) || !Number.isFinite(ext)) {
    return NaN;
  }
  
  // Normalize extend: 60 -> 0.6
  const extendRatio = ext / 100;
  
  // Calculate delta: absolute distance between current and open
  const delta = Math.abs(curr - o);
  
  // LONG: entry = current - extendRatio * delta
  // This ensures entry < current (pullback entry)
  const entry = curr - extendRatio * delta;
  
  return entry;
}

/**
 * Calculate entry price for SHORT position
 * Entry must be HIGHER than current price (pullback entry for counter-trend)
 * Formula: entry = current + extendRatio * delta
 * where delta = abs(current - open), extendRatio = extend / 100
 * 
 * @param {number} current - Current market price (price at signal detection)
 * @param {number} open - Candle open price (base price of OC)
 * @param {number} extend - Extend percentage (e.g., 60 = 60%)
 * @returns {number} Entry price (always > current)
 */
export function calculateShortEntryPrice(current, open, extend) {
  const curr = Number(current);
  const o = Number(open);
  const ext = Number(extend);
  
  if (!Number.isFinite(curr) || !Number.isFinite(o) || !Number.isFinite(ext)) {
    return NaN;
  }
  
  // Normalize extend: 60 -> 0.6
  const extendRatio = ext / 100;
  
  // Calculate delta: absolute distance between current and open
  const delta = Math.abs(curr - o);
  
  // SHORT: entry = current + extendRatio * delta
  // This ensures entry > current (pullback entry for counter-trend)
  const entry = curr + extendRatio * delta;
  
  return entry;
}

/**
 * Calculate take profit price
 * @param {number} entryPrice - Entry price
 * @param {number} takeProfit - Take profit value (e.g., 50 = 5%)
 * @param {'long'|'short'} side - Position side
 * @returns {number} Take profit price
 */
export function calculateTakeProfit(entryPrice, takeProfit, side) {
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
 * 
 * IMPORTANT: Trailing TP is TIME-BASED ONLY, not price-based.
 * This ensures predictable behavior and avoids premature position closure.
 * 
 * Logic:
 * - TP starts at initialTP and trails towards entryPrice
 * - Trailing speed: reducePercent% of the total range (initialTP → entry) per minute
 * - Example: If range = 100, reducePercent = 40, then step = 40 per minute
 * 
 * @param {number} prevTP - Previous take profit price
 * @param {number} entryPrice - Entry price (target to trail towards)
 * @param {number} initialTP - Initial take profit price (starting point)
 * @param {number} reducePercent - Trailing percentage per minute (direct percentage, e.g., 40 = 40% of range per minute)
 * @param {'long'|'short'} side - Position side
 * @param {number} minutesElapsed - Minutes elapsed since last update (default: 1)
 * @returns {number} Next take profit price
 */
export function calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, reducePercent, side, minutesElapsed = 1) {
  const prev = Number(prevTP);
  const entry = Number(entryPrice);
  const initial = Number(initialTP);
  const reduce = Number(reducePercent);
  const minutes = Number(minutesElapsed) || 1;
  
  // Input validation
  if (!Number.isFinite(prev) || !Number.isFinite(entry) || !Number.isFinite(initial) || !Number.isFinite(reduce) || reduce <= 0) {
    return prev; // Return previous TP if inputs are invalid
  }
  
  // Total distance from initial TP → entry
  const totalRange = Math.abs(initial - entry);
  
  // Step per minute: reducePercent% of total range
  // Example: range = 100, reduce = 40 → stepPerMinute = 40
  const stepPerMinute = totalRange * (reduce / 100);
  
  // Total step for elapsed time
  const step = stepPerMinute * minutes;
  
  if (side === 'long') {
    // LONG: TP moves DOWN (decreases) from initial TP towards entry
    // newTP = prevTP - step (but don't go below entry)
    const newTP = prev - step;
    return Math.max(newTP, entry); // Don't go below entry
  } else {
    // SHORT: TP moves UP (increases) from initial TP towards entry
    // newTP = prevTP + step
    // CRITICAL FIX: Allow TP to cross entry for early loss-cutting when price moves against position
    // This protects account from large losses when price moves strongly against SHORT position
    const newTP = prev + step;
    // Allow TP to exceed entry (no Math.min limit) to enable early exit when price rises above entry
    // This is intentional: if price moves against SHORT (above entry), trailing TP will trigger earlier to minimize loss
    return newTP;
  }
}

/**
 * Calculate next trailing stop loss price based on previous SL and reduce/up_reduce
 * @deprecated This function is DEPRECATED - SL should remain static after initial setup
 * @throws {Error} Always throws error to prevent accidental usage
 */
export function calculateNextTrailingStop(prevSL, entryPrice, reducePercent, side, tpPrice = null) {
  throw new Error('calculateNextTrailingStop is deprecated. Stop Loss should remain static after initial setup. Do not use this function.');
}

/**
 * Calculate dynamic stop loss based on elapsed time (converging from TP)
 * @deprecated This function is DEPRECATED - SL should remain static after initial setup
 * @throws {Error} Always throws error to prevent accidental usage
 */
export function calculateDynamicStopLoss(tpPrice, oc, reduce, upReduce, minutesElapsed, side, entryPrice = null) {
  throw new Error('calculateDynamicStopLoss is deprecated. Stop Loss should remain static after initial setup. Do not use this function.');
}
