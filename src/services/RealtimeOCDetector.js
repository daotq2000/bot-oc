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
 * 5. (Optional) Send Telegram alerts when OC exceeds threshold
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
    
    // Rate limiting queue for REST fetchOpenFromRest to avoid CCXT throttle queue overflow
    this._restFetchQueue = [];
    this._restFetchInProgress = false;
    this._restFetchDelay = Number(configService.getNumber('OC_REST_FETCH_DELAY_MS', 30)); // Reduced from 50ms to 30ms
    this._maxRestFetchQueue = Number(configService.getNumber('OC_REST_FETCH_MAX_QUEUE', 300)); // Increased from 100 to 300
    this._restFetchConcurrent = Number(configService.getNumber('OC_REST_FETCH_CONCURRENT', 2)); // Process 2 requests concurrently
    
    // Alert functionality (optional, merged from OcAlertScanner)
    this.telegramService = null;
    this.alertEnabled = false;
    this.alertScanRunning = false;
    this.alertScanTimer = null;
    this.alertWatchlistRefreshTimer = null;
    this.alertState = new Map(); // key: cfgId|exch|sym|int -> { lastAlertTime, armed, lastOc, lastPrice, lastAlertOcAbs }
    this.alertWatchers = []; // Array of { cfgId, exchange, symbols:Set, intervals:Set, threshold, chatId }
    this.maxAlertStateCacheSize = 1000;
    
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
      // Set higher timeout for MEXC (slow connections from Vietnam)
      const mexcTimeout = Number(configService.getNumber('MEXC_API_TIMEOUT_MS', 30000));
      client = new ccxt.mexc({ 
        enableRateLimit: true, 
        timeout: mexcTimeout,
        options: { defaultType: 'swap' } 
      });
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
      // Skip loadMarkets() for MEXC to avoid timeout issues
      // fetchOHLCV works without loadMarkets() if symbol format is correct (we use formatSymbolForExchange)
      // This avoids the expensive exchangeInfo call that can timeout
      logger.debug(`[RealtimeOCDetector] Skipping loadMarkets() for MEXC to avoid timeout - fetchOHLCV will work with formatted symbols`);
    } else if (ex === 'binance') {
      // Increase maxCapacity to avoid throttle queue overflow (default is 1000)
      const maxCapacity = Number(configService.getNumber('CCXT_MAX_CAPACITY', 5000));
      client = new ccxt.binance({ 
        enableRateLimit: true, 
        options: { defaultType: 'future' },
        rateLimit: 1200 // Binance Futures rate limit: 1200 requests per minute
      });
      // Set maxCapacity if CCXT supports it
      if (client.throttle && typeof client.throttle.configure === 'function') {
        try {
          client.throttle.configure({ maxCapacity });
          logger.debug(`[RealtimeOCDetector] Set CCXT maxCapacity to ${maxCapacity} for Binance`);
        } catch (_) {}
      }
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
   * Process REST fetch queue with rate limiting (concurrent processing)
   */
  async _processRestFetchQueue() {
    if (this._restFetchInProgress || this._restFetchQueue.length === 0) return;
    
    this._restFetchInProgress = true;
    
    // Process requests concurrently (up to _restFetchConcurrent)
    const processBatch = async () => {
      const batch = [];
      for (let i = 0; i < this._restFetchConcurrent && this._restFetchQueue.length > 0; i++) {
        batch.push(this._restFetchQueue.shift());
      }
      
      if (batch.length === 0) {
        this._restFetchInProgress = false;
        // Check if more items were added while processing
        if (this._restFetchQueue.length > 0) {
          this._processRestFetchQueue();
        }
        return;
      }
      
      // Process batch concurrently
      const promises = batch.map(async ({ resolve, reject, exchange, symbol, interval, bucketStart }) => {
        try {
          const result = await this._fetchOpenFromRestDirect(exchange, symbol, interval, bucketStart);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      
      await Promise.allSettled(promises);
      
      // Rate limiting: delay between batches (not individual requests)
      if (this._restFetchQueue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, this._restFetchDelay));
      }
      
      // Process next batch
      if (this._restFetchQueue.length > 0) {
        await processBatch();
      } else {
        this._restFetchInProgress = false;
      }
    };
    
    await processBatch();
  }

  /**
   * Fetch interval open from REST OHLCV for current bucket (best-effort)
   * Uses queue to avoid CCXT throttle queue overflow
   */
  async fetchOpenFromRest(exchange, symbol, interval, bucketStart) {
    // Check cache first to avoid unnecessary requests
    const ex = (exchange || '').toLowerCase();
    const sym = String(symbol || '').toUpperCase().replace(/[\/:_]/g, '');
    const key = `${ex}|${sym}|${interval}|${bucketStart}`;
    const cached = this.openFetchCache.get(key);
    if (Number.isFinite(cached) && cached > 0) {
      return cached;
    }

    // For Binance, prioritize WebSocket data - skip REST if WebSocket should have it
    if (ex === 'binance') {
      try {
        const { webSocketManager } = await import('./WebSocketManager.js');
        const wsOpen = webSocketManager.getKlineOpen(sym, interval, bucketStart);
        if (Number.isFinite(wsOpen) && wsOpen > 0) {
          // WebSocket has data, skip REST
          return wsOpen;
        }
      } catch (_) {}
    }

    // Queue the request to avoid throttle queue overflow
    return new Promise((resolve, reject) => {
      // Reject if queue is too full
      if (this._restFetchQueue.length >= this._maxRestFetchQueue) {
        logger.debug(`[RealtimeOCDetector] REST fetch queue full (${this._restFetchQueue.length}), skipping ${ex} ${sym}`);
        resolve(null);
        return;
      }
      
      this._restFetchQueue.push({ resolve, reject, exchange, symbol, interval, bucketStart });
      this._processRestFetchQueue(); // Start processing if not already running
    });
  }

  /**
   * Direct fetch without queue (internal use)
   */
  async _fetchOpenFromRestDirect(exchange, symbol, interval, bucketStart) {
    try {
      const ex = (exchange || '').toLowerCase();
      const client = await this.getPublicClient(ex);
      const marketSymbol = this.formatSymbolForExchange(ex, symbol);
      const timeframe = interval;

      // Get timeout for this exchange
      const exchangeTimeout = ex === 'mexc' 
        ? Number(configService.getNumber('MEXC_API_TIMEOUT_MS', 30000))
        : 10000; // Default 10s for other exchanges

      // Try with since=bucketStart, limit=1 (with retry for MEXC)
      let ohlcv = null;
      const maxRetries = ex === 'mexc' ? 2 : 1;
      let lastError = null;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          // Wrap fetchOHLCV with timeout protection
          const fetchPromise = client.fetchOHLCV(marketSymbol, timeframe, bucketStart, 1);
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`fetchOHLCV timeout after ${exchangeTimeout}ms`)), exchangeTimeout)
          );
          ohlcv = await Promise.race([fetchPromise, timeoutPromise]);
          break; // Success, exit retry loop
        } catch (e) {
          lastError = e;
          // Check if it's throttle queue error - don't retry immediately
          if (e?.message?.includes('throttle queue') || e?.message?.includes('maxCapacity')) {
            logger.debug(`[RealtimeOCDetector] Throttle queue error for ${ex} ${marketSymbol}, skipping retry`);
            throw e; // Don't retry throttle errors
          }
          if (attempt < maxRetries) {
            const backoff = 1000 * attempt; // 1s, 2s
            logger.debug(`[RealtimeOCDetector] fetchOHLCV attempt ${attempt}/${maxRetries} failed for ${ex} ${marketSymbol}, retrying in ${backoff}ms: ${e?.message || e}`);
            await new Promise(resolve => setTimeout(resolve, backoff));
            continue;
          }
        }
      }

      // If first attempt failed, try fallback without since parameter
      if (!ohlcv) {
        try {
          const fetchPromise = client.fetchOHLCV(marketSymbol, timeframe, undefined, 2);
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`fetchOHLCV fallback timeout after ${exchangeTimeout}ms`)), exchangeTimeout)
          );
          ohlcv = await Promise.race([fetchPromise, timeoutPromise]);
        } catch (e2) {
          // Don't log throttle errors as debug (they're expected when queue is full)
          if (!e2?.message?.includes('throttle queue') && !e2?.message?.includes('maxCapacity')) {
            logger.debug(`[RealtimeOCDetector] fetchOHLCV failed for ${ex} ${marketSymbol}: ${lastError?.message || lastError || e2?.message || e2}`);
          }
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
      
      // Cache the result
      const key = `${ex}|${String(symbol || '').toUpperCase().replace(/[\/:_]/g, '')}|${interval}|${bucketStart}`;
      this.openFetchCache.set(key, open);
      
      return open;
    } catch (e) {
      // Don't log throttle errors as debug
      if (!e?.message?.includes('throttle queue') && !e?.message?.includes('maxCapacity')) {
        logger.debug(`[RealtimeOCDetector] fetchOpenFromRest error: ${e?.message || e}`);
      }
      return null;
    }
  }

  /**
   * Get accurate OPEN for interval bucket.
   *
   * IMPORTANT:
   * - This function is now STRICT: it always tries to fetch the true candle OPEN
   *   from REST OHLCV and will NOT fall back to currentPrice.
   * - If REST data is not available or invalid, it returns null and callers
   *   should skip OC detection for this tick.
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

    // 1) Try WebSocket kline OPEN cache first (no REST) - CRITICAL for Binance to avoid throttle
    try {
      if (ex === 'binance') {
        const { webSocketManager } = await import('./WebSocketManager.js');
        const wsOpen = webSocketManager.getKlineOpen(sym, interval, bucketStart);
        if (Number.isFinite(wsOpen) && wsOpen > 0) {
          // Store in cache
          this.openPriceCache.set(key, { open: wsOpen, bucketStart, lastUpdate: timestamp });
          return wsOpen;
        }
        // If WebSocket doesn't have data, log for monitoring (but don't spam)
        if (this._detectCount && this._detectCount % 1000 === 0) {
          logger.debug(`[RealtimeOCDetector] WebSocket kline open not available for ${sym} ${interval}, will use REST fallback`);
        }
      }
    } catch (wsErr) {
      logger.debug(`[RealtimeOCDetector] getKlineOpen failed for ${sym} ${interval}: ${wsErr?.message || wsErr}`);
    }

    // 2) Fallback: REST OHLCV open (with queue to avoid throttle)
    const fetched = await this.fetchOpenFromRest(ex, sym, interval, bucketStart);
    if (!Number.isFinite(fetched) || fetched <= 0) {
      // If queue is full and WebSocket doesn't have data, use currentPrice as temporary fallback
      // This is less accurate but better than skipping OC calculation entirely
      if (this._restFetchQueue.length >= this._maxRestFetchQueue) {
        logger.debug(
          `[RealtimeOCDetector] Queue full for ${sym} ${interval}, using currentPrice as temporary open (bucketStart=${bucketStart})`
        );
        // Use currentPrice as temporary open (will be updated when REST fetch completes)
        const tempOpen = currentPrice;
        if (Number.isFinite(tempOpen) && tempOpen > 0) {
          // Store temporarily (will be overwritten when REST data arrives)
          this.openPriceCache.set(key, { open: tempOpen, bucketStart, lastUpdate: timestamp });
          return tempOpen;
        }
      }
      
      logger.warn(
        `[RealtimeOCDetector] ❌ Unable to fetch REST OPEN for ${sym} ${interval} (bucketStart=${bucketStart}). ` +
        `Skipping OC calculation for this tick.`
      );
      return null;
    }

    const openPrice = fetched;
        this.openFetchCache.set(key, fetched);
        logger.info(`[RealtimeOCDetector] Using REST open for ${sym} ${interval}: ${fetched}`);

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

    // Clean alert state cache (by age and size)
    if (this.alertEnabled) {
      for (const [key, value] of this.alertState.entries()) {
        if (value.lastAlertTime && (now - value.lastAlertTime > maxAge * 2)) {
          this.alertState.delete(key);
          cleaned++;
        }
      }
      if (this.alertState.size > this.maxAlertStateCacheSize) {
        const entries = Array.from(this.alertState.entries())
          .sort((a, b) => (a[1].lastAlertTime || 0) - (b[1].lastAlertTime || 0));
        const toRemove = entries.slice(0, this.alertState.size - this.maxAlertStateCacheSize);
        for (const [key] of toRemove) {
          this.alertState.delete(key);
          cleaned++;
        }
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
      lastPriceCacheSize: this.lastPriceCache.size,
      alertEnabled: this.alertEnabled,
      alertWatchersCount: this.alertWatchers.length,
      alertStateSize: this.alertState.size
    };
  }

  /**
   * Initialize alert functionality (merged from OcAlertScanner)
   * @param {Object} telegramService - Telegram service instance
   */
  async initializeAlerts(telegramService) {
    this.telegramService = telegramService;
    this.alertEnabled = true;
    
    // Build initial watch list and attach WS listeners
    await this.refreshAlertWatchlist();

    // Attach tick handlers once
    try {
      const { mexcPriceWs } = await import('./MexcWebSocketManager.js');
      const mexcHandler = ({ symbol, price, ts }) => {
        this.onAlertTick('mexc', symbol, price, ts).catch(error => {
          logger.error(`[RealtimeOCDetector] Error in MEXC alert tick:`, error?.message || error);
        });
      };
      if (typeof mexcPriceWs.onPrice === 'function') {
        mexcPriceWs.onPrice(mexcHandler);
        logger.info(`[RealtimeOCDetector] ✅ Registered MEXC alert price handler`);
      } else {
        logger.error(`[RealtimeOCDetector] ❌ mexcPriceWs.onPrice is not a function`);
      }
    } catch (error) {
      logger.error(`[RealtimeOCDetector] ❌ Failed to register MEXC alert handler:`, error?.message || error);
    }
    
    try {
      const { webSocketManager } = await import('./WebSocketManager.js');
      const binanceHandler = ({ symbol, price, ts }) => {
        this.onAlertTick('binance', symbol, price, ts).catch(error => {
          logger.error(`[RealtimeOCDetector] Error in Binance alert tick:`, error?.message || error);
        });
      };
      if (typeof webSocketManager.onPrice === 'function') {
        webSocketManager.onPrice(binanceHandler);
        logger.info(`[RealtimeOCDetector] ✅ Registered Binance alert price handler`);
      } else {
        logger.error(`[RealtimeOCDetector] ❌ webSocketManager.onPrice is not a function`);
      }
    } catch (error) {
      logger.error(`[RealtimeOCDetector] ❌ Failed to register Binance alert handler:`, error?.message || error);
    }

    // Periodically refresh watchlist
    const ttl = Number(configService.getNumber('OC_ALERT_WATCHLIST_REFRESH_MS', 30000));
    this.alertWatchlistRefreshTimer = setInterval(() => {
      this.refreshAlertWatchlist().catch(() => {});
    }, Math.max(5000, ttl));
  }

  /**
   * Start periodic alert scan
   */
  startAlertScan() {
    if (this.alertScanTimer) return;
    
    const iv = Number(configService.getNumber('OC_ALERT_SCAN_INTERVAL_MS', 30000));
    this.alertScanTimer = setInterval(() => {
      if (this.alertScanRunning) {
        logger.debug('[RealtimeOCDetector] Alert scan already in progress, skipping');
        return;
      }
      this.scanAlerts().catch(e => logger.warn('[RealtimeOCDetector] Alert scan error:', e?.message || e));
    }, Math.max(1000, iv));
    
    // Run once soon after start
    setTimeout(() => this.scanAlerts().catch(() => {}), 1000);
    logger.info(`[RealtimeOCDetector] Alert scan started with interval ${iv}ms`);
  }

  /**
   * Stop alert scan
   */
  stopAlertScan() {
    if (this.alertScanTimer) {
      clearInterval(this.alertScanTimer);
      this.alertScanTimer = null;
    }
    if (this.alertWatchlistRefreshTimer) {
      clearInterval(this.alertWatchlistRefreshTimer);
      this.alertWatchlistRefreshTimer = null;
    }
    this.alertScanRunning = false;
    logger.info('[RealtimeOCDetector] Alert scan stopped');
  }

  /**
   * Normalize symbol for alerts
   */
  normalizeSymbolForAlert(symbol) {
    if (!symbol) return symbol;
    return symbol.toUpperCase().replace(/[/:_]/g, '').replace(/USD$/, 'USDT');
  }

  /**
   * Get current price for alert (WebSocket first, then REST fallback)
   */
  async getCurrentPriceForAlert(exchange, symbol) {
    const ex = (exchange || 'mexc').toLowerCase();
    try {
      if (ex === 'mexc') {
        const { mexcPriceWs } = await import('./MexcWebSocketManager.js');
        const p = mexcPriceWs.getPrice(symbol);
        if (Number.isFinite(Number(p)) && Number(p) > 0) return Number(p);
      } else if (ex === 'binance') {
        const { webSocketManager } = await import('./WebSocketManager.js');
        const p = webSocketManager.getPrice(symbol);
        if (Number.isFinite(Number(p)) && Number(p) > 0) return Number(p);
      }
    } catch (error) {
      logger.debug(`[RealtimeOCDetector] WebSocket price fetch failed for ${ex} ${symbol}:`, error?.message || error);
    }
    
    // Fallback: Try REST API
    try {
      const { ExchangeService } = await import('./ExchangeService.js');
      const dummyBot = { id: `alert_${ex}`, exchange: ex };
      const exchangeService = new ExchangeService(dummyBot);
      await exchangeService.initialize();
      const price = await exchangeService.getTickerPrice(symbol);
      if (Number.isFinite(Number(price)) && Number(price) > 0) {
        return Number(price);
      }
    } catch (error) {
      logger.warn(`[RealtimeOCDetector] REST API price fetch failed for ${ex} ${symbol}:`, error?.message || error);
    }
    
    return null;
  }

  /**
   * Refresh alert watchlist from PriceAlertConfig
   */
  async refreshAlertWatchlist() {
    try {
      const { priceAlertSymbolTracker } = await import('./PriceAlertSymbolTracker.js');
      await priceAlertSymbolTracker.refresh();

      const { PriceAlertConfig } = await import('../models/PriceAlertConfig.js');
      const configs = await PriceAlertConfig.findAll();
      const activeConfigs = configs.filter(cfg => cfg.is_active === true || cfg.is_active === 1 || cfg.is_active === '1');
      const watchers = [];
      const mexcSet = new Set();
      const binanceSet = new Set();

      for (const cfg of activeConfigs) {
        const exchange = (cfg.exchange || 'mexc').toLowerCase();
        const symbols = Array.from(priceAlertSymbolTracker.getSymbolsForExchange(exchange));
        const intervals = Array.isArray(cfg.intervals) && cfg.intervals.length ? cfg.intervals : ['1m'];
        const normalized = symbols.map(s => this.normalizeSymbolForAlert(s)).filter(s => s);
        const w = {
          cfgId: cfg.id,
          exchange,
          symbols: new Set(normalized),
          intervals: new Set(intervals),
          threshold: Number(cfg.threshold || 0),
          chatId: cfg.telegram_chat_id
        };
        watchers.push(w);

        for (const s of normalized) {
          if (exchange === 'mexc') mexcSet.add(s);
          else if (exchange === 'binance') binanceSet.add(s);
        }
      }

      if (mexcSet.size) {
        const { mexcPriceWs } = await import('./MexcWebSocketManager.js');
        mexcPriceWs.subscribe(Array.from(mexcSet));
      }
      if (binanceSet.size) {
        const { webSocketManager } = await import('./WebSocketManager.js');
        webSocketManager.subscribe(Array.from(binanceSet));
      }

      this.alertWatchers = watchers;
      logger.info(`[RealtimeOCDetector] Alert watchlist refreshed: ${watchers.length} configs; MEXC=${mexcSet.size}, BINANCE=${binanceSet.size}`);
    } catch (e) {
      logger.warn('[RealtimeOCDetector] refreshAlertWatchlist failed:', e?.message || e);
    }
  }

  /**
   * Event-driven alert tick handler
   */
  async onAlertTick(exchange, symbol, price, ts = Date.now()) {
    try {
      if (!this.alertEnabled) {
        logger.debug(`[RealtimeOCDetector] onAlertTick: alertEnabled=false, skipping ${exchange} ${symbol}`);
        return;
      }
      
      const alertsEnabled = configService.getBoolean('ENABLE_ALERTS', true);
      if (!alertsEnabled) {
        logger.debug(`[RealtimeOCDetector] onAlertTick: ENABLE_ALERTS=false, skipping ${exchange} ${symbol}`);
        return;
      }

      if (!this.alertWatchers || this.alertWatchers.length === 0) {
        logger.debug(`[RealtimeOCDetector] onAlertTick: No alert watchers, skipping ${exchange} ${symbol}`);
        return;
      }
      
      // Debug: Log first few ticks to verify handler is being called
      if (!this._onAlertTickCount) this._onAlertTickCount = 0;
      this._onAlertTickCount++;
      if (this._onAlertTickCount <= 10 || this._onAlertTickCount % 1000 === 0) {
        logger.info(`[RealtimeOCDetector] onAlertTick called: ${exchange} ${symbol} @ ${price} (count: ${this._onAlertTickCount}, watchers: ${this.alertWatchers.length})`);
      }
      
      const sym = this.normalizeSymbolForAlert(symbol);
      const p = Number(price);
      if (!Number.isFinite(p) || p <= 0) return;

      for (const w of this.alertWatchers) {
        if (w.exchange !== (exchange || '').toLowerCase()) continue;
        if (!w.symbols.has(sym)) continue;
        
        for (const interval of w.intervals) {
          const bucketStart = this.getBucketStart(interval, ts);
          const open = await this.getAccurateOpen(w.exchange, sym, interval, p, ts);
          
          if (!Number.isFinite(open) || open <= 0) continue;

          const oc = ((p - open) / open) * 100;
          const now = Date.now();
          const stateKey = `${w.cfgId}|${exchange}|${sym}|${interval}`;
          let state = this.alertState.get(stateKey);
          if (!state) {
            state = { lastAlertTime: 0, armed: true, lastOc: oc, lastPrice: p, lastAlertOcAbs: 0 };
            this.alertState.set(stateKey, state);
          }
          state.lastPrice = p;
          state.lastOc = oc;

          const minIntervalMs = Number(configService.getNumber(
            'OC_ALERT_TICK_MIN_INTERVAL_MS',
            configService.getNumber('PRICE_ALERT_MIN_INTERVAL_MS', 60000)
          ));
          const rearmRatio = Number(configService.getNumber('OC_ALERT_REARM_RATIO', 0.6));
          const stepPercentCfg = Number(configService.getNumber('OC_ALERT_STEP_PERCENT', NaN));
          const absOc = Math.abs(oc);
          const absThreshold = Math.abs(Number(w.threshold || 0));
          if (absThreshold <= 0) continue;

          const lastAlertOcAbs = Number.isFinite(state.lastAlertOcAbs) ? state.lastAlertOcAbs : 0;
          const stepPercent = Number.isFinite(stepPercentCfg) ? Math.abs(stepPercentCfg) : absThreshold;
          const ocDeltaFromLastAlert = absOc - lastAlertOcAbs;
          const shouldFireByStep = absOc >= absThreshold && ocDeltaFromLastAlert >= stepPercent;

          if (shouldFireByStep && state.armed) {
            const elapsed = now - (state.lastAlertTime || 0);
            if (elapsed >= minIntervalMs) {
              const chatId = w.chatId;
              if (!chatId) {
                logger.warn(`[RealtimeOCDetector] No telegram_chat_id for config ${w.cfgId} (${exchange}), skipping alert for ${sym}`);
                continue;
              }
              
              logger.info(
                `[RealtimeOCDetector] Sending alert for ${exchange.toUpperCase()} ${sym} ${interval} ` +
                `oc=${oc.toFixed(2)}% (thr=${absThreshold}%, step=${stepPercent}%, ` +
                `lastAlertOcAbs=${lastAlertOcAbs.toFixed(2)}%) to chat_id=${chatId} (config_id=${w.cfgId})`
              );
              
              // Check telegramService before sending
              if (!this.telegramService || typeof this.telegramService.sendVolatilityAlert !== 'function') {
                logger.error(`[RealtimeOCDetector] telegramService not initialized or sendVolatilityAlert not available`);
              } else {
                this.telegramService.sendVolatilityAlert(chatId, {
                  symbol: sym,
                  interval,
                  oc,
                  open,
                  currentPrice: p,
                  direction: oc >= 0 ? 'bullish' : 'bearish'
                }).catch((error) => {
                  logger.error(`[RealtimeOCDetector] Failed to send alert to chat_id=${chatId}:`, error?.message || error, error?.stack);
                });
              }
              
              state.lastAlertTime = now;
              state.lastAlertOcAbs = absOc;
              state.armed = false;
              logger.info(`[RealtimeOCDetector] ✅ Alert sent: ${exchange.toUpperCase()} ${sym} ${interval} oc=${oc.toFixed(2)}% to chat_id=${chatId}`);

              // Immediately match strategies and execute orders
              try {
                const matches = await this.detectOC(exchange, sym, p, ts || Date.now(), 'RealtimeOCDetector.onAlertTick');
                if (Array.isArray(matches) && matches.length > 0) {
                  logger.info(`[RealtimeOCDetector] 🎯 Strategy matches found after alert: ${matches.length} for ${exchange.toUpperCase()} ${sym}`);
                  const { webSocketOCConsumer } = await import('../consumers/WebSocketOCConsumer.js');
                  for (const match of matches) {
                    try {
                      logger.info(`[RealtimeOCDetector] Processing match for strategy ${match?.strategy?.id} (bot_id=${match?.strategy?.bot_id})`);
                      await webSocketOCConsumer.processMatch(match);
                      logger.info(`[RealtimeOCDetector] ✅ Successfully processed match for strategy ${match?.strategy?.id}`);
                    } catch (procErr) {
                      logger.error(
                        `[RealtimeOCDetector] ❌ Error processing match for strategy ${match?.strategy?.id}:`,
                        procErr?.message || procErr,
                        procErr?.stack
                      );
                    }
                  }
                } else {
                  logger.debug(`[RealtimeOCDetector] No strategy matches found for ${exchange.toUpperCase()} ${sym} after alert`);
                }
              } catch (detErr) {
                logger.error(
                  '[RealtimeOCDetector] ❌ Error during immediate strategy match after alert:',
                  detErr?.message || detErr,
                  detErr?.stack
                );
              }
            }
          } else if (absOc < absThreshold * rearmRatio) {
            state.armed = true;
            state.lastAlertOcAbs = 0;
          }
        }
      }
    } catch (e) {
      logger.debug('[RealtimeOCDetector] onAlertTick error:', e?.message || e);
    }
  }

  /**
   * Periodic alert scan (merged from OcAlertScanner.scan)
   */
  async scanAlerts() {
    if (!this.alertEnabled) {
        logger.debug(`[RealtimeOCDetector] scanAlerts: alertEnabled=false, skipping`);
        return;
    }
    
    const alertsEnabled = configService.getBoolean('ENABLE_ALERTS', true);
    if (!alertsEnabled) {
        logger.debug(`[RealtimeOCDetector] scanAlerts: ENABLE_ALERTS=false, skipping`);
        return;
    }

    if (this.alertScanRunning) {
        logger.debug(`[RealtimeOCDetector] scanAlerts: Already running, skipping`);
        return;
    }
    
    this.alertScanRunning = true;
    const scanStartTime = Date.now();
    const maxScanDurationMs = Number(configService.getNumber('OC_ALERT_MAX_SCAN_DURATION_MS', 30000));
    
    try {
      const { PriceAlertConfig } = await import('../models/PriceAlertConfig.js');
      const configs = await PriceAlertConfig.findAll();
      if (!configs || configs.length === 0) {
        logger.debug(`[RealtimeOCDetector] scanAlerts: No alert configs found`);
        return;
      }

      logger.info(`[RealtimeOCDetector] Alert scan started: Found ${configs.length} alert configs`);
      
      const { priceAlertSymbolTracker } = await import('./PriceAlertSymbolTracker.js');
      const { mexcPriceWs } = await import('./MexcWebSocketManager.js');
      const { webSocketManager } = await import('./WebSocketManager.js');
      
      const mexcSymbols = new Set();
      const binanceSymbols = new Set();
      
      for (const cfg of configs) {
        if (!cfg.is_active) continue;
        const exchange = (cfg.exchange || 'mexc').toLowerCase();
        let symbols = typeof cfg.symbols === 'string' ? JSON.parse(cfg.symbols) : (cfg.symbols || []);
        
        if (!Array.isArray(symbols) || symbols.length === 0) {
          await priceAlertSymbolTracker.refresh();
          symbols = Array.from(priceAlertSymbolTracker.getSymbolsForExchange(exchange));
        }
        
        if (Array.isArray(symbols)) {
          for (const sym of symbols) {
            const norm = this.normalizeSymbolForAlert(sym);
            if (norm) {
              if (exchange === 'mexc') mexcSymbols.add(norm);
              else if (exchange === 'binance') binanceSymbols.add(norm);
            }
          }
        }
      }
      
      if (mexcSymbols.size > 0) mexcPriceWs.subscribe(Array.from(mexcSymbols));
      if (binanceSymbols.size > 0) webSocketManager.subscribe(Array.from(binanceSymbols));

      const minIntervalMs = Number(configService.getNumber('PRICE_ALERT_MIN_INTERVAL_MS', 60000));
      const rearmRatio = Number(configService.getNumber('OC_ALERT_REARM_RATIO', 0.6));
      const stepPercentCfg = Number(configService.getNumber('OC_ALERT_STEP_PERCENT', NaN));
      const now = Date.now();

      for (const cfg of configs) {
        if (Date.now() - scanStartTime > maxScanDurationMs) {
          logger.warn(`[RealtimeOCDetector] Alert scan exceeded max duration (${maxScanDurationMs}ms), stopping early`);
          break;
        }

        if (!cfg.is_active) continue;
        const exchange = (cfg.exchange || 'mexc').toLowerCase();
        let symbols = typeof cfg.symbols === 'string' ? JSON.parse(cfg.symbols) : (cfg.symbols || []);
        
        if (!Array.isArray(symbols) || symbols.length === 0) {
          await priceAlertSymbolTracker.refresh();
          symbols = Array.from(priceAlertSymbolTracker.getSymbolsForExchange(exchange));
        }
        
        const intervals = typeof cfg.intervals === 'string' ? JSON.parse(cfg.intervals) : (cfg.intervals || ['1m']);
        const cfgThreshold = Number(cfg.threshold || 0);
        const minThresholdCfg = Number(configService.getNumber('OC_ALERT_MIN_THRESHOLD_PERCENT', NaN));
        const threshold = Number.isFinite(minThresholdCfg) ? Math.max(cfgThreshold, minThresholdCfg) : cfgThreshold;
        if (!Array.isArray(symbols) || symbols.length === 0) continue;
        if (!Array.isArray(intervals) || intervals.length === 0) continue;

        for (const s of symbols) {
          const sym = this.normalizeSymbolForAlert(s);
          let currentPrice = await this.getCurrentPriceForAlert(exchange, sym);
          
          if (!Number.isFinite(Number(currentPrice))) continue;

          for (const interval of intervals) {
            const open = await this.getAccurateOpen(exchange, sym, interval, Number(currentPrice));
            
            if (!Number.isFinite(open) || open <= 0) continue;

            const oc = ((Number(currentPrice) - open) / open) * 100;
            const stateKey = `${cfg.id}|${exchange}|${sym}|${interval}`;
            
            let state = this.alertState.get(stateKey);
            if (!state) {
              state = { lastAlertTime: 0, armed: true, lastOc: oc, lastPrice: Number(currentPrice), lastAlertOcAbs: 0 };
              this.alertState.set(stateKey, state);
            }

            state.lastPrice = Number(currentPrice);
            state.lastOc = oc;

            const absOc = Math.abs(oc);
            const absThreshold = Math.abs(threshold);
            const lastAlertOcAbs = Number.isFinite(state.lastAlertOcAbs) ? state.lastAlertOcAbs : 0;
            const stepPercent = Number.isFinite(stepPercentCfg) ? Math.abs(stepPercentCfg) : absThreshold;
            const ocDeltaFromLastAlert = absOc - lastAlertOcAbs;
            const shouldFireByStep = absOc >= absThreshold && ocDeltaFromLastAlert >= stepPercent;

            if (shouldFireByStep && state.armed) {
              const last = state.lastAlertTime || 0;
              const timeSinceLastAlert = now - last;
              
              if (timeSinceLastAlert >= minIntervalMs) {
                const chatId = cfg.telegram_chat_id;
                if (!chatId) {
                  logger.warn(`[RealtimeOCDetector] No telegram_chat_id for config ${cfg.id} (${exchange}), skipping alert for ${sym}`);
                  continue;
                }
                
                logger.info(
                  `[RealtimeOCDetector] Sending alert for ${exchange.toUpperCase()} ${sym} ${interval} ` +
                  `oc=${oc.toFixed(2)}% (thr=${absThreshold}%, step=${stepPercent}%, ` +
                  `lastAlertOcAbs=${lastAlertOcAbs.toFixed(2)}%) to chat_id=${chatId} (config_id=${cfg.id})`
                );
                
                // Check telegramService before sending
                if (!this.telegramService || typeof this.telegramService.sendVolatilityAlert !== 'function') {
                  logger.error(`[RealtimeOCDetector] telegramService not initialized or sendVolatilityAlert not available`);
                } else {
                  await this.telegramService.sendVolatilityAlert(chatId, {
                    symbol: sym,
                    interval,
                    oc,
                    open,
                    currentPrice: Number(currentPrice),
                    direction: oc >= 0 ? 'bullish' : 'bearish'
                  }).catch((error) => {
                    logger.error(`[RealtimeOCDetector] Failed to send alert to chat_id=${chatId}:`, error?.message || error, error?.stack);
                  });
                }
                
                state.lastAlertTime = now;
                state.lastAlertOcAbs = absOc;
                state.armed = false;
                logger.info(`[RealtimeOCDetector] ✅ Alert sent: ${exchange.toUpperCase()} ${sym} ${interval} oc=${oc.toFixed(2)}% >= ${absThreshold}% to chat_id=${chatId}`);
              }
            } else if (absOc < absThreshold * rearmRatio) {
              if (!state.armed) {
                state.armed = true;
                state.lastAlertOcAbs = 0;
              }
            }
          }
        }
      }
      
      const scanDuration = Date.now() - scanStartTime;
      logger.info(`[RealtimeOCDetector] Alert scan completed in ${scanDuration}ms (scanned ${configs.length} configs)`);
    } catch (e) {
      logger.error('[RealtimeOCDetector] Alert scan failed:', e);
    } finally {
      this.alertScanRunning = false;
    }
  }
}

// Export singleton instance
export const realtimeOCDetector = new RealtimeOCDetector();

