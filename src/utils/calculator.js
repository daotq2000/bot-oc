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
 * Calculate initial stop loss price
 * @param {number} tpPrice - Take profit price
 * @param {number} oc - OC percentage
 * @param {number} reduce - Initial reduce value
 * @param {'long'|'short'} side - Position side
 * @returns {number} Stop loss price
 */
export function calculateInitialStopLoss(tpPrice, oc, reduce, side) {
  const tp = Number(tpPrice);
  const r = Number(reduce);
  const ocn = Number(oc);
  if (!Number.isFinite(tp) || !Number.isFinite(r) || !Number.isFinite(ocn)) return NaN;
  const slOffset = (r * ocn) / 100;
  if (side === 'long') {
    return tp - slOffset;
  } else {
    return tp + slOffset;
  }
}

/**
 * Calculate dynamic stop loss based on elapsed time (converging from TP)
 * @param {number} tpPrice - Take profit price
 * @param {number} oc - OC percentage
 * @param {number} reduce - Initial reduce value
 * @param {number} upReduce - Reduce acceleration per minute
 * @param {number} minutesElapsed - Minutes since position opened
 * @param {'long'|'short'} side - Position side
 * @returns {number} Updated stop loss price
 */
export function calculateDynamicStopLoss(tpPrice, oc, reduce, upReduce, minutesElapsed, side) {
  const tp = Number(tpPrice);
  const baseReduce = Number(reduce);
  const up = Number(upReduce);
  const minutes = Number(minutesElapsed);
  const ocN = Number(oc);

  if (!Number.isFinite(tp) || !Number.isFinite(baseReduce) || !Number.isFinite(up) || !Number.isFinite(minutes) || !Number.isFinite(ocN)) {
    return tp; // Fallback: giữ nguyên TP nếu input không hợp lệ
  }

  // Cách 2: Đuổi theo TP (trailing về phía TP theo thời gian)
  // - Thay vì tăng khoảng cách như công thức cũ (reduce + minutes * up_reduce),
  //   ta cho khoảng cách GIẢM dần theo thời gian:
  //   effectiveReduce = max(reduce - minutes * up_reduce, 0)
  //
  // Điều này khiến stop loss "kéo" dần về TP (thu hẹp khoảng cách),
  // trong khi PositionService vẫn giữ ràng buộc monotonic:
  // - LONG  : chỉ cho SL tăng lên (gần giá hơn)
  // - SHORT : chỉ cho SL giảm xuống (gần giá hơn)
  const effectiveReduce = Math.max(baseReduce - minutes * up, 0);

  // Giữ nguyên đơn vị cũ: slOffset = (effectiveReduce * oc) / 100
  const slOffset = (effectiveReduce * ocN) / 100;

  if (side === 'long') {
    return tp - slOffset;
  } else {
    return tp + slOffset;
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
  const e = Number(entryPrice);
  const c = Number(currentPrice);
  if (side === 'long') {
    return ((c - e) / e) * 100;
  } else {
    return ((e - c) / e) * 100;
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
  return (Number(amount) * pnlPercent) / 100;
}

/**
 * Calculate ignore threshold
 * @param {number} previousHigh - Previous candle high
 * @param {number} previousLow - Previous candle low
 * @param {number} ignore - Ignore percentage
 * @returns {number} Ignore threshold amount
 */
export function calculateIgnoreThreshold(previousHigh, previousLow, ignore) {
  const previousRange = Math.abs(Number(previousHigh) - Number(previousLow));
  return (previousRange * Number(ignore)) / 100;
}

