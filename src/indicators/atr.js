/**
 * Average True Range (ATR) indicator
 * 
 * ATR measures market volatility by calculating the average of true ranges over a period.
 * True Range = max(high - low, abs(high - prevClose), abs(low - prevClose))
 * 
 * Used for volatility filtering to avoid trading in too quiet (whipsaw-prone) or too volatile (SL-prone) markets.
 */
export class ATR {
  constructor(period = 14) {
    this.period = Number(period) || 14;
    this.values = []; // Array of true range values
    this.lastClose = null;
  }

  /**
   * Update ATR from a candle
   * @param {Object} candle - { high, low, close }
   */
  updateCandle(candle) {
    if (!candle) return;

    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);

    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
      return;
    }

    let trueRange;
    if (this.lastClose === null) {
      // First candle: TR = high - low
      trueRange = high - low;
    } else {
      // True Range = max(high - low, abs(high - prevClose), abs(low - prevClose))
      const tr1 = high - low;
      const tr2 = Math.abs(high - this.lastClose);
      const tr3 = Math.abs(low - this.lastClose);
      trueRange = Math.max(tr1, tr2, tr3);
    }

    this.values.push(trueRange);
    if (this.values.length > this.period) {
      this.values.shift(); // Keep only last N values
    }

    this.lastClose = close;
  }

  /**
   * Get current ATR value
   * @returns {number|null} ATR value or null if not enough data
   */
  get value() {
    if (this.values.length < this.period) {
      return null; // Not enough data
    }
    // Simple moving average of true ranges
    const sum = this.values.reduce((a, b) => a + b, 0);
    return sum / this.values.length;
  }

  /**
   * Check if ATR is warmed up (has enough data)
   * @returns {boolean}
   */
  isWarmedUp() {
    return this.values.length >= this.period;
  }

  /**
   * Reset ATR state
   */
  reset() {
    this.values = [];
    this.lastClose = null;
  }
}

