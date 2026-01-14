/**
 * Trend confirmation for FOLLOWING_TREND strategy.
 * 
 * Indicators never flip direction.
 * They only validate/reject the already computed `direction` from OC.
 */
export function isTrendConfirmed(direction, price, indicatorsState) {
  const dir = String(direction || '').toLowerCase();
  const p = Number(price);
  if ((dir !== 'bullish' && dir !== 'bearish') || !Number.isFinite(p) || p <= 0) {
    return { ok: false, reason: 'invalid_input' };
  }

  const snap = typeof indicatorsState?.snapshot === 'function'
    ? indicatorsState.snapshot()
    : (indicatorsState || {});

  const ema20 = Number(snap.ema20);
  const ema50 = Number(snap.ema50);
  const ema20Slope = Number(snap.ema20Slope);
  const adx14 = Number(snap.adx14);
  const rsi14 = Number(snap.rsi14);

  // Require indicators to be warmed up
  if (!Number.isFinite(ema20) || !Number.isFinite(ema50) || !Number.isFinite(ema20Slope)) {
    return { ok: false, reason: 'ema_not_ready' };
  }
  if (!Number.isFinite(rsi14)) {
    return { ok: false, reason: 'rsi_not_ready' };
  }
  if (!Number.isFinite(adx14)) {
    return { ok: false, reason: 'adx_not_ready' };
  }

  // 1) EMA trend filter
  // Purpose: confirm price is aligned with short-term trend and avoid sideways whipsaws.
  const emaOk = dir === 'bullish'
    ? (p > ema20 && ema20 > ema50 && ema20Slope > 0)
    : (p < ema20 && ema20 < ema50 && ema20Slope < 0);

  if (!emaOk) {
    return { ok: false, reason: 'ema_filter' };
  }

  // 2) ADX trend strength filter
  // Purpose: block sideways regimes where OC spikes are likely fakeouts.
  if (adx14 < 20) {
    return { ok: false, reason: 'adx_sideways' };
  }

  // 3) RSI regime filter
  // Purpose: avoid trading against micro-regime even if OC direction is present.
  const rsiOk = dir === 'bullish' ? (rsi14 >= 55) : (rsi14 <= 45);
  if (!rsiOk) {
    return { ok: false, reason: 'rsi_regime' };
  }

  return { ok: true, reason: 'confirmed' };
}

