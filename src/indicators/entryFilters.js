import { configService } from '../services/ConfigService.js';
import logger from '../utils/logger.js';

/**
 * ✅ ENHANCED: Entry filters for improved trade quality
 * 
 * 1. Pullback confirmation (5m EMA20) - avoid chasing spikes
 * 2. Volatility filter (ATR%) - avoid too quiet or too volatile markets
 * 3. Volume VMA Gate - only enter when volume > VMA * ratio
 * 4. Bollinger Bands Gate - filter entries by price position relative to bands
 */

/**
 * Filter: Volume VMA Gate
 * Chỉ vào lệnh khi Volume hiện tại lớn hơn mức trung bình * hệ số
 */
export function checkVolumeVmaGate(indicatorState, minRatio = 1.2) {
  if (!indicatorState.volume || !indicatorState.volume.ma || !indicatorState.volume.current) {
    return { ok: false, reason: 'volume_data_not_ready' };
  }
  const { current, ma, ratio } = indicatorState.volume;
  if (!Number.isFinite(current) || !Number.isFinite(ma) || ma <= 0) {
    return { ok: false, reason: 'volume_invalid' };
  }
  if (ratio < minRatio) {
    return { ok: false, reason: `volume_ratio_low_${ratio.toFixed(2)}<${minRatio}` };
  }
  return { ok: true, reason: 'volume_ok', ratio };
}

/**
 * Filter: Bollinger Trend Confirmation
 * Long: Giá phải nằm trên Mid Band, không quá Upper Band
 * Short: Giá phải nằm dưới Mid Band, không quá Lower Band
 */
export function checkBollingerGate(direction, indicatorState, currentPrice) {
  if (!indicatorState.bollinger) {
    return { ok: false, reason: 'bollinger_data_not_ready' };
  }
  const { middle, upper, lower } = indicatorState.bollinger;
  if (!Number.isFinite(middle) || !Number.isFinite(upper) || !Number.isFinite(lower)) {
    return { ok: false, reason: 'bollinger_invalid' };
  }
  if (!Number.isFinite(currentPrice)) {
    return { ok: false, reason: 'price_invalid' };
  }
  const dir = String(direction || '').toUpperCase();
  if (dir === 'LONG') {
    const isTrendUp = currentPrice > middle;
    const isOverbought = currentPrice > upper;
    if (!isTrendUp) {
      return { ok: false, reason: 'long_below_mid' };
    }
    if (isOverbought) {
      return { ok: false, reason: 'long_over_upper' };
    }
    return { ok: true, reason: 'long_ok' };
  } else if (dir === 'SHORT') {
    const isTrendDown = currentPrice < middle;
    const isOversold = currentPrice < lower;
    if (!isTrendDown) {
      return { ok: false, reason: 'short_above_mid' };
    }
    if (isOversold) {
      return { ok: false, reason: 'short_below_lower' };
    }
    return { ok: true, reason: 'short_ok' };
  }
  return { ok: false, reason: 'bollinger_invalid_direction' };
}

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

export function checkRvolGate(rvol, minRvol = 1.2) {
  const enabled = configService.getBoolean('RVOL_FILTER_ENABLED', true);

  if (!enabled) {
    return { ok: true, reason: 'rvol_disabled', rvol: null };
  }

  const v = Number(rvol);
  if (!Number.isFinite(v) || v <= 0) {
    return { ok: false, reason: 'rvol_data_not_ready', rvol: null };
  }

  const min = Number(configService.getNumber('RVOL_MIN', minRvol));
  if (v < min) {
    return { ok: false, reason: `rvol_too_low_${v.toFixed(2)}<${min.toFixed(2)}`, rvol: v };
  }

  return { ok: true, reason: 'rvol_ok', rvol: v };
}

export function checkDonchianBreakoutGate(direction, price, donchianHigh, donchianLow) {
  const enabled = configService.getBoolean('DONCHIAN_FILTER_ENABLED', true);

  if (!enabled) {
    return { ok: true, reason: 'donchian_disabled' };
  }

  const dir = String(direction || '').toLowerCase();
  const p = Number(price);
  const hi = Number(donchianHigh);
  const lo = Number(donchianLow);

  if ((dir !== 'bullish' && dir !== 'bearish') || !Number.isFinite(p) || p <= 0) {
    return { ok: false, reason: 'donchian_invalid_input' };
  }

  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= 0 || lo <= 0) {
    return { ok: false, reason: 'donchian_data_not_ready' };
  }

  if (dir === 'bullish') {
    if (p <= hi) {
      return { ok: false, reason: `donchian_not_break_high_${p.toFixed(4)}<=${hi.toFixed(4)}` };
    }
    return { ok: true, reason: 'donchian_breakout_long' };
  }

  if (p >= lo) {
    return { ok: false, reason: `donchian_not_break_low_${p.toFixed(4)}>=${lo.toFixed(4)}` };
  }
  return { ok: true, reason: 'donchian_breakout_short' };
}

