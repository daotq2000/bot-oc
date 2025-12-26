/**
 * Symbol State Manager
 * 
 * Centralized state management cho mỗi symbol.
 * Giảm memory overhead và improve cache efficiency.
 * 
 * ✅ OPTIMIZED: Centralized state với automatic cleanup
 */
export class SymbolState {
  constructor(exchange, symbol) {
    this.exchange = exchange;
    this.symbol = symbol;
    this.currentPrice = null;
    this.lastPrice = null;
    this.openPrices = new Map(); // interval -> { open, bucketStart, lastUpdate }
    this.lastUpdate = Date.now();
    this.updateCount = 0;
  }

  /**
   * Update current price
   * @param {number} price - Current price
   */
  updatePrice(price) {
    this.lastPrice = this.currentPrice;
    this.currentPrice = price;
    this.lastUpdate = Date.now();
    this.updateCount++;
  }

  /**
   * Update open price cho một interval
   * @param {string} interval - Interval
   * @param {number} open - Open price
   * @param {number} bucketStart - Bucket start timestamp
   */
  updateOpenPrice(interval, open, bucketStart) {
    this.openPrices.set(interval, {
      open,
      bucketStart,
      lastUpdate: Date.now()
    });
  }

  /**
   * Get open price cho một interval
   * @param {string} interval - Interval
   * @param {number} bucketStart - Bucket start timestamp
   * @returns {number|null}
   */
  getOpenPrice(interval, bucketStart) {
    const cached = this.openPrices.get(interval);
    if (cached && cached.bucketStart === bucketStart) {
      return cached.open;
    }
    return null;
  }

  /**
   * Calculate OC cho một interval
   * @param {string} interval - Interval
   * @param {number} bucketStart - Bucket start timestamp
   * @returns {number|null} OC percentage hoặc null nếu không có data
   */
  getOC(interval, bucketStart) {
    const open = this.getOpenPrice(interval, bucketStart);
    if (!open || !this.currentPrice) return null;
    
    return ((this.currentPrice - open) / open) * 100;
  }

  /**
   * Get price change percentage
   * @returns {number|null}
   */
  getPriceChange() {
    if (!this.currentPrice || !this.lastPrice) return null;
    return ((this.currentPrice - this.lastPrice) / this.lastPrice) * 100;
  }

  /**
   * Check if price changed significantly
   * @param {number} threshold - Threshold percentage (default: 0.01%)
   * @returns {boolean}
   */
  hasPriceChanged(threshold = 0.0001) {
    const change = this.getPriceChange();
    if (change === null) return true; // First update
    return Math.abs(change) >= threshold;
  }

  /**
   * Get state summary
   * @returns {Object}
   */
  getSummary() {
    return {
      exchange: this.exchange,
      symbol: this.symbol,
      currentPrice: this.currentPrice,
      lastPrice: this.lastPrice,
      lastUpdate: this.lastUpdate,
      updateCount: this.updateCount,
      openPricesCount: this.openPrices.size
    };
  }
}

/**
 * Symbol State Manager
 * Manages state cho tất cả symbols
 */
export class SymbolStateManager {
  constructor() {
    this.states = new Map(); // exchange|symbol -> SymbolState
    this.maxStates = 2000; // Limit active symbols
    this.cleanupInterval = null;
    this.maxIdleTime = 10 * 60 * 1000; // 10 minutes
  }

  /**
   * Get or create state cho một symbol
   * @param {string} exchange - Exchange name
   * @param {string} symbol - Symbol
   * @returns {SymbolState}
   */
  getState(exchange, symbol) {
    const key = `${exchange}|${symbol}`;
    
    if (!this.states.has(key)) {
      // Evict least recently used nếu đạt limit
      if (this.states.size >= this.maxStates) {
        this._evictLeastUsed();
      }
      
      this.states.set(key, new SymbolState(exchange, symbol));
    }
    
    const state = this.states.get(key);
    state.lastUpdate = Date.now(); // Update access time
    return state;
  }

  /**
   * Update price cho một symbol
   * @param {string} exchange - Exchange name
   * @param {string} symbol - Symbol
   * @param {number} price - Current price
   */
  updatePrice(exchange, symbol, price) {
    const state = this.getState(exchange, symbol);
    state.updatePrice(price);
  }

  /**
   * Update open price cho một symbol/interval
   * @param {string} exchange - Exchange name
   * @param {string} symbol - Symbol
   * @param {string} interval - Interval
   * @param {number} open - Open price
   * @param {number} bucketStart - Bucket start timestamp
   */
  updateOpenPrice(exchange, symbol, interval, open, bucketStart) {
    const state = this.getState(exchange, symbol);
    state.updateOpenPrice(interval, open, bucketStart);
  }

  /**
   * Get OC cho một symbol/interval
   * @param {string} exchange - Exchange name
   * @param {string} symbol - Symbol
   * @param {string} interval - Interval
   * @param {number} bucketStart - Bucket start timestamp
   * @returns {number|null}
   */
  getOC(exchange, symbol, interval, bucketStart) {
    const key = `${exchange}|${symbol}`;
    const state = this.states.get(key);
    if (!state) return null;
    return state.getOC(interval, bucketStart);
  }

  /**
   * Evict least recently used state
   */
  _evictLeastUsed() {
    let oldestKey = null;
    let oldestTime = Date.now();
    
    for (const [key, state] of this.states.entries()) {
      if (state.lastUpdate < oldestTime) {
        oldestTime = state.lastUpdate;
        oldestKey = key;
      }
    }
    
    if (oldestKey) {
      this.states.delete(oldestKey);
    }
  }

  /**
   * Cleanup idle states
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, state] of this.states.entries()) {
      if (now - state.lastUpdate > this.maxIdleTime) {
        this.states.delete(key);
        cleaned++;
      }
    }
    
    // Also evict nếu vẫn quá nhiều
    while (this.states.size > this.maxStates) {
      this._evictLeastUsed();
      cleaned++;
    }
    
    return cleaned;
  }

  /**
   * Start periodic cleanup
   */
  startCleanup(intervalMs = 5 * 60 * 1000) {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    this.cleanupInterval = setInterval(() => {
      const cleaned = this.cleanup();
      if (cleaned > 0) {
        // Log cleanup if significant
      }
    }, intervalMs);
  }

  /**
   * Stop cleanup
   */
  stopCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return {
      totalStates: this.states.size,
      maxStates: this.maxStates,
      states: Array.from(this.states.values()).map(s => s.getSummary())
    };
  }
}

// Export singleton instance
export const symbolStateManager = new SymbolStateManager();

