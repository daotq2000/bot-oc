import { strategyCache } from './StrategyCache.js';
import logger from '../utils/logger.js';
import ccxt from 'ccxt';
import { configService } from './ConfigService.js';

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
    this.maxOpenPriceCacheSize = 1000; // Reduced from 2000 to save memory

    // Cache fetched opens from REST to avoid repeated external calls
    // Key: exchange|symbol|interval|bucketStart -> open
    this.openFetchCache = new Map();
    this.maxOpenFetchCacheSize = 200; // Reduced from 500 to save memory

    // Prime tolerance: if we are already inside the bucket more than this, try REST OHLCV open
    this.openPrimeToleranceMs = Number(configService.getNumber('OC_OPEN_PRIME_TOLERANCE_MS', 3000));

    // Track last processed price per symbol to avoid duplicate processing
    // Key: exchange|symbol
    // Value: { price, timestamp }
    this.lastPriceCache = new Map();
    this.maxLastPriceCacheSize = 600; // Reduced from 1000 to save memory (534 Binance + MEXC symbols)
    
    // Minimum price change threshold to trigger recalculation (0.01% default)
    this.priceChangeThreshold = 0.0001; // 0.01%

    // Public CCXT clients cache for REST OHLCV (no API keys)
    this._publicClients = new Map();
    this.maxPublicClients = 10; // Maximum number of exchange clients to cache
    
    // Start periodic cache cleanup to prevent memory leaks
    this.startCacheCleanup();
  }

  /**
   * Start periodic cache cleanup
   */
  startCacheCleanup() {
    // Clean up old cache entries every 5 minutes
    setInterval(() => {
      this.cleanupOldCacheEntries();
    }, 5 * 60 * 1000); // 5 minutes
  }

  /**
   * Clean up old cache entries to prevent memory leaks
   */
  cleanupOldCacheEntries() {
    const now = Date.now();
    const maxAge = 15 * 60 * 1000; // 15 minutes
    
    let cleaned = 0;
    
    // Clean openPriceCache
    for (const [key, value] of this.openPriceCache.entries()) {
      if (now - value.lastUpdate > maxAge) {
        this.openPriceCache.delete(key);
        cleaned++;
      }
    }
    
    // Clean openFetchCache
    for (const [key, value] of this.openFetchCache.entries()) {
      if (now - value.timestamp > maxAge) {
        this.openFetchCache.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.debug(`[RealtimeOCDetector] Cleaned ${cleaned} old cache entries. Cache sizes: openPrice=${this.openPriceCache.size}, openFetch=${this.openFetchCache.size}`);
    }
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
   * Format symbol for public CCXT OHLCV
   */
  formatSymbolForExchange(exchange, symbol) {
    const ex = (exchange || '').toLowerCase();
    const raw = String(symbol || '').toUpperCase().replace(/[\/:_]/g, '');
    const base = raw.endsWith('USDT') ? raw.slice(0, -4) : raw;
    if (ex === 'mexc' || ex === 'gate') return `${base}/USDT:USDT`;
    if (ex === 'binance') return `${base}/USDT`;
    return `${base}/USDT`;
  }

  /**
   * Get or create public CCXT client for REST OHLCV
   */
  async getPublicClient(exchange) {
    const ex = (exchange || '').toLowerCase();
    if (this._publicClients.has(ex)) return this._publicClients.get(ex);
    // Enforce max clients cache size
    if (this._publicClients.size >= this.maxPublicClients) {
      const firstKey = Array.from(this._publicClients.keys())[0];
      this._publicClients.delete(firstKey);
    }
    let client;
    if (ex === 'mexc') {
      client = new ccxt.mexc({ enableRateLimit: true, options: { defaultType: 'swap' } });
      // Force .co domain
      try {
        if ('hostname' in client) client.hostname = 'mexc.co';
        const deepReplace = (obj) => {
          if (!obj) return obj;
          if (typeof obj === 'string') return obj.replace(/mexc\.com/g, 'mexc.co');
          if (Array.isArray(obj)) return obj.map(deepReplace);
          if (typeof obj === 'object') { for (const k of Object.keys(obj)) obj[k] = deepReplace(obj[k]); return obj; }
          return obj;
        };
        client.urls = deepReplace(client.urls || {});
      } catch (_) {}
      try { await client.loadMarkets(); } catch (_) {}
    } else if (ex === 'binance') {
      client = new ccxt.binance({ enableRateLimit: true, options: { defaultType: 'future' } });
      try { await client.loadMarkets(); } catch (_) {}
    } else if (ex === 'gate') {
      client = new ccxt.gateio({ enableRateLimit: true, options: { defaultType: 'swap' } });
      try { await client.loadMarkets(); } catch (_) {}
    } else {
      client = new ccxt.binance({ enableRateLimit: true, options: { defaultType: 'future' } });
      try { await client.loadMarkets(); } catch (_) {}
    }
    this._publicClients.set(ex, client);
    return client;
  }

  /**
   * Fetch interval open from REST OHLCV for current bucket (best-effort)
   */
  async fetchOpenFromRest(exchange, symbol, interval, bucketStart) {
    try {
      const ex = (exchange || '').toLowerCase();
      const client = await this.getPublicClient(ex);
      const marketSymbol = this.formatSymbolForExchange(ex, symbol);
      const timeframe = interval;

      // Try with since=bucketStart, limit=1
      let ohlcv = null;
      try {
        ohlcv = await client.fetchOHLCV(marketSymbol, timeframe, bucketStart, 1);
      } catch (e) {
        // fallback without since
        try {
          ohlcv = await client.fetchOHLCV(marketSymbol, timeframe, undefined, 2);
        } catch (e2) {
          logger.debug(`[RealtimeOCDetector] fetchOHLCV failed for ${ex} ${marketSymbol}: ${e2?.message || e2}`);
          return null;
        }
      }
      if (!Array.isArray(ohlcv) || ohlcv.length === 0) return null;

      // ccxt format: [timestamp, open, high, low, close, volume]
      let candle = null;
      if (ohlcv.length === 1) candle = ohlcv[0];
      else candle = ohlcv[ohlcv.length - 1];

      // If we requested since=bucketStart but got different, try to pick the one matching bucket
      if (ohlcv.length >= 2) {
        const match = ohlcv.find(c => c[0] === bucketStart);
        if (match) candle = match;
      }

      const open = Number(candle?.[1]);
      if (!Number.isFinite(open) || open <= 0) return null;
      return open;
    } catch (e) {
      logger.debug(`[RealtimeOCDetector] fetchOpenFromRest error: ${e?.message || e}`);
      return null;
    }
  }

  /**
   * Get accurate OPEN for interval bucket. If already inside the bucket more than tolerance,
   * attempt a synchronous REST OHLCV fetch to get the true candle open.
   */
  async getAccurateOpen(exchange, symbol, interval, currentPrice, timestamp = Date.now()) {
    const ex = (exchange || '').toLowerCase();
    const sym = String(symbol || '').toUpperCase().replace(/[\/:_]/g, '');
    const bucketStart = this.getBucketStart(interval, timestamp);
    const key = `${ex}|${sym}|${interval}|${bucketStart}`;

    // Cache hit
    const cached = this.openPriceCache.get(key);
    if (cached && cached.bucketStart === bucketStart && Number.isFinite(cached.open) && cached.open > 0) {
      return cached.open;
    }

    // Decide approach based on elapsed time inside bucket
    const elapsed = Math.max(0, timestamp - bucketStart);
    const useRestPrime = configService.getBoolean('OC_OPEN_PRIME_USE_REST', true);
    const allowRest = useRestPrime && elapsed >= this.openPrimeToleranceMs;

    let openPrice = currentPrice;

    if (allowRest) {
      // Try REST OHLCV open
      const fetched = await this.fetchOpenFromRest(ex, sym, interval, bucketStart);
      if (Number.isFinite(fetched) && fetched > 0) {
        openPrice = fetched;
        this.openFetchCache.set(key, fetched);
        logger.info(`[RealtimeOCDetector] Using REST open for ${sym} ${interval}: ${fetched}`);
      } else {
        logger.debug(`[RealtimeOCDetector] REST open not available, fallback to current price for ${sym} ${interval}`);
      }
    }

    // Enforce max cache size (LRU eviction)
    if (this.openPriceCache.size >= this.maxOpenPriceCacheSize && !this.openPriceCache.has(key)) {
      const oldest = Array.from(this.openPriceCache.entries())
        .sort((a, b) => a[1].lastUpdate - b[1].lastUpdate)[0];
      if (oldest) this.openPriceCache.delete(oldest[0]);
    }
    // Store in cache
    this.openPriceCache.set(key, { open: openPrice, bucketStart, lastUpdate: timestamp });
    return openPrice;
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

    // New bucket: decide how to prime OPEN
    let openPrice = currentPrice;
    const elapsed = Math.max(0, timestamp - bucketStart);
    const useRestPrime = configService.getBoolean('OC_OPEN_PRIME_USE_REST', true);
    const allowRest = useRestPrime && elapsed >= this.openPrimeToleranceMs;

    // Try REST OHLCV to get true open when we are already inside the bucket
    if (allowRest) {
      const fetchKey = key;
      const cachedFetched = this.openFetchCache.get(fetchKey);
      if (Number.isFinite(cachedFetched) && cachedFetched > 0) {
        openPrice = cachedFetched;
      } else {
        // Best-effort: synchronous fetch may add latency <100ms typically
        // We do not await here to stay synchronous; but for accuracy we can block briefly
        // Using a simple async IIFE with de-optimization could complicate flow; instead, we perform a blocking fetch via deasync-like would be heavy.
        // As a pragmatic approach: we will attempt a synchronous-like fetch by returning currentPrice now, but schedule an async fetch to prime cache for the next tick.
        // However, to maximize accuracy for immediate detection, we will do a small blocking await by converting this function to sync is not possible.
        // So, we use currentPrice now and schedule async fetch; next tick will use correct open.
        // Schedule async prime
        (async () => {
          try {
            const restOpen = await this.fetchOpenFromRest(normalizedExchange, normalizedSymbol, interval, bucketStart);
            if (Number.isFinite(restOpen) && restOpen > 0) {
              // Enforce max cache size
              if (this.openFetchCache.size >= this.maxOpenFetchCacheSize && !this.openFetchCache.has(fetchKey)) {
                const oldest = Array.from(this.openFetchCache.keys())[0];
                if (oldest) this.openFetchCache.delete(oldest);
              }
              this.openFetchCache.set(fetchKey, restOpen);
              // Also update openPriceCache with size limit
              if (this.openPriceCache.size >= this.maxOpenPriceCacheSize && !this.openPriceCache.has(fetchKey)) {
                const oldest = Array.from(this.openPriceCache.entries())
                  .sort((a, b) => a[1].lastUpdate - b[1].lastUpdate)[0];
                if (oldest) this.openPriceCache.delete(oldest[0]);
              }
              this.openPriceCache.set(fetchKey, { open: restOpen, bucketStart, lastUpdate: Date.now() });
              logger.info(`[RealtimeOCDetector] Primed REST open for ${normalizedSymbol} ${interval} at ${restOpen}`);
            }
          } catch (_) {}
        })();
      }
    }

    // Enforce max cache size (LRU eviction)
    if (this.openPriceCache.size >= this.maxOpenPriceCacheSize && !this.openPriceCache.has(key)) {
      const oldest = Array.from(this.openPriceCache.entries())
        .sort((a, b) => a[1].lastUpdate - b[1].lastUpdate)[0];
      if (oldest) this.openPriceCache.delete(oldest[0]);
    }
    this.openPriceCache.set(key, {
      open: openPrice,
      bucketStart,
      lastUpdate: timestamp
    });

    logger.debug(`[RealtimeOCDetector] New bucket ${interval} for ${normalizedSymbol}: open=${openPrice} (elapsed ${elapsed}ms${allowRest ? ', restPrime=on' : ''})`);

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
      // Enforce max cache size (LRU eviction)
      if (this.lastPriceCache.size >= this.maxLastPriceCacheSize && !this.lastPriceCache.has(key)) {
        const oldest = Array.from(this.lastPriceCache.entries())
          .sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
        if (oldest) this.lastPriceCache.delete(oldest[0]);
      }
      this.lastPriceCache.set(key, { price: currentPrice, timestamp: Date.now() });
      return true;
    }

    // Check if price changed significantly
    const priceChange = Math.abs((currentPrice - lastPrice.price) / lastPrice.price);
    if (priceChange >= this.priceChangeThreshold) {
      // Enforce max cache size (LRU eviction)
      if (this.lastPriceCache.size >= this.maxLastPriceCacheSize && !this.lastPriceCache.has(key)) {
        const oldest = Array.from(this.lastPriceCache.entries())
          .sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
        if (oldest) this.lastPriceCache.delete(oldest[0]);
      }
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

      // Log every detection call for debugging (first 10, then every 5000th to reduce logging)
      if (!this._detectCount) this._detectCount = 0;
      this._detectCount++;
      if (this._detectCount <= 10 || this._detectCount % 5000 === 0) {
        logger.debug(`[RealtimeOCDetector] detectOC called by ${caller} for ${normalizedExchange} ${normalizedSymbol} @ ${currentPrice} (count: ${this._detectCount})`);
      }

      // Check if price changed significantly
      if (!this.hasPriceChanged(normalizedExchange, normalizedSymbol, currentPrice)) {
        // Skip logging - too frequent
        return []; // Skip if price hasn't changed significantly
      }

      // Get strategies for this symbol
      const strategies = strategyCache.getStrategies(normalizedExchange, normalizedSymbol);
      
      // Log strategy lookup result (reduced logging)
      if (strategies.length === 0) {
        // Only log for specific symbols or first few times
        if (normalizedSymbol.includes('PIPPIN') && this._detectCount % 100 === 0) {
          logger.debug(`[RealtimeOCDetector] No strategies found for ${normalizedExchange} ${normalizedSymbol}`);
        }
        return []; // No strategies for this symbol
      }

      // Only log when checking strategies (reduced frequency)
      if (this._detectCount <= 10 || this._detectCount % 1000 === 0) {
        logger.debug(`[RealtimeOCDetector] Checking ${strategies.length} strategies for ${normalizedExchange} ${normalizedSymbol}`);
      }

      const matches = [];

      for (const strategy of strategies) {
        const interval = strategy.interval || '1m';
        const ocThreshold = Number(strategy.oc || 0);

        if (ocThreshold <= 0) {
          logger.debug(`[RealtimeOCDetector] Strategy ${strategy.id} has invalid OC threshold: ${ocThreshold}`);
          continue;
        }

        // Get open price for this interval bucket
        const openPrice = await this.getAccurateOpen(normalizedExchange, normalizedSymbol, interval, currentPrice, timestamp);

        // Calculate OC
        const oc = this.calculateOC(openPrice, currentPrice);
        const absOC = Math.abs(oc);
        const direction = this.getDirection(openPrice, currentPrice);

        // Log calculation details for debugging (reduced frequency)
        if ((normalizedSymbol.includes('PIPPIN') || absOC >= ocThreshold * 0.8) && this._detectCount % 100 === 0) {
          logger.debug(`[RealtimeOCDetector] Strategy ${strategy.id}: ${normalizedSymbol} ${interval} OC=${oc.toFixed(2)}% (threshold=${ocThreshold}%)`);
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
        }
        // Removed else logging - too frequent
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

    // Clean open price cache (by age and size)
    for (const [key, value] of this.openPriceCache.entries()) {
      if (now - value.lastUpdate > maxAge) {
        this.openPriceCache.delete(key);
        cleaned++;
      }
    }
    // Enforce max size (LRU eviction)
    if (this.openPriceCache.size > this.maxOpenPriceCacheSize) {
      const entries = Array.from(this.openPriceCache.entries())
        .sort((a, b) => a[1].lastUpdate - b[1].lastUpdate);
      const toRemove = entries.slice(0, this.openPriceCache.size - this.maxOpenPriceCacheSize);
      for (const [key] of toRemove) {
        this.openPriceCache.delete(key);
        cleaned++;
      }
    }

    // Clean open fetch cache (by age and size)
    for (const [key, timestamp] of this.openFetchCache.entries()) {
      // openFetchCache stores just values, need to track age differently
      // For now, just enforce size limit
    }
    if (this.openFetchCache.size > this.maxOpenFetchCacheSize) {
      const toRemove = Array.from(this.openFetchCache.keys())
        .slice(0, this.openFetchCache.size - this.maxOpenFetchCacheSize);
      for (const key of toRemove) {
        this.openFetchCache.delete(key);
        cleaned++;
      }
    }

    // Clean last price cache (by age and size)
    for (const [key, value] of this.lastPriceCache.entries()) {
      if (now - value.timestamp > maxAge) {
        this.lastPriceCache.delete(key);
        cleaned++;
      }
    }
    if (this.lastPriceCache.size > this.maxLastPriceCacheSize) {
      const entries = Array.from(this.lastPriceCache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = entries.slice(0, this.lastPriceCache.size - this.maxLastPriceCacheSize);
      for (const [key] of toRemove) {
        this.lastPriceCache.delete(key);
        cleaned++;
      }
    }

    // Clean public clients cache (size limit only)
    if (this._publicClients.size > this.maxPublicClients) {
      const keys = Array.from(this._publicClients.keys())
        .slice(0, this._publicClients.size - this.maxPublicClients);
      for (const key of keys) {
        this._publicClients.delete(key);
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

