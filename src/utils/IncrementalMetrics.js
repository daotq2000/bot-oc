/**
 * Incremental Metrics Calculator
 * 
 * Tính toán metrics incrementally thay vì recalculate từ đầu mỗi lần.
 * Giảm CPU usage từ O(n) xuống O(1) cho mỗi update.
 * 
 * ✅ OPTIMIZED: O(1) calculations thay vì O(n)
 */
export class IncrementalMetrics {
  constructor(options = {}) {
    this.ema = null;
    this.atr = null;
    this.vwap = null;
    this.count = 0;
    this.volumeSum = 0;
    this.priceVolumeSum = 0;
    
    // EMA smoothing factor
    this.emaAlpha = options.emaAlpha || null; // Auto-calculate based on period
    this.emaPeriod = options.emaPeriod || 20;
    
    // ATR period
    this.atrPeriod = options.atrPeriod || 14;
    
    // VWAP reset interval (milliseconds)
    this.vwapResetInterval = options.vwapResetInterval || 24 * 60 * 60 * 1000; // 24 hours
    this.vwapLastReset = Date.now();
  }

  /**
   * Update với price data mới
   * @param {number} price - Current price
   * @param {number} high - High price
   * @param {number} low - Low price
   * @param {number} volume - Volume (optional, for VWAP)
   */
  update(price, high, low, volume = 0) {
    this.count++;
    
    // Initialize EMA alpha if not set
    if (this.emaAlpha === null) {
      this.emaAlpha = 2 / (this.emaPeriod + 1);
    }
    
    // Incremental EMA calculation - O(1)
    if (this.ema === null) {
      this.ema = price; // First value
    } else {
      // EMA = alpha * price + (1 - alpha) * previous_EMA
      this.ema = this.emaAlpha * price + (1 - this.emaAlpha) * this.ema;
    }
    
    // Incremental ATR calculation - O(1)
    const tr = high - low; // True Range (simplified, could include gap)
    if (this.atr === null) {
      this.atr = tr; // First value
    } else {
      // ATR = (ATR * (period - 1) + TR) / period
      this.atr = (this.atr * (this.atrPeriod - 1) + tr) / this.atrPeriod;
    }
    
    // Incremental VWAP calculation - O(1)
    if (volume > 0) {
      // Check if need to reset VWAP (e.g., new trading day)
      const now = Date.now();
      if (now - this.vwapLastReset > this.vwapResetInterval) {
        this.volumeSum = 0;
        this.priceVolumeSum = 0;
        this.vwapLastReset = now;
      }
      
      this.volumeSum += volume;
      this.priceVolumeSum += price * volume;
      
      if (this.volumeSum > 0) {
        this.vwap = this.priceVolumeSum / this.volumeSum;
      }
    }
  }

  /**
   * Get current EMA
   * @returns {number|null}
   */
  getEMA() {
    return this.ema;
  }

  /**
   * Get current ATR
   * @returns {number|null}
   */
  getATR() {
    return this.atr;
  }

  /**
   * Get current VWAP
   * @returns {number|null}
   */
  getVWAP() {
    return this.vwap;
  }

  /**
   * Reset all metrics
   */
  reset() {
    this.ema = null;
    this.atr = null;
    this.vwap = null;
    this.count = 0;
    this.volumeSum = 0;
    this.priceVolumeSum = 0;
    this.vwapLastReset = Date.now();
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return {
      count: this.count,
      ema: this.ema,
      atr: this.atr,
      vwap: this.vwap,
      emaPeriod: this.emaPeriod,
      atrPeriod: this.atrPeriod
    };
  }
}

/**
 * Symbol-specific metrics manager
 * Tracks metrics cho mỗi symbol/interval combination
 */
export class SymbolMetricsManager {
  constructor() {
    this.metrics = new Map(); // key: exchange|symbol|interval -> IncrementalMetrics
    this.maxMetrics = 1000; // Limit số lượng symbols tracked
  }

  /**
   * Get or create metrics cho một symbol/interval
   * @param {string} exchange - Exchange name
   * @param {string} symbol - Symbol
   * @param {string} interval - Interval
   * @param {Object} options - Options for IncrementalMetrics
   * @returns {IncrementalMetrics}
   */
  getMetrics(exchange, symbol, interval, options = {}) {
    const key = `${exchange}|${symbol}|${interval}`;
    
    if (!this.metrics.has(key)) {
      // Evict oldest nếu đạt limit
      if (this.metrics.size >= this.maxMetrics) {
        const firstKey = this.metrics.keys().next().value;
        this.metrics.delete(firstKey);
      }
      
      this.metrics.set(key, new IncrementalMetrics(options));
    }
    
    return this.metrics.get(key);
  }

  /**
   * Update metrics cho một symbol/interval
   * @param {string} exchange - Exchange name
   * @param {string} symbol - Symbol
   * @param {string} interval - Interval
   * @param {number} price - Current price
   * @param {number} high - High price
   * @param {number} low - Low price
   * @param {number} volume - Volume (optional)
   */
  update(exchange, symbol, interval, price, high, low, volume = 0) {
    const metrics = this.getMetrics(exchange, symbol, interval);
    metrics.update(price, high, low, volume);
  }

  /**
   * Clear metrics cho một symbol/interval
   * @param {string} exchange - Exchange name
   * @param {string} symbol - Symbol
   * @param {string} interval - Interval
   */
  clear(exchange, symbol, interval) {
    const key = `${exchange}|${symbol}|${interval}`;
    this.metrics.delete(key);
  }

  /**
   * Clear all metrics
   */
  clearAll() {
    this.metrics.clear();
  }
}

// Export singleton instance
export const symbolMetricsManager = new SymbolMetricsManager();

