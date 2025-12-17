import { strategyCache } from './StrategyCache.js';
import logger from '../utils/logger.js';

/**
 * RealtimeOCDetector
 * 
 * Tính toán OC realtime từ WebSocket price ticks.
 * Không sử dụng database candles.
 * 
 * Logic:
 * 1. Track open price cho mỗi interval bucket
 * 2. Tính OC từ current price và open price
 * 3. So khớp với strategies trong cache
 * 4. Trigger order ngay lập tức khi match
 */
export class RealtimeOCDetector {
  constructor() {
    // Track open prices per interval bucket
    // Key: exchange|symbol|interval|bucketStart
    // Value: { open, bucketStart, lastUpdate }
    this.openPriceCache = new Map();
    
    // Track last processed price per symbol to avoid duplicate processing
    // Key: exchange|symbol
    // Value: { price, timestamp }
    this.lastPriceCache = new Map();
    
    // Minimum price change threshold to trigger recalculation (0.01% default)
    this.priceChangeThreshold = 0.0001; // 0.01%
  }

  /**
   * Get interval bucket start time
   * @param {string} interval - Time interval (1m, 5m, 15m, etc.)
   * @param {number} timestamp - Current timestamp
   * @returns {number} Bucket start timestamp
   */
  getBucketStart(interval, timestamp = Date.now()) {
    const intervalMs = this.getIntervalMs(interval);
    return Math.floor(timestamp / intervalMs) * intervalMs;
  }

  /**
   * Convert interval string to milliseconds
   * @param {string} interval - Time interval
   * @returns {number} Milliseconds
   */
  getIntervalMs(interval) {
    const match = interval.match(/^(\d+)([mhd])$/);
    if (!match) return 60000; // Default to 1m

    const value = parseInt(match[1]);
    const unit = match[2];

    switch (unit) {
      case 'm': return value * 60000; // minutes
      case 'h': return value * 3600000; // hours
      case 'd': return value * 86400000; // days
      default: return 60000;
    }
  }

  /**
   * Get or initialize open price for interval bucket
   * @param {string} exchange - Exchange name
   * @param {string} symbol - Symbol
   * @param {string} interval - Time interval
   * @param {number} currentPrice - Current price
   * @param {number} timestamp - Current timestamp
   * @returns {number} Open price for this bucket
   */
  getOpenPrice(exchange, symbol, interval, currentPrice, timestamp = Date.now()) {
    const normalizedExchange = (exchange || '').toLowerCase();
    const normalizedSymbol = String(symbol || '').toUpperCase().replace(/[\/:_]/g, '');
    const bucketStart = this.getBucketStart(interval, timestamp);
    const key = `${normalizedExchange}|${normalizedSymbol}|${interval}|${bucketStart}`;

    // Check if we have open price for this bucket
    if (this.openPriceCache.has(key)) {
      const cached = this.openPriceCache.get(key);
      // If bucket hasn't changed, return cached open
      if (cached.bucketStart === bucketStart) {
        return cached.open;
      }
    }

    // New bucket: use current price as open
    const openPrice = currentPrice;
    this.openPriceCache.set(key, {
      open: openPrice,
      bucketStart,
      lastUpdate: timestamp
    });

    logger.debug(`[RealtimeOCDetector] New bucket ${interval} for ${normalizedSymbol}: open=${openPrice}`);

    return openPrice;
  }

  /**
   * Calculate OC percentage
   * @param {number} open - Open price
   * @param {number} close - Close/current price
   * @returns {number} OC percentage
   */
  calculateOC(open, close) {
    if (!open || open === 0) return 0;
    return ((close - open) / open) * 100;
  }

  /**
   * Get candle direction
   * @param {number} open - Open price
   * @param {number} close - Close/current price
   * @returns {string} 'bullish' or 'bearish'
   */
  getDirection(open, close) {
    return close >= open ? 'bullish' : 'bearish';
  }

  /**
   * Check if price has changed significantly
   * @param {string} exchange - Exchange name
   * @param {string} symbol - Symbol
   * @param {number} currentPrice - Current price
   * @returns {boolean} True if price changed significantly
   */
  hasPriceChanged(exchange, symbol, currentPrice) {
    const normalizedExchange = (exchange || '').toLowerCase();
    const normalizedSymbol = String(symbol || '').toUpperCase().replace(/[\/:_]/g, '');
    const key = `${normalizedExchange}|${normalizedSymbol}`;

    const lastPrice = this.lastPriceCache.get(key);
    if (!lastPrice) {
      this.lastPriceCache.set(key, { price: currentPrice, timestamp: Date.now() });
      return true;
    }

    // Check if price changed significantly
    const priceChange = Math.abs((currentPrice - lastPrice.price) / lastPrice.price);
    if (priceChange >= this.priceChangeThreshold) {
      this.lastPriceCache.set(key, { price: currentPrice, timestamp: Date.now() });
      return true;
    }

    return false;
  }

