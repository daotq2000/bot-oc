export class RSI {
  constructor(period = 14) {
    this.period = Number(period);
    if (!Number.isFinite(this.period) || this.period <= 0) {
      throw new Error(`Invalid RSI period: ${period}`);
    }

    this.prevClose = null;
    this.avgGain = null;
    this.avgLoss = null;
    this.value = null;
    this.samples = 0;
  }

  /**
   * Update RSI with next close price.
   * Uses Wilder smoothing after initial warmup.
   */
  update(close) {
    const c = Number(close);
    if (!Number.isFinite(c)) return this.value;

    if (this.prevClose === null) {
      this.prevClose = c;
      return this.value;
    }

    const change = c - this.prevClose;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    if (this.avgGain === null || this.avgLoss === null) {
      // Warmup: accumulate simple average for first `period` deltas
      this.samples += 1;
      this.avgGain = (this.avgGain || 0) + gain;
      this.avgLoss = (this.avgLoss || 0) + loss;

      if (this.samples >= this.period) {
        this.avgGain = this.avgGain / this.period;
        this.avgLoss = this.avgLoss / this.period;
        this.value = this._calcRsi(this.avgGain, this.avgLoss);
      }

      this.prevClose = c;
      return this.value;
    }

    // Wilder smoothing
    this.avgGain = ((this.avgGain * (this.period - 1)) + gain) / this.period;
    this.avgLoss = ((this.avgLoss * (this.period - 1)) + loss) / this.period;

    this.value = this._calcRsi(this.avgGain, this.avgLoss);
    this.prevClose = c;
    return this.value;
  }

  _calcRsi(avgGain, avgLoss) {
    if (!Number.isFinite(avgGain) || !Number.isFinite(avgLoss)) return null;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }
}

