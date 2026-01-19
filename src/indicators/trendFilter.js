import { configService } from '../services/ConfigService.js';

/**
 * Trend confirmation for FOLLOWING_TREND strategy.
 * 
 * ✅ ENHANCED: Multi-timeframe trend gate with 15m trend/regime filter
 * 
 * Indicators never flip direction.
 * They only validate/reject the already computed `direction` from OC.
 * 
 * @param {string} direction - 'bullish' or 'bearish'
 * @param {number} price - Current price
 * @param {Object} indicatorsState - Indicator state (1m for entry timing)
 * @param {Object} indicatorsState15m - Indicator state (15m for trend/regime gate) - OPTIONAL
 * @returns {Object} { ok: boolean, reason: string }
 */
export function isTrendConfirmed(direction, price, indicatorsState, indicatorsState15m = null) {
  const dir = String(direction || '').toLowerCase();
  const p = Number(price);
  if ((dir !== 'bullish' && dir !== 'bearish') || !Number.isFinite(p) || p <= 0) {
    return { ok: false, reason: 'invalid_input' };
  }

  // ✅ ENHANCED: Use 15m state for trend/regime gate if available, fallback to 1m
  const use15m = indicatorsState15m !== null && typeof indicatorsState15m?.snapshot === 'function';
  const trendState = use15m ? indicatorsState15m : indicatorsState;
  const snap = typeof trendState?.snapshot === 'function'
    ? trendState.snapshot()
    : (trendState || {});

  // ✅ ENHANCED: ADX threshold configurable (default: 25 for stricter filtering)
  const adxMin = Number(configService.getNumber('TREND_ADX_MIN', 25));

  const ema20 = Number(snap.ema20);
  const ema50 = Number(snap.ema50);
  const ema20Slope = Number(snap.ema20Slope);
  const adx14 = Number(snap.adx14);
  const rsi14 = Number(snap.rsi14);

  // Require indicators to be warmed up
  if (!Number.isFinite(ema20) || !Number.isFinite(ema50) || !Number.isFinite(ema20Slope)) {
    return { ok: false, reason: use15m ? 'ema15m_not_ready' : 'ema_not_ready' };
  }
  if (!Number.isFinite(rsi14)) {
    return { ok: false, reason: use15m ? 'rsi15m_not_ready' : 'rsi_not_ready' };
  }
  if (!Number.isFinite(adx14)) {
    return { ok: false, reason: use15m ? 'adx15m_not_ready' : 'adx_not_ready' };
  }

  // ✅ ENHANCED: Multi-timeframe EMA trend filter
  // If using 15m state: check EMA alignment on 15m timeframe (trend direction)
  // If using 1m state: check EMA alignment on 1m timeframe (entry timing)
  const emaOk = dir === 'bullish'
    ? (p > ema20 && ema20 > ema50 && ema20Slope > 0)
    : (p < ema20 && ema20 < ema50 && ema20Slope < 0);

  if (!emaOk) {
    return { ok: false, reason: use15m ? 'ema15m_filter' : 'ema_filter' };
  }

  // ✅ ENHANCED: ADX trend strength filter (configurable threshold, default: 25)
  // Purpose: block sideways regimes where OC spikes are likely fakeouts.
  if (adx14 < adxMin) {
    return { ok: false, reason: use15m ? `adx15m_sideways_${adx14.toFixed(1)}` : `adx_sideways_${adx14.toFixed(1)}` };
  }

  // 3) RSI regime filter
  // Purpose: avoid trading against micro-regime even if OC direction is present.
  const rsiOk = dir === 'bullish' ? (rsi14 >= 55) : (rsi14 <= 45);
  if (!rsiOk) {
    return { ok: false, reason: use15m ? 'rsi15m_regime' : 'rsi_regime' };
  }

  return { ok: true, reason: use15m ? 'confirmed_15m' : 'confirmed' };
}

