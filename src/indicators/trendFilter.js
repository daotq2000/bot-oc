import { configService } from '../services/ConfigService.js';

// =============================================================================
// TREND FILTER CONFIGURATION - "Hard Direction + Quality Scoring" Architecture
// =============================================================================
// Enhanced thresholds to improve entry quality and reduce false signals.
// Key changes:
// 1. Added RSI overbought/oversold protection
// 2. Added EMA separation requirement (avoid flat/sideways markets)
// 3. Made ADX requirement stricter when available

const TREND_THRESHOLDS = {
  // Phase 1: Hard Gate (EMA Direction + Separation)
  // EMA alignment is mandatory - Price > EMA20 > EMA50 for Long
  EMA_SEPARATION_MIN: 0.001,  // Minimum (EMA20-EMA50)/EMA50 = 0.1% separation to confirm trend

  // Phase 2: Soft Scoring - ADX Thresholds
  ADX_MIN_FLOOR: 18,          // ADX below this = no score
  ADX_SCORE_THRESHOLD: 20,    // ADX >= this value adds +1 to trend score
  ADX_STRONG_TREND: 35,       // ADX >= this = strong trend, relax RSI extreme thresholds

  // Phase 2: Soft Scoring - RSI Regime Thresholds
  RSI_BULL_MIN: 52,           // Bullish minimum (allows pullback entries)
  RSI_BEAR_MAX: 48,           // Bearish maximum
  
  // Phase 3: RSI Extreme Protection (HARD GATE)
  // ✅ ENHANCED: Dynamic thresholds based on ADX strength
  RSI_OVERBOUGHT: 75,         // LONG rejected if RSI > 75 (normal trend)
  RSI_OVERSOLD: 25,           // SHORT rejected if RSI < 25 (normal trend)
  RSI_OVERBOUGHT_STRONG: 80,  // LONG rejected if RSI > 80 (strong trend with ADX >= 35)
  RSI_OVERSOLD_STRONG: 20,    // SHORT rejected if RSI < 20 (strong trend with ADX >= 35)

  // Scoring Configuration
  TREND_MIN_SCORE: 1,         // Minimum score to confirm trend (ADX OR RSI, not both required)
};

/**
 * Trend confirmation for FOLLOWING_TREND strategy.
 * 
 * ✅ REFACTORED: "Hard Direction + Soft Scoring" Architecture
 * 
 * This approach replaces strict AND-gated logic with a more flexible scoring system:
 * 
 * PHASE 1 (Hard Gate): EMA Directional Alignment
 *   - Must pass: Price vs EMA20 vs EMA50 alignment
 *   - Failure = immediate rejection (reason: "ema_direction")
 * 
 * PHASE 2 (Soft Scoring): Trend Strength Confirmation
 *   - ADX >= threshold: +1 score
 *   - RSI in supportive regime: +1 score
 *   - Need score >= TREND_MIN_SCORE (default: 1)
 *   - This means we need EITHER reasonable ADX OR supportive RSI, not both
 * 
 * Benefits:
 *   1. Catches early breakouts (ADX threshold lowered, no longer hard gate)
 *   2. Accepts valid pullbacks (RSI loosened and soft-scored)
 *   3. Removed EMA slope requirement (reduces noise sensitivity)
 * 
 * @param {string} direction - 'bullish' or 'bearish'
 * @param {number} price - Current price
 * @param {Object} indicatorsState - Indicator state (1m for entry timing)
 * @param {Object} indicatorsState15m - Indicator state (15m for trend/regime gate) - OPTIONAL
 * @returns {Object} { ok: boolean, reason: string, score?: number, details?: Object }
 */
