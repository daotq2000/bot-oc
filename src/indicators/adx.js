/**
 * ADX(14) streaming calculator.
 * 
 * Requirements:
 * - Update using CLOSED candles (OHLC) to avoid tick noise.
 * - Keeps only rolling smoothed values (Wilder), no full history.
 */
export class ADX {
  constructor(period = 14) {
    this.period = Number(period);
    if (!Number.isFinite(this.period) || this.period <= 0) {
      throw new Error(`Invalid ADX period: ${period}`);
    }

    this.prevHigh = null;
    this.prevLow = null;
    this.prevClose = null;

    // Wilder-smoothed components
    this.tr14 = null;
    this.plusDM14 = null;
    this.minusDM14 = null;

    // Wilder-smoothed ADX
    this.adx = null;
    this.dx14 = null;

    // Warmup accumulators
    this._warmupCount = 0;
    this._sumTR = 0;
    this._sumPlusDM = 0;
    this._sumMinusDM = 0;
    this._sumDX = 0;

    this.value = null;
  }

  /**
   * Update ADX with a CLOSED candle.
   * candle: { high, low, close }
   */
  updateCandle(candle) {
    const h = Number(candle?.high);
    const l = Number(candle?.low);
    const c = Number(candle?.close);
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) {
      return this.value;
    }

    // Need previous candle to compute TR/DM
    if (this.prevHigh === null || this.prevLow === null || this.prevClose === null) {
      this.prevHigh = h;
      this.prevLow = l;
      this.prevClose = c;
      return this.value;
    }

    const upMove = h - this.prevHigh;
    const downMove = this.prevLow - l;

    const plusDM = (upMove > downMove && upMove > 0) ? upMove : 0;
    const minusDM = (downMove > upMove && downMove > 0) ? downMove : 0;

    const tr = Math.max(
      h - l,
      Math.abs(h - this.prevClose),
      Math.abs(l - this.prevClose)
    );

    if (this.tr14 === null) {
      // Warmup TR/DM for first `period` values
      this._warmupCount += 1;
      this._sumTR += tr;
      this._sumPlusDM += plusDM;
      this._sumMinusDM += minusDM;

      if (this._warmupCount === this.period) {
        this.tr14 = this._sumTR;
        this.plusDM14 = this._sumPlusDM;
        this.minusDM14 = this._sumMinusDM;

        const { dx } = this._computeDX();
        // DX warmup starts after first smoothing seed
        this._sumDX = dx;
      }

      this.prevHigh = h;
      this.prevLow = l;
      this.prevClose = c;
      return this.value;
    }

    // Wilder smoothing
    this.tr14 = this.tr14 - (this.tr14 / this.period) + tr;
    this.plusDM14 = this.plusDM14 - (this.plusDM14 / this.period) + plusDM;
    this.minusDM14 = this.minusDM14 - (this.minusDM14 / this.period) + minusDM;

    const { dx } = this._computeDX();

    if (this.adx === null) {
      // ADX warmup: average of first `period` DX values
      this._sumDX += dx;
      this._warmupCount += 1;
      if (this._warmupCount === this.period * 2) {
        // At this point, we have period DX values accumulated
        this.adx = this._sumDX / this.period;
        this.value = this.adx;
      }
    } else {
      this.adx = ((this.adx * (this.period - 1)) + dx) / this.period;
      this.value = this.adx;
    }

    this.prevHigh = h;
    this.prevLow = l;
    this.prevClose = c;

    return this.value;
  }

  _computeDX() {
    const tr = this.tr14;
    if (!Number.isFinite(tr) || tr <= 0) return { dx: 0, plusDI: 0, minusDI: 0 };

    const plusDI = 100 * (this.plusDM14 / tr);
    const minusDI = 100 * (this.minusDM14 / tr);
    const denom = plusDI + minusDI;

    const dx = denom <= 0 ? 0 : 100 * (Math.abs(plusDI - minusDI) / denom);
    this.dx14 = dx;
    return { dx, plusDI, minusDI };
  }
}