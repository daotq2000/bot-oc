import { EMA } from './ema.js';
import { RSI } from './rsi.js';
import { ADX } from './adx.js';
import { ATR } from './atr.js';
import { donchian } from './donchian.js';
import { rvolFromCandles } from './rvol.js';
import { SMA } from './sma.js';
import { BB } from './bb.js';

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
    atrPeriod = 14,
    donchianPeriod = 20,
    rvolPeriod = 20
  , bbPeriod = 20, bbStdDev = 2, vmaPeriod = 20
  } = {}) {
    this.ema20 = new EMA(emaFastPeriod);
    this.ema50 = new EMA(emaSlowPeriod);
    this.rsi14 = new RSI(rsiPeriod);
    this.adx14 = new ADX(adxPeriod);
    this.atr14 = new ATR(atrPeriod);

    // 5m structure/volume gates (computed from CLOSED candles)
    this.donchianPeriod = Math.max(1, Number(donchianPeriod) || 20);
    this.rvolPeriod = Math.max(1, Number(rvolPeriod) || 20);
    this.donchianHigh = null;
    this.donchianLow = null;
    this.rvol = null;
    this.rvolCurrentVolume = null;
    this.rvolAvgVolume = null;

  // Bollinger Bands & Volume MA
    this.bbPeriod = Math.max(1, Number(bbPeriod) || 20);
    this.bbStdDev = Number(bbStdDev) || 2;
    this.bollinger = null;
    this.vmaPeriod = Math.max(1, Number(vmaPeriod) || 20);
    this.vma = null;
    this.currentVolume = null;

    this._closedCandles = [];
    this._closedCandlesMax = Math.max(this.donchianPeriod, this.rvolPeriod, this.bbPeriod, this.vmaPeriod, 20) + 5;

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

    // Store closed candle for structure/volume calculations
    this._closedCandles.push(candle);
    if (this._closedCandles.length > this._closedCandlesMax) {
      this._closedCandles.splice(0, this._closedCandles.length - this._closedCandlesMax);
    }

    // Compute Donchian / RVOL when we have enough closed candles
    const dc = donchian(this._closedCandles, this.donchianPeriod);
    this.donchianHigh = dc.high;
    this.donchianLow = dc.low;

    const rv = rvolFromCandles(this._closedCandles, this.rvolPeriod, true);
    this.rvol = rv.rvol;
    this.rvolCurrentVolume = rv.currentVolume;
    this.rvolAvgVolume = rv.avgVolume;

    // Compute Bollinger Bands
    if (this._closedCandles.length >= this.bbPeriod) {
      const closes = this._closedCandles.map(c => c.close);
      const bbArr = BB.calculate({
        period: this.bbPeriod,
        values: closes,
        stdDev: this.bbStdDev
      });
      this.bollinger = bbArr.length > 0 ? bbArr[bbArr.length - 1] : null;
    } else {
      this.bollinger = null;
    }

    // Compute Volume MA
    if (this._closedCandles.length >= this.vmaPeriod) {
      const volumes = this._closedCandles.map(c => c.volume);
      const vmaArr = SMA.calculate({
        period: this.vmaPeriod,
        values: volumes
      });
      this.vma = vmaArr.length > 0 ? vmaArr[vmaArr.length - 1] : null;
      this.currentVolume = volumes[volumes.length - 1];
    } else {
      this.vma = null;
      this.currentVolume = null;
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

      donchianHigh: this.donchianHigh,
      donchianLow: this.donchianLow,
      rvol: this.rvol,
      rvolCurrentVolume: this.rvolCurrentVolume,
      rvolAvgVolume: this.rvolAvgVolume,

      bollinger: this.bollinger ? {
        upper: this.bollinger.upper,
        middle: this.bollinger.middle,
        lower: this.bollinger.lower
      } : null,
      volume: {
        current: this.currentVolume,
        ma: this.vma,
        ratio: (this.vma && this.currentVolume) ? (this.currentVolume / this.vma) : 0
      },

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