  /**
   * Detect OC and match with strategies
   * @param {string} exchange - Exchange name
   * @param {string} symbol - Symbol
   * @param {number} currentPrice - Current price from WebSocket
   * @param {number} timestamp - Event timestamp
   * @returns {Array<Object>} Array of matched strategies with OC data
   */
  async detectOC(exchange, symbol, currentPrice, timestamp = Date.now(), caller = 'unknown', options = {}) {
    try {
      const normalizedExchange = (exchange || '').toLowerCase();
      const normalizedSymbol = String(symbol || '').toUpperCase().replace(/[\/:_]/g, '');

      // Log every detection call for debugging (first 50, then every 1000th)
      if (!this._detectCount) this._detectCount = 0;
      this._detectCount++;
      if (this._detectCount <= 50 || this._detectCount % 1000 === 0) {
        logger.info(`[RealtimeOCDetector] detectOC called by ${caller} for ${normalizedExchange} ${normalizedSymbol} @ ${currentPrice} (count: ${this._detectCount})`);
      }

      // Check if price changed significantly
      if (!this.hasPriceChanged(normalizedExchange, normalizedSymbol, currentPrice)) {
        if (this._detectCount <= 50) {
          logger.debug(`[RealtimeOCDetector] Price not changed significantly for ${normalizedExchange} ${normalizedSymbol}`);
        }
        return []; // Skip if price hasn't changed significantly
      }

      // Get strategies for this symbol
      const strategies = strategyCache.getStrategies(normalizedExchange, normalizedSymbol);
      
      // Log strategy lookup result
      if (strategies.length === 0) {
        if (this._detectCount <= 50 || normalizedSymbol.includes('PIPPIN')) {
          logger.warn(`[RealtimeOCDetector] ⚠️ No strategies found for ${normalizedExchange} ${normalizedSymbol} (cache size: ${strategyCache.size()})`);
          // Log all cached symbols for debugging
          if (normalizedSymbol.includes('PIPPIN')) {
            const allSymbols = new Set();
            for (const [key] of strategyCache.cache.entries()) {
              const [, sym] = key.split('|');
              allSymbols.add(sym);
            }
            logger.warn(`[RealtimeOCDetector] Available symbols in cache: ${Array.from(allSymbols).slice(0, 20).join(', ')}${allSymbols.size > 20 ? '...' : ''}`);
          }
        }
        return []; // No strategies for this symbol
      }

      logger.info(`[RealtimeOCDetector] 🔍 Checking ${strategies.length} strategies for ${normalizedExchange} ${normalizedSymbol} @ ${currentPrice}`);

      const matches = [];

      for (const strategy of strategies) {
        const interval = strategy.interval || '1m';
        const ocThreshold = Number(strategy.oc || 0);

        if (ocThreshold <= 0) {
          logger.debug(`[RealtimeOCDetector] Strategy ${strategy.id} has invalid OC threshold: ${ocThreshold}`);
          continue;
        }

        // Get open price for this interval bucket
        const openPrice = this.getOpenPrice(normalizedExchange, normalizedSymbol, interval, currentPrice, timestamp);

        // Calculate OC
        const oc = this.calculateOC(openPrice, currentPrice);
        const absOC = Math.abs(oc);
        const direction = this.getDirection(openPrice, currentPrice);

        // Log calculation details for debugging
        if (normalizedSymbol.includes('PIPPIN') || absOC >= ocThreshold * 0.8) {
          logger.info(`[RealtimeOCDetector] Strategy ${strategy.id}: ${normalizedSymbol} ${interval} open=${openPrice} current=${currentPrice} OC=${oc.toFixed(2)}% (threshold=${ocThreshold}%) direction=${direction}`);
        }

        // Check if OC meets threshold
        if (absOC >= ocThreshold) {
          matches.push({
            strategy,
            oc,
            absOC,
            direction,
            openPrice,
            currentPrice,
            interval,
            timestamp
          });

          logger.info(`[RealtimeOCDetector] ✅ MATCH FOUND: ${normalizedSymbol} ${interval} OC=${oc.toFixed(2)}% (threshold=${ocThreshold}%) direction=${direction} strategy_id=${strategy.id} bot_id=${strategy.bot_id}`);
        } else {
          if (normalizedSymbol.includes('PIPPIN') || absOC >= ocThreshold * 0.8) {
            logger.debug(`[RealtimeOCDetector] Strategy ${strategy.id}: OC ${absOC.toFixed(2)}% < threshold ${ocThreshold}%`);
          }
        }
      }

      if (matches.length > 0) {
        logger.info(`[RealtimeOCDetector] 🎯 Returning ${matches.length} match(es) for ${normalizedExchange} ${normalizedSymbol}`);
      }

      return matches;
    } catch (error) {
      logger.error(`[RealtimeOCDetector] ❌ Error detecting OC for ${exchange} ${symbol}:`, error?.message || error, error?.stack);
      return [];
    }
  }

  /**
   * Clean up old cache entries (call periodically)
   * @param {number} maxAge - Maximum age in milliseconds (default: 1 hour)
   */
  cleanup(maxAge = 3600000) {
    const now = Date.now();
    let cleaned = 0;

    // Clean open price cache
    for (const [key, value] of this.openPriceCache.entries()) {
      if (now - value.lastUpdate > maxAge) {
        this.openPriceCache.delete(key);
        cleaned++;
      }
    }

    // Clean last price cache
    for (const [key, value] of this.lastPriceCache.entries()) {
      if (now - value.timestamp > maxAge) {
        this.lastPriceCache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(`[RealtimeOCDetector] Cleaned ${cleaned} old cache entries`);
    }
  }

  /**
   * Get cache stats
   * @returns {Object} Cache statistics
   */
  getStats() {
    return {
      openPriceCacheSize: this.openPriceCache.size,
      lastPriceCacheSize: this.lastPriceCache.size
    };
  }
}

// Export singleton instance
export const realtimeOCDetector = new RealtimeOCDetector();

