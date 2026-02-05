/**
 * Market Regime Filter
 * 
 * Detects whether the market is in a TRENDING or RANGING state
 * Uses ADX, ATR ratio, and EMA slope to determine market regime
 * 
 * TRENDING market characteristics:
 * - ADX > 25 (strong trend)
 * - Clear EMA separation
 * - Price making higher highs/higher lows (uptrend) or lower highs/lower lows (downtrend)
 * 
 * RANGING market characteristics:
 * - ADX < 20 (weak trend)
 * - EMAs are flat or crossing frequently
 * - Price oscillating within a range
 */

import { configService } from '../services/ConfigService.js';
import logger from '../utils/logger.js';

// Market Regime Types
export const MARKET_REGIME = {
  STRONG_TREND: 'STRONG_TREND',     // ADX >= 30, good for trend-following
  WEAK_TREND: 'WEAK_TREND',         // ADX 20-30, cautious trend-following
  RANGING: 'RANGING',               // ADX < 20, avoid trend-following, good for mean-reversion
  VOLATILE: 'VOLATILE',             // High ATR%, unpredictable, reduce position size
  UNKNOWN: 'UNKNOWN'                // Not enough data
};

// Default thresholds (configurable)
const REGIME_THRESHOLDS = {
  ADX_STRONG_TREND: 30,      // ADX >= this = strong trending market
  ADX_WEAK_TREND: 20,        // ADX >= this but < STRONG = weak trend
  ADX_RANGING: 20,           // ADX < this = ranging market
  
  ATR_VOLATILE_HIGH: 3.0,    // ATR% > this = highly volatile
  ATR_QUIET_LOW: 0.3,        // ATR% < this = too quiet (avoid)
  
  EMA_SLOPE_FLAT: 0.0005,    // EMA slope < this = flat (ranging)
  EMA_SEPARATION_MIN: 0.002  // (EMA20-EMA50)/EMA50 < this = ranging
};

/**
 * Detect market regime based on ADX, ATR, and EMA values
 * 
 * @param {Object} indicatorState - Indicator state with adx14, atr14, ema20, ema50, ema20Slope
 * @param {number} currentPrice - Current market price
 * @returns {Object} { regime: string, confidence: number (0-1), details: Object, tradeable: boolean }
 */
