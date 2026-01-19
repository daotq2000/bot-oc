import { configService } from '../services/ConfigService.js';
import logger from '../utils/logger.js';

/**
 * ✅ ENHANCED: Entry filters for improved trade quality
 * 
 * 1. Pullback confirmation (5m EMA20) - avoid chasing spikes
 * 2. Volatility filter (ATR%) - avoid too quiet or too volatile markets
 */

/**
 * Check if price has pulled back to EMA20(5m) and confirmed reversal
 * 
 * Rule (LONG):
 * - Price must have touched or gone below EMA20(5m) at least once
 * - Current candle must close above EMA20(5m) (confirmation)
 * 
 * Rule (SHORT):
 * - Price must have touched or gone above EMA20(5m) at least once
 * - Current candle must close below EMA20(5m) (confirmation)
 * 
 * @param {string} direction - 'bullish' or 'bearish'
 * @param {number} currentPrice - Current price
 * @param {Object} candle5m - Latest 5m candle { high, low, close, isClosed }
 * @param {number} ema20_5m - EMA20 value on 5m timeframe
 * @returns {Object} { ok: boolean, reason: string }
 */
export function checkPullbackConfirmation(direction, currentPrice, candle5m, ema20_5m) {
  const dir = String(direction || '').toLowerCase();
  const enabled = configService.getBoolean('PULLBACK_CONFIRMATION_ENABLED', true);
  
  if (!enabled) {
    return { ok: true, reason: 'pullback_disabled' };
  }

  if (!candle5m || !Number.isFinite(ema20_5m) || ema20_5m <= 0) {
    return { ok: false, reason: 'pullback_data_not_ready' };
  }

  const high = Number(candle5m.high || currentPrice);
  const low = Number(candle5m.low || currentPrice);
  const close = Number(candle5m.close || currentPrice);
  const ema20 = Number(ema20_5m);

  if (dir === 'bullish') {
    // LONG: Check if price touched EMA20 and closed above it
    const touchedEma = low <= ema20;
    const closedAbove = close > ema20;
    
    if (!touchedEma) {
      return { ok: false, reason: 'pullback_not_touched_ema20' };
    }
    if (!closedAbove) {
      return { ok: false, reason: 'pullback_not_confirmed_above' };
    }
    return { ok: true, reason: 'pullback_confirmed_long' };
  } else if (dir === 'bearish') {
    // SHORT: Check if price touched EMA20 and closed below it
    const touchedEma = high >= ema20;
    const closedBelow = close < ema20;
    
    if (!touchedEma) {
      return { ok: false, reason: 'pullback_not_touched_ema20' };
    }
    if (!closedBelow) {
      return { ok: false, reason: 'pullback_not_confirmed_below' };
    }
    return { ok: true, reason: 'pullback_confirmed_short' };
  }

  return { ok: false, reason: 'pullback_invalid_direction' };
}

/**
 * Check volatility filter (ATR%) to avoid trading in too quiet or too volatile markets
 * 
 * Rule:
 * - ATR% = (ATR / price) * 100
 * - Only trade if: minPct <= ATR% <= maxPct
 * 
 * @param {number} atr - ATR value (from 15m timeframe)
 * @param {number} price - Current price
 * @returns {Object} { ok: boolean, reason: string, atrPercent: number }
 */
export function checkVolatilityFilter(atr, price) {
  const enabled = configService.getBoolean('VOLATILITY_FILTER_ENABLED', true);
  
  if (!enabled) {
    return { ok: true, reason: 'volatility_disabled', atrPercent: null };
  }

  if (!Number.isFinite(atr) || !Number.isFinite(price) || price <= 0) {
    return { ok: false, reason: 'volatility_data_not_ready', atrPercent: null };
  }

  const atrPercent = (atr / price) * 100;
  const minPct = Number(configService.getNumber('VOL_ATR_MIN_PCT', 0.15));
  const maxPct = Number(configService.getNumber('VOL_ATR_MAX_PCT', 2.0));

  if (atrPercent < minPct) {
    return { ok: false, reason: `volatility_too_low_${atrPercent.toFixed(2)}%`, atrPercent };
  }
  if (atrPercent > maxPct) {
    return { ok: false, reason: `volatility_too_high_${atrPercent.toFixed(2)}%`, atrPercent };
  }

  return { ok: true, reason: 'volatility_ok', atrPercent };
}