export function isTrendConfirmed(direction, price, indicatorsState, indicatorsState15m = null) {
  const dir = String(direction || '').toLowerCase();
  const p = Number(price);
  
  // Input validation
  if ((dir !== 'bullish' && dir !== 'bearish') || !Number.isFinite(p) || p <= 0) {
    return { ok: false, reason: 'invalid_input' };
  }

  // Determine which timeframe state to use (15m preferred for trend, fallback to 1m)
  const use15m = indicatorsState15m !== null && typeof indicatorsState15m?.snapshot === 'function';
  const trendState = use15m ? indicatorsState15m : indicatorsState;
  const snap = typeof trendState?.snapshot === 'function'
    ? trendState.snapshot()
    : (trendState || {});

  // Load configurable thresholds (with sensible defaults from TREND_THRESHOLDS)
  const adxScoreThreshold = Number(configService.getNumber('TREND_ADX_SCORE_THRESHOLD', TREND_THRESHOLDS.ADX_SCORE_THRESHOLD));
  const adxStrongTrend = Number(configService.getNumber('TREND_ADX_STRONG_TREND', TREND_THRESHOLDS.ADX_STRONG_TREND));
  const rsiBullMin = Number(configService.getNumber('TREND_RSI_BULL_MIN', TREND_THRESHOLDS.RSI_BULL_MIN));
  const rsiBearMax = Number(configService.getNumber('TREND_RSI_BEAR_MAX', TREND_THRESHOLDS.RSI_BEAR_MAX));
  
  // ✅ ENHANCED: Load both normal and strong trend RSI thresholds
  const rsiOverboughtNormal = Number(configService.getNumber('TREND_RSI_OVERBOUGHT', TREND_THRESHOLDS.RSI_OVERBOUGHT));
  const rsiOversoldNormal = Number(configService.getNumber('TREND_RSI_OVERSOLD', TREND_THRESHOLDS.RSI_OVERSOLD));
  const rsiOverboughtStrong = Number(configService.getNumber('TREND_RSI_OVERBOUGHT_STRONG', TREND_THRESHOLDS.RSI_OVERBOUGHT_STRONG));
  const rsiOversoldStrong = Number(configService.getNumber('TREND_RSI_OVERSOLD_STRONG', TREND_THRESHOLDS.RSI_OVERSOLD_STRONG));
  const emaSeparationMin = Number(configService.getNumber('TREND_EMA_SEPARATION_MIN', TREND_THRESHOLDS.EMA_SEPARATION_MIN));
  const minScore = Number(configService.getNumber('TREND_MIN_SCORE', TREND_THRESHOLDS.TREND_MIN_SCORE));

  // Extract indicator values
  const ema20 = Number(snap.ema20);
  const ema50 = Number(snap.ema50);
  const adx14 = Number(snap.adx14);
  const rsi14 = Number(snap.rsi14);

  // ---------------------------------------------------------------------------
  // INDICATOR WARMUP CHECK
  // ---------------------------------------------------------------------------
  if (!Number.isFinite(ema20) || !Number.isFinite(ema50)) {
    return { ok: false, reason: use15m ? 'ema15m_not_ready' : 'ema_not_ready' };
  }
  if (!Number.isFinite(rsi14)) {
    return { ok: false, reason: use15m ? 'rsi15m_not_ready' : 'rsi_not_ready' };
  }
  if (!Number.isFinite(adx14)) {
    return { ok: false, reason: use15m ? 'adx15m_not_ready' : 'adx_not_ready' };
  }

  // ---------------------------------------------------------------------------
  // PHASE 1: HARD GATE - EMA Directional Alignment (Mandatory)
  // ---------------------------------------------------------------------------
  // For Long:  Price > EMA20 > EMA50 (bullish structure)
  // For Short: Price < EMA20 < EMA50 (bearish structure)
  const emaDirectionOk = dir === 'bullish'
    ? (p > ema20 && ema20 > ema50)
    : (p < ema20 && ema20 < ema50);

  if (!emaDirectionOk) {
    return { 
      ok: false, 
      reason: use15m ? 'ema15m_direction' : 'ema_direction',
      details: { price: p, ema20, ema50, direction: dir }
    };
  }

  // ---------------------------------------------------------------------------
  // PHASE 1.5: HARD GATE - EMA Separation (NEW!)
  // ---------------------------------------------------------------------------
  // Require minimum separation between EMA20 and EMA50 to ensure actual trend
  // Avoid flat markets where EMA20 ≈ EMA50
  const emaSeparation = Math.abs(ema20 - ema50) / ema50;
  if (emaSeparation < emaSeparationMin) {
    return {
      ok: false,
      reason: use15m ? 'ema15m_flat' : 'ema_flat',
      details: { 
        ema20, ema50, 
        separation: (emaSeparation * 100).toFixed(3) + '%',
        required: (emaSeparationMin * 100).toFixed(3) + '%',
        hint: 'EMA20 and EMA50 too close - market may be sideways/ranging'
      }
    };
  }

  // ---------------------------------------------------------------------------
  // PHASE 1.6: HARD GATE - RSI Extreme Protection
  // ---------------------------------------------------------------------------
  // ✅ ENHANCED: Dynamic RSI thresholds based on ADX strength
  // When ADX >= 35 (strong trend), we relax RSI thresholds to avoid missing strong moves
  // - Normal trend (ADX < 35): RSI overbought=75, oversold=25
  // - Strong trend (ADX >= 35): RSI overbought=80, oversold=20
  const isStrongTrend = adx14 >= adxStrongTrend;
  const rsiOverbought = isStrongTrend ? rsiOverboughtStrong : rsiOverboughtNormal;
  const rsiOversold = isStrongTrend ? rsiOversoldStrong : rsiOversoldNormal;
  
  if (dir === 'bullish' && rsi14 > rsiOverbought) {
    return {
      ok: false,
      reason: use15m ? 'rsi15m_overbought' : 'rsi_overbought',
      details: { 
        rsi14, 
        threshold: rsiOverbought, 
        adx14,
        isStrongTrend,
        hint: `RSI ${rsi14.toFixed(1)} > ${rsiOverbought} - overbought, avoid LONG${isStrongTrend ? ' (strong trend threshold)' : ''}` 
      }
    };
  }
  if (dir === 'bearish' && rsi14 < rsiOversold) {
    return {
      ok: false,
      reason: use15m ? 'rsi15m_oversold' : 'rsi_oversold',
      details: { 
        rsi14, 
        threshold: rsiOversold, 
        adx14,
        isStrongTrend,
        hint: `RSI ${rsi14.toFixed(1)} < ${rsiOversold} - oversold, avoid SHORT${isStrongTrend ? ' (strong trend threshold)' : ''}` 
      }
    };
  }

  // ---------------------------------------------------------------------------
  // PHASE 2: SOFT SCORING - Trend Strength Confirmation
  // ---------------------------------------------------------------------------
  // Each condition contributes +1 to score. We need score >= TREND_MIN_SCORE.
  // This allows flexibility: strong ADX alone OR supportive RSI alone can confirm.
  let score = 0;
  const scoreBreakdown = {
    adxContribution: false,
    rsiContribution: false,
  };

  // Condition A: ADX Trend Strength
  // ADX >= threshold indicates a trending market (not sideways/ranging)
  // Lowered from 25 to 20 to catch early breakouts before ADX fully ramps up
  if (adx14 >= adxScoreThreshold) {
    score++;
    scoreBreakdown.adxContribution = true;
  }

  // Condition B: RSI Regime Support
  // Long:  RSI >= 52 (allows pullback entries)
  // Short: RSI <= 48 (allows pullback entries)
  const rsiRegimeOk = dir === 'bullish' 
    ? (rsi14 >= rsiBullMin) 
    : (rsi14 <= rsiBearMax);
  
  if (rsiRegimeOk) {
    score++;
    scoreBreakdown.rsiContribution = true;
  }

  // ---------------------------------------------------------------------------
  // FINAL DECISION
  // ---------------------------------------------------------------------------
  if (score >= minScore) {
    // Trend confirmed: EMA direction valid + sufficient trend strength score
    const strengthLabel = isStrongTrend ? 'strong' : (score >= 2 ? 'moderate' : 'weak');
    return { 
      ok: true, 
      reason: use15m ? `confirmed_15m_${strengthLabel}` : `confirmed_${strengthLabel}`,
      score,
      isStrongTrend,
      details: {
        ema20, ema50, adx14, rsi14,
        emaSeparation: (emaSeparation * 100).toFixed(3) + '%',
        scoreBreakdown,
        isStrongTrend,
        thresholds: { 
          adxScoreThreshold, 
          adxStrongTrend,
          rsiBullMin, 
          rsiBearMax, 
          rsiOverbought, 
          rsiOversold,
          rsiOverboughtNormal,
          rsiOversoldNormal,
          rsiOverboughtStrong,
          rsiOversoldStrong,
          emaSeparationMin, 
          minScore 
        }
      }
    };
  }

  // Trend rejected: EMA direction OK but insufficient trend strength
  return { 
    ok: false, 
    reason: use15m ? 'weak_trend_15m' : 'weak_trend',
    score,
    isStrongTrend,
    details: {
      ema20, ema50, adx14, rsi14,
      emaSeparation: (emaSeparation * 100).toFixed(3) + '%',
      scoreBreakdown,
      isStrongTrend,
      thresholds: { adxScoreThreshold, adxStrongTrend, rsiBullMin, rsiBearMax, rsiOverbought, rsiOversold, emaSeparationMin, minScore },
      hint: `Score ${score} < required ${minScore}. ADX=${adx14.toFixed(1)} (need>=${adxScoreThreshold}), RSI=${rsi14.toFixed(1)} (need ${dir === 'bullish' ? '>=' + rsiBullMin : '<=' + rsiBearMax})`
    }
  };
}