export function detectMarketRegime(indicatorState, currentPrice) {
  // Check if filter is enabled
  const enabled = configService.getBoolean('MARKET_REGIME_FILTER_ENABLED', true);
  if (!enabled) {
    return { 
      regime: MARKET_REGIME.UNKNOWN, 
      confidence: 0, 
      tradeable: true, 
      reason: 'filter_disabled' 
    };
  }
  
  // Extract indicator values
  const snap = typeof indicatorState?.snapshot === 'function'
    ? indicatorState.snapshot()
    : (indicatorState || {});
  
  const adx14 = Number(snap.adx14);
  const atr14 = Number(snap.atr14);
  const ema20 = Number(snap.ema20);
  const ema50 = Number(snap.ema50);
  const ema20Slope = Number(snap.ema20Slope ?? snap.emaSlope);
  const price = Number(currentPrice);
  
  // Validate required data
  if (!Number.isFinite(adx14)) {
    return { 
      regime: MARKET_REGIME.UNKNOWN, 
      confidence: 0, 
      tradeable: true, // Allow trade when data not ready (fail-open)
      reason: 'adx_not_ready' 
    };
  }
  
  // Load configurable thresholds
  const adxStrongTrend = Number(configService.getNumber('REGIME_ADX_STRONG_TREND', REGIME_THRESHOLDS.ADX_STRONG_TREND));
  const adxWeakTrend = Number(configService.getNumber('REGIME_ADX_WEAK_TREND', REGIME_THRESHOLDS.ADX_WEAK_TREND));
  const atrVolatileHigh = Number(configService.getNumber('REGIME_ATR_VOLATILE_HIGH', REGIME_THRESHOLDS.ATR_VOLATILE_HIGH));
  const atrQuietLow = Number(configService.getNumber('REGIME_ATR_QUIET_LOW', REGIME_THRESHOLDS.ATR_QUIET_LOW));
  const emaSlopeFlat = Number(configService.getNumber('REGIME_EMA_SLOPE_FLAT', REGIME_THRESHOLDS.EMA_SLOPE_FLAT));
  const emaSeparationMin = Number(configService.getNumber('REGIME_EMA_SEPARATION_MIN', REGIME_THRESHOLDS.EMA_SEPARATION_MIN));
  
  // Calculate additional metrics
  let atrPercent = null;
  if (Number.isFinite(atr14) && Number.isFinite(price) && price > 0) {
    atrPercent = (atr14 / price) * 100;
  }
  
  let emaSeparation = null;
  if (Number.isFinite(ema20) && Number.isFinite(ema50) && ema50 > 0) {
    emaSeparation = Math.abs(ema20 - ema50) / ema50;
  }
  
  const details = {
    adx14,
    atrPercent,
    ema20,
    ema50,
    ema20Slope,
    emaSeparation,
    thresholds: { adxStrongTrend, adxWeakTrend, atrVolatileHigh, atrQuietLow }
  };
  
  // Determine regime based on ADX
  let regime = MARKET_REGIME.UNKNOWN;
  let confidence = 0;
  let tradeable = true;
  let reason = '';
  
  // Step 1: Check volatility first (safety)
  if (atrPercent !== null) {
    if (atrPercent > atrVolatileHigh) {
      regime = MARKET_REGIME.VOLATILE;
      confidence = Math.min(1, atrPercent / (atrVolatileHigh * 1.5));
      tradeable = false;
      reason = `atr_too_high_${atrPercent.toFixed(2)}%>${atrVolatileHigh}%`;
      
      return { regime, confidence, tradeable, reason, details };
    }
    
    if (atrPercent < atrQuietLow) {
      regime = MARKET_REGIME.RANGING;
      confidence = 0.6;
      tradeable = false;
      reason = `atr_too_low_${atrPercent.toFixed(2)}%<${atrQuietLow}%`;
      
      return { regime, confidence, tradeable, reason, details };
    }
  }
  
  // Step 2: ADX-based regime detection
  if (adx14 >= adxStrongTrend) {
    // Strong trending market
    regime = MARKET_REGIME.STRONG_TREND;
    confidence = Math.min(1, (adx14 - adxStrongTrend) / 20 + 0.7);
    tradeable = true;
    reason = `adx_strong_${adx14.toFixed(1)}>=${adxStrongTrend}`;
    
  } else if (adx14 >= adxWeakTrend) {
    // Weak trend - tradeable with caution
    regime = MARKET_REGIME.WEAK_TREND;
    confidence = 0.4 + (adx14 - adxWeakTrend) / (adxStrongTrend - adxWeakTrend) * 0.3;
    tradeable = true; // Allow but with caution
    reason = `adx_weak_${adx14.toFixed(1)}_between_${adxWeakTrend}_${adxStrongTrend}`;
    
  } else {
    // Ranging market - avoid trend-following
    regime = MARKET_REGIME.RANGING;
    confidence = 0.7 - (adx14 / adxWeakTrend) * 0.3;
    tradeable = false; // Don't trade trend-following in ranging market
    reason = `adx_ranging_${adx14.toFixed(1)}<${adxWeakTrend}`;
  }
  
  // Step 3: Additional EMA slope/separation check for ranging confirmation
  if (regime !== MARKET_REGIME.STRONG_TREND && emaSeparation !== null) {
    if (emaSeparation < emaSeparationMin) {
      // EMAs too close = ranging confirmation
      regime = MARKET_REGIME.RANGING;
      confidence = Math.max(confidence, 0.6);
      tradeable = false;
      reason = `ema_flat_separation_${(emaSeparation * 100).toFixed(3)}%<${(emaSeparationMin * 100).toFixed(3)}%`;
    }
  }
  
  if (regime !== MARKET_REGIME.RANGING && Number.isFinite(ema20Slope)) {
    if (Math.abs(ema20Slope) < emaSlopeFlat) {
      // EMA slope too flat = potential ranging
      if (regime === MARKET_REGIME.WEAK_TREND) {
        regime = MARKET_REGIME.RANGING;
        tradeable = false;
        reason = `ema_slope_flat_${Math.abs(ema20Slope).toFixed(5)}<${emaSlopeFlat}`;
      }
    }
  }
  
  return { regime, confidence, tradeable, reason, details };
}

/**
 * Entry gate: Check if market regime allows trading for FOLLOWING_TREND strategy
 * 
 * @param {Object} indicatorState - Indicator state
 * @param {number} currentPrice - Current price
 * @param {string} strategyType - Strategy type (e.g., 'FOLLOWING_TREND', 'MEAN_REVERSION')
 * @returns {Object} { ok: boolean, reason: string, regime: string, confidence: number }
 */
export function checkMarketRegimeGate(indicatorState, currentPrice, strategyType = 'FOLLOWING_TREND') {
  const enabled = configService.getBoolean('MARKET_REGIME_FILTER_ENABLED', true);
  if (!enabled) {
    return { ok: true, reason: 'market_regime_disabled' };
  }
  
  const result = detectMarketRegime(indicatorState, currentPrice);
  const strategy = String(strategyType || 'FOLLOWING_TREND').toUpperCase();
  
  // For trend-following strategies
  if (strategy === 'FOLLOWING_TREND') {
    if (result.tradeable) {
      return { 
        ok: true, 
        reason: `regime_ok_${result.regime}`, 
        regime: result.regime, 
        confidence: result.confidence,
        details: result.details
      };
    } else {
      return { 
        ok: false, 
        reason: `regime_not_tradeable_${result.reason}`, 
        regime: result.regime, 
        confidence: result.confidence,
        details: result.details
      };
    }
  }
  
  // For mean-reversion strategies (inverse logic)
  if (strategy === 'MEAN_REVERSION') {
    if (result.regime === MARKET_REGIME.RANGING) {
      return { 
        ok: true, 
        reason: `regime_ok_${result.regime}_for_mean_reversion`, 
        regime: result.regime, 
        confidence: result.confidence
      };
    } else {
      return { 
        ok: false, 
        reason: `regime_not_suitable_${result.regime}_for_mean_reversion`, 
        regime: result.regime, 
        confidence: result.confidence
      };
    }
  }
  
  // Unknown strategy type - allow
  return { ok: true, reason: `unknown_strategy_${strategy}`, regime: result.regime };
}

export default {
  MARKET_REGIME,
  detectMarketRegime,
  checkMarketRegimeGate
};
