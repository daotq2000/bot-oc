export class EMA {
  constructor(period) {
    this.period = Number(period);
    if (!Number.isFinite(this.period) || this.period <= 0) {
      throw new Error(`Invalid EMA period: ${period}`);
    }
    this.alpha = 2 / (this.period + 1);
    this.value = null;
    this.prev = null;
    this.samples = 0;
  }

  /**
   * Update EMA with next price.
   * Uses first value as seed (fast start, suitable for scalping).
   */
  update(price) {
    const p = Number(price);
    if (!Number.isFinite(p)) return this.value;

    if (this.value === null) {
      this.prev = this.value;
      this.value = p;
      this.samples = 1;
      return this.value;
    }

    this.prev = this.value;
    this.value = (p - this.value) * this.alpha + this.value;
    this.samples += 1;
    return this.value;
  }

  slope() {
    if (this.value === null || this.prev === null) return 0;
    return this.value - this.prev;
  }
}

