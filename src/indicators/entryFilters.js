import { configService } from '../services/ConfigService.js';
import logger from '../utils/logger.js';

// Import new filters
import { checkMarketRegimeGate, detectMarketRegime, MARKET_REGIME } from './marketRegimeFilter.js';
import { checkFundingRateGate, fetchFundingRate, getFundingRateSentiment } from './fundingRateFilter.js';

/**
 * ✅ ENHANCED: Entry filters for improved trade quality
 * 
 * 1. Pullback confirmation (5m EMA20) - avoid chasing spikes
 * 2. Volatility filter (ATR%) - avoid too quiet or too volatile markets
 * 3. Volume VMA Gate - only enter when volume > VMA * ratio
 * 4. Bollinger Bands Gate - filter entries by price position relative to bands
 * 5. Market Regime Detection - avoid trading trend-following in ranging markets
 * 6. Funding Rate Filter - avoid extreme sentiment positions in futures
 * 7. Candle Body Confirmation - avoid Doji/Pinbar entries with long wicks (NEW!)
 */

// Re-export new filters for convenience
export { 
  checkMarketRegimeGate, 
  detectMarketRegime, 
  MARKET_REGIME,
  checkFundingRateGate, 
  fetchFundingRate, 
  getFundingRateSentiment 
};

/**
 * ✅ NEW: Candle Body Confirmation Filter
 * 
 * Ensures entry candle has a solid body (not a Doji/Pinbar with long wicks).
 * This helps avoid entries on indecision candles that often lead to reversals.
 * 
 * Rule: Body size must be >= minBodyRatio of total candle range
 * 
 * @param {Object} candle - { open, high, low, close }
 * @param {number} minBodyRatio - Minimum body/range ratio (default: 0.5 = 50%)
 * @returns {Object} { ok: boolean, reason: string, bodyRatio: number }
 */
export function checkCandleBodyConfirmation(candle, minBodyRatio = 0.5) {
  const enabled = configService.getBoolean('CANDLE_BODY_FILTER_ENABLED', true);
  
  if (!enabled) {
    return { ok: true, reason: 'candle_body_filter_disabled', bodyRatio: null };
  }

  if (!candle || !Number.isFinite(candle.open) || !Number.isFinite(candle.close) ||
      !Number.isFinite(candle.high) || !Number.isFinite(candle.low)) {
    return { ok: false, reason: 'candle_data_invalid', bodyRatio: null };
  }

  const open = Number(candle.open);
  const close = Number(candle.close);
  const high = Number(candle.high);
  const low = Number(candle.low);

  const totalRange = high - low;
  const bodyRange = Math.abs(close - open);

  // Avoid division by zero
  if (totalRange <= 0) {
    return { ok: false, reason: 'candle_no_range', bodyRatio: 0 };
  }

  const bodyRatio = bodyRange / totalRange;
  const minRatio = Number(configService.getNumber('CANDLE_BODY_MIN_RATIO', minBodyRatio));

  if (bodyRatio < minRatio) {
    return { 
      ok: false, 
      reason: `candle_body_too_small_${(bodyRatio * 100).toFixed(1)}%<${(minRatio * 100).toFixed(1)}%`,
      bodyRatio,
      details: {
        open, close, high, low,
        bodyRange: bodyRange.toFixed(6),
        totalRange: totalRange.toFixed(6),
        minRatio,
        hint: 'Candle has long wicks (Doji/Pinbar) - potential indecision or reversal signal'
      }
    };
  }

  return { 
    ok: true, 
    reason: 'candle_body_ok', 
    bodyRatio,
    details: { bodyRange, totalRange, minRatio }
  };
}

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
 * ✅ ENHANCED: Dynamic ATR threshold based on market regime
 * - Normal/Ranging: Use standard VOL_ATR_MAX_PCT (2.0%)
 * - Strong Trend: Use higher VOL_ATR_MAX_STRONG_PCT (2.5%) to not miss strong moves
 * 
 * Rule:
 * - ATR% = (ATR / price) * 100
 * - Only trade if: minPct <= ATR% <= maxPct
 * 
 * @param {number} atr - ATR value (from 15m timeframe)
 * @param {number} price - Current price
 * @param {Object} options - { isStrongTrend: boolean } for dynamic threshold
 * @returns {Object} { ok: boolean, reason: string, atrPercent: number }
 */
