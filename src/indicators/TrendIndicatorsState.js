import { EMA } from './ema.js';
import { RSI } from './rsi.js';
import { ADX } from './adx.js';
import { ATR } from './atr.js';

/**
 * Lightweight per-(exchange|symbol) indicator state.
 * 
 * - EMA/RSI update on every tick (fast reaction)
 * - ADX updates only on CLOSED candles to avoid tick noise
 * - ATR updates only on CLOSED candles for volatility filtering
 */
export class TrendIndicatorsState {
  constructor({
    emaFastPeriod = 20,
    emaSlowPeriod = 50,
    rsiPeriod = 14,
    adxPeriod = 14,
    adxInterval = '1m',
    atrPeriod = 14
  } = {}) {
    this.ema20 = new EMA(emaFastPeriod);
    this.ema50 = new EMA(emaSlowPeriod);
    this.rsi14 = new RSI(rsiPeriod);
    this.adx14 = new ADX(adxPeriod);
    this.atr14 = new ATR(atrPeriod);

    this.adxInterval = String(adxInterval).toLowerCase();

    // To avoid double-processing same candle
    this._lastAdxCandleStart = null;
    this._lastAtrCandleStart = null;

    this.lastPrice = null;
    this.lastUpdateTs = 0;
  }

  updateTick(price, ts = Date.now()) {
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) return;

    this.lastPrice = p;
    this.lastUpdateTs = Number(ts) || Date.now();

    this.ema20.update(p);
    this.ema50.update(p);
    // RSI on tick closes (scalping-friendly)
    this.rsi14.update(p);
  }

  /**
   * Update ADX and ATR from a CLOSED candle.
   * candle: { startTime, high, low, close, isClosed }
   */
  updateClosedCandle(candle) {
    if (!candle || candle.isClosed !== true) return;

    const startTime = Number(candle.startTime);
    if (!Number.isFinite(startTime) || startTime <= 0) return;

    // Update ADX (only once per candle)
    if (this._lastAdxCandleStart !== startTime) {
      this._lastAdxCandleStart = startTime;
      this.adx14.updateCandle(candle);
    }

    // Update ATR (only once per candle)
    if (this._lastAtrCandleStart !== startTime) {
      this._lastAtrCandleStart = startTime;
      this.atr14.updateCandle(candle);
    }
  }

  snapshot() {
    return {
      ema20: this.ema20.value,
      ema50: this.ema50.value,
      ema20Slope: this.ema20.slope(),
      rsi14: this.rsi14.value,
      adx14: this.adx14.value,
      atr14: this.atr14.value,
      lastPrice: this.lastPrice,
      lastUpdateTs: this.lastUpdateTs
    };
  }

  /**
   * Check if indicators are warmed up (ready for trading).
   * @returns {boolean} True if all indicators have valid values
   */
  isWarmedUp() {
    const snap = this.snapshot();
    return Number.isFinite(snap.ema20) && 
           Number.isFinite(snap.ema50) && 
           Number.isFinite(snap.ema20Slope) &&
           Number.isFinite(snap.rsi14) && 
           Number.isFinite(snap.adx14) &&
           Number.isFinite(snap.atr14);
  }
}