export function checkVolatilityFilter(atr, price, options = {}) {
  const enabled = configService.getBoolean('VOLATILITY_FILTER_ENABLED', true);
  
  if (!enabled) {
    return { ok: true, reason: 'volatility_disabled', atrPercent: null };
  }

  if (!Number.isFinite(atr) || !Number.isFinite(price) || price <= 0) {
    return { ok: false, reason: 'volatility_data_not_ready', atrPercent: null };
  }

  const atrPercent = (atr / price) * 100;
  const minPct = Number(configService.getNumber('VOL_ATR_MIN_PCT', 0.15));
  
  // ✅ Dynamic ATR max threshold based on trend strength
  const isStrongTrend = options?.isStrongTrend === true;
  const maxPctNormal = Number(configService.getNumber('VOL_ATR_MAX_PCT', 2.0));
  const maxPctStrong = Number(configService.getNumber('VOL_ATR_MAX_STRONG_PCT', 2.5));
  const maxPct = isStrongTrend ? maxPctStrong : maxPctNormal;

  if (atrPercent < minPct) {
    return { 
      ok: false, 
      reason: `volatility_too_low_${atrPercent.toFixed(2)}%<${minPct.toFixed(2)}%`, 
      atrPercent,
      details: { minPct, maxPct, isStrongTrend }
    };
  }
  if (atrPercent > maxPct) {
    return { 
      ok: false, 
      reason: `volatility_too_high_${atrPercent.toFixed(2)}%>${maxPct.toFixed(2)}%${isStrongTrend ? '_strong' : ''}`, 
      atrPercent,
      details: { minPct, maxPct, maxPctNormal, maxPctStrong, isStrongTrend }
    };
  }

  return { 
    ok: true, 
    reason: isStrongTrend ? 'volatility_ok_strong_trend' : 'volatility_ok', 
    atrPercent,
    details: { minPct, maxPct, isStrongTrend }
  };
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

/**
 * ✅ NEW: Run all entry filters and return aggregated result
 * 
 * This function runs all configured entry filters and returns:
 * - ok: true only if ALL enabled filters pass
 * - reasons: array of all filter results
 * - blockedBy: first filter that blocked the entry (if any)
 * 
 * @param {Object} params - Filter parameters
 * @param {string} params.direction - 'bullish' or 'bearish' (or 'LONG'/'SHORT')
 * @param {number} params.currentPrice - Current market price
 * @param {Object} params.indicatorState - Indicator state (1m)
 * @param {Object} params.indicatorState15m - Indicator state (15m) - optional
 * @param {Object} params.candle5m - Latest 5m candle for pullback confirmation
 * @param {number} params.ema20_5m - EMA20 on 5m timeframe
 * @param {ExchangeService} params.exchangeService - Exchange service for funding rate
 * @param {string} params.symbol - Trading symbol
 * @param {string} params.strategyType - Strategy type (default: 'FOLLOWING_TREND')
 * @param {boolean} params.isStrongTrend - Whether current market is in strong trend (ADX >= 35)
 * @param {Object} params.entryCandle - Entry candle for body confirmation filter
 * @returns {Promise<Object>} { ok: boolean, blockedBy: string|null, results: Object }
 */
export async function runAllEntryFilters(params) {
  const {
    direction,
    currentPrice,
    indicatorState,
    indicatorState15m = null,
    candle5m = null,
    ema20_5m = null,
    exchangeService = null,
    symbol = null,
    strategyType = 'FOLLOWING_TREND',
    isStrongTrend = false,
    entryCandle = null
  } = params;

  const results = {};
  let blockedBy = null;
  
  // Normalize direction
  const dir = String(direction || '').toLowerCase();
  const normalizedDir = (dir === 'long' || dir === 'bullish') ? 'bullish' : 
                       (dir === 'short' || dir === 'bearish') ? 'bearish' : dir;

  // 1. Volume VMA Gate
  const volumeGateEnabled = configService.getBoolean('VOLUME_VMA_GATE_ENABLED', true);
  if (volumeGateEnabled && indicatorState) {
    const minRatio = Number(configService.getNumber('VOLUME_VMA_MIN_RATIO', 1.2));
    results.volumeVma = checkVolumeVmaGate(indicatorState, minRatio);
    if (!results.volumeVma.ok && !blockedBy) {
      blockedBy = 'volumeVma';
    }
  }

  // 2. Bollinger Gate
  const bollingerGateEnabled = configService.getBoolean('BOLLINGER_GATE_ENABLED', true);
  if (bollingerGateEnabled && indicatorState && Number.isFinite(currentPrice)) {
    results.bollinger = checkBollingerGate(normalizedDir, indicatorState, currentPrice);
    if (!results.bollinger.ok && !blockedBy) {
      blockedBy = 'bollinger';
    }
  }

  // 3. Pullback Confirmation
  const pullbackEnabled = configService.getBoolean('PULLBACK_CONFIRMATION_ENABLED', true);
  if (pullbackEnabled && candle5m && ema20_5m) {
    results.pullback = checkPullbackConfirmation(normalizedDir, currentPrice, candle5m, ema20_5m);
    if (!results.pullback.ok && !blockedBy) {
      blockedBy = 'pullback';
    }
  }

  // 4. Volatility Filter (ATR%) - ✅ ENHANCED with dynamic threshold
  const volatilityEnabled = configService.getBoolean('VOLATILITY_FILTER_ENABLED', true);
  if (volatilityEnabled && indicatorState) {
    const snap = typeof indicatorState?.snapshot === 'function' 
      ? indicatorState.snapshot() 
      : (indicatorState || {});
    const atr = Number(snap.atr14);
    if (Number.isFinite(atr) && Number.isFinite(currentPrice)) {
      // Pass isStrongTrend to allow higher volatility in strong trends
      results.volatility = checkVolatilityFilter(atr, currentPrice, { isStrongTrend });
      if (!results.volatility.ok && !blockedBy) {
        blockedBy = 'volatility';
      }
    }
  }

  // 5. RVOL Gate
  const rvolEnabled = configService.getBoolean('RVOL_FILTER_ENABLED', true);
  if (rvolEnabled && indicatorState) {
    const snap = typeof indicatorState?.snapshot === 'function' 
      ? indicatorState.snapshot() 
      : (indicatorState || {});
    const rvol = Number(snap.rvol);
    if (Number.isFinite(rvol)) {
      const minRvol = Number(configService.getNumber('RVOL_MIN', 1.2));
      results.rvol = checkRvolGate(rvol, minRvol);
      if (!results.rvol.ok && !blockedBy) {
        blockedBy = 'rvol';
      }
    }
  }

  // 6. Market Regime Detection
  const regimeEnabled = configService.getBoolean('MARKET_REGIME_FILTER_ENABLED', true);
  if (regimeEnabled && indicatorState15m) {
    results.marketRegime = checkMarketRegimeGate(indicatorState15m, currentPrice, strategyType);
    if (!results.marketRegime.ok && !blockedBy) {
      blockedBy = 'marketRegime';
    }
  }

  // 7. Funding Rate Filter for Futures
  const fundingEnabled = configService.getBoolean('FUNDING_RATE_FILTER_ENABLED', true);
  if (fundingEnabled && exchangeService && symbol) {
    try {
      const fundingDirection = normalizedDir === 'bullish' ? 'LONG' : 'SHORT';
      results.fundingRate = await checkFundingRateGate(fundingDirection, exchangeService, symbol);
      if (!results.fundingRate.ok && !blockedBy) {
        blockedBy = 'fundingRate';
      }
    } catch (error) {
      logger.debug(`[EntryFilters] Funding rate check failed: ${error?.message || error}`);
      results.fundingRate = { ok: true, reason: 'funding_check_error_fail_open' };
    }
  }

  // 8. ✅ NEW: Candle Body Confirmation Filter
  const candleBodyEnabled = configService.getBoolean('CANDLE_BODY_FILTER_ENABLED', true);
  if (candleBodyEnabled && entryCandle) {
    const minBodyRatio = Number(configService.getNumber('CANDLE_BODY_MIN_RATIO', 0.5));
    results.candleBody = checkCandleBodyConfirmation(entryCandle, minBodyRatio);
    if (!results.candleBody.ok && !blockedBy) {
      blockedBy = 'candleBody';
    }
  }

  // Aggregate result
  const allPassed = Object.values(results).every(r => r.ok !== false);

  return {
    ok: allPassed,
    blockedBy: allPassed ? null : blockedBy,
    results,
    isStrongTrend,
    summary: Object.entries(results).map(([name, r]) => `${name}:${r.ok ? 'PASS' : 'FAIL'}`).join(', ')
  };
}


