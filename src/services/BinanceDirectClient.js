/**
 * Binance Direct API Client - Direct HTTP calls without CCXT
 * Based on SUMMARY_PRODUCTION_DATA_AND_TESTNET_TRADING.md
 */

import crypto from 'crypto';
import logger from '../utils/logger.js';
import { webSocketManager } from './WebSocketManager.js';
import { configService } from './ConfigService.js';


export class BinanceDirectClient {
  constructor(apiKey, secretKey, isTestnet = true, exchangeInfoService = null) {
    this.apiKey = apiKey;
    this.secretKey = secretKey;
    this.isTestnet = isTestnet;
    this.exchangeInfoService = exchangeInfoService; // Injected service for caching
    this.restPriceFallbackCache = new Map(); // symbol -> { price, timestamp }
    this.maxPriceCacheSize = 200; // Maximum number of symbols to cache (reduced from 1000 to save memory)
    
    // Load all config values from database with defaults
    this.restPriceFallbackCooldownMs = Number(configService.getNumber('BINANCE_REST_PRICE_COOLDOWN_MS', 5000));
    this.minRequestInterval = Number(configService.getNumber('BINANCE_MIN_REQUEST_INTERVAL_MS', 100));
    this.recvWindow = Number(configService.getNumber('BINANCE_RECV_WINDOW_MS', 5000));
    this.timestampSkewMs = Number(configService.getNumber('BINANCE_TIMESTAMP_SKEW_MS', 250));

    // Server time sync
    this.serverTimeOffsetMs = 0; // serverTime - clientNow
    this._lastTimeSyncAt = 0;
    this._timeSyncTTL = Number(configService.getNumber('BINANCE_TIME_SYNC_TTL_MS', 600000)); // 10 minutes default
    
    // Production data URL (always use production for market data)
    this.productionDataURL = 'https://fapi.binance.com';
    
    // Trading URL (testnet or production)
    this.baseURL = isTestnet 
      ? (configService.getString('BINANCE_FUTURES_ENDPOINT', 'https://testnet.binancefuture.com'))
      : 'https://fapi.binance.com';
    
    this.lastRequestTime = 0;

    // Cache for account position mode (hedge vs one-way)
    this._dualSidePosition = null; // boolean
    this._positionModeCheckedAt = 0;
    this._positionModeTTL = Number(configService.getNumber('BINANCE_POSITION_MODE_TTL_MS', 60000)); // 1 minute default

    // CRITICAL FIX: Request queue for rate limiting (prevents IP ban)
    // Binance Futures: 1200 requests per minute (20 req/sec), but we use conservative 8 req/sec
    // PRIORITY QUEUE: Mainnet (isTestnet=false) has priority=1 (highest), Testnet has priority=0
    this._requestQueue = [];
    this._isProcessingQueue = false;
    this.isMainnet = !isTestnet; // Track if this client is for mainnet
    this._requestInterval = Number(configService.getNumber('BINANCE_REQUEST_INTERVAL_MS', 125)); // 8 req/sec default
    this._lastSignedRequestTime = 0; // Track signed requests separately (more strict)
    this._signedRequestInterval = Number(configService.getNumber('BINANCE_SIGNED_REQUEST_INTERVAL_MS', 150)); // ~6.6 req/sec for signed

    // CRITICAL FIX: Circuit breaker to prevent spam when Binance is down
    this._circuitBreakerState = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this._circuitBreakerFailures = 0;
    this._circuitBreakerLastFailure = 0;
    this._circuitBreakerThreshold = Number(configService.getNumber('BINANCE_CIRCUIT_BREAKER_THRESHOLD', 5)); // Failures before opening
    this._circuitBreakerTimeout = Number(configService.getNumber('BINANCE_CIRCUIT_BREAKER_TIMEOUT_MS', 60000)); // 1 minute cooldown
    this._circuitBreakerSuccessThreshold = Number(configService.getNumber('BINANCE_CIRCUIT_BREAKER_SUCCESS_THRESHOLD', 2)); // Successes to close

    // CRITICAL FIX: Rate limit blocking - block all requests immediately when 429 detected
    this._rateLimitBlocked = false;
    this._rateLimitBlockedUntil = 0;
    this._rateLimitBlockDuration = Number(configService.getNumber('BINANCE_RATE_LIMIT_BLOCK_DURATION_MS', 10000)); // 10 seconds default
    this._rateLimitTestInProgress = false;

    // CRITICAL FIX: Error classification for retry logic
    this._nonRetryableErrors = new Set([
      -2019, // Insufficient margin
      -2010, // NEW_ORDER_REJECTED
      -2021, // Order would immediately trigger
      -1111, // Precision error
      -1121, // Invalid symbol
      -1122, // Invalid symbol status
      -4061, // Position side mismatch
      -4131, // Invalid quantity
      -4140, // No need to change margin type
      -4141, // No need to change position side
    ]);
  }

  /**
   * CRITICAL FIX: Check circuit breaker state
   * @returns {boolean} True if requests should be allowed
   */
  _checkCircuitBreaker() {
    const now = Date.now();
    
    if (this._circuitBreakerState === 'OPEN') {
      // Check if timeout has passed, move to HALF_OPEN
      if (now - this._circuitBreakerLastFailure >= this._circuitBreakerTimeout) {
        logger.warn('[Binance] Circuit breaker: Moving to HALF_OPEN state');
        this._circuitBreakerState = 'HALF_OPEN';
        this._circuitBreakerFailures = 0;
        return true;
      }
      // Still in cooldown
      return false;
    }
    
    return true; // CLOSED or HALF_OPEN
  }

  /**
   * CRITICAL FIX: Check if rate limit is blocking requests
   * @returns {boolean} True if requests should be allowed
   */
  _checkRateLimitBlock() {
    const now = Date.now();
    
    if (!this._rateLimitBlocked) {
      return true; // Not blocked
    }
    
    // Check if block period has passed
    if (now >= this._rateLimitBlockedUntil) {
      // Block period expired, test connection if not already testing
      if (!this._rateLimitTestInProgress) {
        this._testConnectionAfterBlock().catch(err => {
          logger.debug(`[Binance-RateLimit] Connection test failed: ${err?.message || err}`);
        });
      }
      // Still return false to block until test completes and unblocks
      return false;
    }
    
    // Still blocked
    return false;
  }

  /**
   * CRITICAL FIX: Block all requests due to rate limit
   */
  _blockRateLimit() {
    if (this._rateLimitBlocked) {
      // Already blocked, extend block time
      this._rateLimitBlockedUntil = Date.now() + this._rateLimitBlockDuration;
      logger.warn(`[Binance-RateLimit] ⚠️ Rate limit detected again. Extending block until ${new Date(this._rateLimitBlockedUntil).toISOString()}`);
      return;
    }
    
    this._rateLimitBlocked = true;
    this._rateLimitBlockedUntil = Date.now() + this._rateLimitBlockDuration;
    logger.error(`[Binance-RateLimit] 🚫 RATE LIMIT (429) DETECTED! Blocking ALL requests for ${this._rateLimitBlockDuration}ms until ${new Date(this._rateLimitBlockedUntil).toISOString()}`);
    
    // Schedule connection test after block period
    setTimeout(() => {
      this._testConnectionAfterBlock().catch(err => {
        logger.debug(`[Binance-RateLimit] Connection test failed: ${err?.message || err}`);
      });
    }, this._rateLimitBlockDuration);
  }

  /**
   * CRITICAL FIX: Test connection after rate limit block period
   * Uses a lightweight endpoint to test if rate limit is cleared
   */
  async _testConnectionAfterBlock() {
    // Prevent multiple concurrent tests
    if (this._rateLimitTestInProgress) {
      return;
    }
    
    this._rateLimitTestInProgress = true;
    
    try {
      logger.info(`[Binance-RateLimit] 🧪 Testing connection after rate limit block...`);
      
      // Use a lightweight endpoint to test (ping or ticker for a common symbol)
      // Try ping endpoint first (if available), otherwise use ticker for BTCUSDT
      let testSuccess = false;
      
      try {
        // Try ping endpoint (lightweight, no params needed)
        const pingUrl = `${this.productionDataURL}/fapi/v1/ping`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        const response = await fetch(pingUrl, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (response.ok || response.status === 200) {
          testSuccess = true;
        } else if (response.status === 429) {
          // Still rate limited, extend block
          logger.warn(`[Binance-RateLimit] ⚠️ Still rate limited. Extending block for another ${this._rateLimitBlockDuration}ms`);
          this._rateLimitBlockedUntil = Date.now() + this._rateLimitBlockDuration;
          return;
        }
      } catch (pingError) {
        // Ping failed, try ticker endpoint as fallback
        try {
          const tickerUrl = `${this.productionDataURL}/fapi/v1/ticker/price?symbol=BTCUSDT`;
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);
          
          const response = await fetch(tickerUrl, {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          
          if (response.ok) {
            const data = await response.json();
            if (data && data.price) {
              testSuccess = true;
            }
          } else if (response.status === 429) {
            // Still rate limited, extend block
            logger.warn(`[Binance-RateLimit] ⚠️ Still rate limited. Extending block for another ${this._rateLimitBlockDuration}ms`);
            this._rateLimitBlockedUntil = Date.now() + this._rateLimitBlockDuration;
            return;
          }
        } catch (tickerError) {
          // Both tests failed, but might be network issue, not rate limit
          // Check if it's a 429 error
          const errorMsg = tickerError?.message || '';
          if (errorMsg.includes('429') || tickerError?.status === 429) {
            logger.warn(`[Binance-RateLimit] ⚠️ Still rate limited. Extending block for another ${this._rateLimitBlockDuration}ms`);
            this._rateLimitBlockedUntil = Date.now() + this._rateLimitBlockDuration;
            return;
          }
        }
      }
      
      if (testSuccess) {
        // Connection test passed, unblock
        this._rateLimitBlocked = false;
        this._rateLimitBlockedUntil = 0;
        logger.info(`[Binance-RateLimit] ✅ Connection test passed! Unblocking requests.`);
      } else {
        // Test failed but not 429, might be network issue
        // Extend block to be safe
        logger.warn(`[Binance-RateLimit] ⚠️ Connection test inconclusive. Extending block for another ${this._rateLimitBlockDuration}ms`);
        this._rateLimitBlockedUntil = Date.now() + this._rateLimitBlockDuration;
      }
    } catch (error) {
      // Test failed, extend block to be safe
      const errorMsg = error?.message || '';
      if (errorMsg.includes('429') || error?.status === 429) {
        logger.warn(`[Binance-RateLimit] ⚠️ Still rate limited. Extending block for another ${this._rateLimitBlockDuration}ms`);
        this._rateLimitBlockedUntil = Date.now() + this._rateLimitBlockDuration;
      } else {
        // Network error, extend block to be safe
        logger.warn(`[Binance-RateLimit] ⚠️ Connection test failed (network error). Extending block for another ${this._rateLimitBlockDuration}ms`);
        this._rateLimitBlockedUntil = Date.now() + this._rateLimitBlockDuration;
      }
    } finally {
      this._rateLimitTestInProgress = false;
    }
  }

  /**
   * CRITICAL FIX: Record circuit breaker success
   */
  _recordCircuitBreakerSuccess() {
    if (this._circuitBreakerState === 'HALF_OPEN') {
      this._circuitBreakerFailures++;
      if (this._circuitBreakerFailures >= this._circuitBreakerSuccessThreshold) {
        logger.info('[Binance] Circuit breaker: Moving to CLOSED state (recovered)');
        this._circuitBreakerState = 'CLOSED';
        this._circuitBreakerFailures = 0;
      }
    } else if (this._circuitBreakerState === 'CLOSED') {
      // Reset failure count on success
      this._circuitBreakerFailures = 0;
    }
  }

  /**
   * CRITICAL FIX: Record circuit breaker failure
   */
  _recordCircuitBreakerFailure() {
    this._circuitBreakerFailures++;
    this._circuitBreakerLastFailure = Date.now();
    
    if (this._circuitBreakerState === 'HALF_OPEN') {
      // Failed in half-open, go back to open
      logger.warn('[Binance] Circuit breaker: Moving back to OPEN state');
      this._circuitBreakerState = 'OPEN';
      this._circuitBreakerFailures = 0;
    } else if (this._circuitBreakerState === 'CLOSED' && this._circuitBreakerFailures >= this._circuitBreakerThreshold) {
      // Too many failures, open circuit
      logger.error(`[Binance] Circuit breaker: Opening circuit after ${this._circuitBreakerFailures} failures`);
      this._circuitBreakerState = 'OPEN';
    }
  }

  /**
   * CRITICAL FIX: Classify error for retry decision
   * @param {Error} error - Error object
   * @returns {Object} { retryable: boolean, reason: string, code?: number }
   */
  _classifyError(error) {
    const msg = error?.message || String(error);
    const code = error?.code || (msg.match(/-?\d+/)?.[0] ? parseInt(msg.match(/-?\d+/)[0]) : null);
    
    // Network/timeout errors - always retryable
    if (/timeout|ECONNRESET|ENOTFOUND|ECONNREFUSED|network|fetch|aborted/i.test(msg)) {
      return { retryable: true, reason: 'network_error', code };
    }
    
    // Binance API timeout error (-1007) - retryable
    // Error -1007: "Timeout waiting for response from backend server. Send status unknown; execution status unknown."
    if (code === -1007 || /timeout waiting for response|backend server/i.test(msg)) {
      return { retryable: true, reason: 'timeout_error', code };
    }
    
    // 5xx server errors - retryable
    if (/HTTP 5\d{2}/.test(msg) || error?.status >= 500) {
      return { retryable: true, reason: 'server_error', code, status: error?.status };
    }
    
    // 408 Request Timeout - retryable
    if (error?.status === 408 || /request timeout/i.test(msg)) {
      return { retryable: true, reason: 'timeout_error', code, status: error?.status };
    }
    
    // Rate limit (429) - retryable with backoff
    if (error?.status === 429 || /429|Too Many Requests|rate limit/i.test(msg)) {
      // CRITICAL: Trigger rate limit block immediately
      this._blockRateLimit();
      return { retryable: true, reason: 'rate_limit', code };
    }
    
    // Timestamp errors - retryable after sync
    if (code === -1021 || code === -1022 || /timestamp|recvWindow/i.test(msg)) {
      return { retryable: true, reason: 'timestamp_error', code };
    }
    
    // Non-retryable logic errors
    if (code && this._nonRetryableErrors.has(code)) {
      return { retryable: false, reason: 'logic_error', code };
    }
    
    // Other 4xx errors - generally not retryable
    if (error?.status >= 400 && error?.status < 500) {
      return { retryable: false, reason: 'client_error', code, status: error?.status };
    }
    
    // Unknown errors - conservative: don't retry
    return { retryable: false, reason: 'unknown_error', code };
  }

  /**
   * CRITICAL FIX: Queue request for rate limiting with priority
   * PRIORITY: Mainnet (isMainnet=true) = 1 (highest), Testnet = 0 (lower)
   * @param {Function} requestFn - Async function to execute
   * @param {boolean} isSigned - Whether this is a signed request (stricter rate limit)
   * @returns {Promise} Request result
   */
  async _queueRequest(requestFn, isSigned = false) {
    return new Promise((resolve, reject) => {
      // Priority: Mainnet = 1 (highest), Testnet = 0 (lower)
      // Higher priority = processed first
      const priority = this.isMainnet ? 1 : 0;
      const queueItem = { requestFn, isSigned, resolve, reject, priority };
      
      // Insert into queue maintaining priority order (highest first)
      // Mainnet requests go to front, testnet to back
      let inserted = false;
      for (let i = 0; i < this._requestQueue.length; i++) {
        if (this._requestQueue[i].priority < priority) {
          this._requestQueue.splice(i, 0, queueItem);
          inserted = true;
          break;
        }
      }
      if (!inserted) {
        this._requestQueue.push(queueItem);
      }
      
      this._processRequestQueue().catch(() => {});
    });
  }

  /**
   * CRITICAL FIX: Process request queue with rate limiting
   * PRIORITY: Always processes mainnet requests first, then testnet
   */
  async _processRequestQueue() {
    if (this._isProcessingQueue) return;
    this._isProcessingQueue = true;

    while (this._requestQueue.length > 0) {
      // Queue is already sorted by priority (mainnet first), so shift() gets highest priority
      const { requestFn, isSigned, resolve, reject, priority } = this._requestQueue.shift();
      
      // Check circuit breaker
      if (!this._checkCircuitBreaker()) {
        const error = new Error('Circuit breaker is OPEN - Binance API is unavailable');
        error.code = 'CIRCUIT_BREAKER_OPEN';
        reject(error);
        continue;
      }

      // Check rate limit block
      if (!this._checkRateLimitBlock()) {
        const error = new Error(`Rate limit blocked - requests blocked until ${new Date(this._rateLimitBlockedUntil).toISOString()}`);
        error.code = 'RATE_LIMIT_BLOCKED';
        error.status = 429;
        reject(error);
        // Re-queue the request to retry later (maintain priority)
        const queueItem = { requestFn, isSigned, resolve, reject, priority };
        // Insert at front to retry immediately (but still respect priority when processing)
        this._requestQueue.unshift(queueItem);
        // Wait a bit before checking again
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }

      // Rate limiting: use stricter interval for signed requests
      const interval = isSigned ? this._signedRequestInterval : this._requestInterval;
      const lastRequestTime = isSigned ? this._lastSignedRequestTime : this.lastRequestTime;
      const now = Date.now();
      const timeSinceLastRequest = now - lastRequestTime;
      
      if (timeSinceLastRequest < interval) {
        await new Promise(resolve => setTimeout(resolve, interval - timeSinceLastRequest));
      }
      
      // Update last request time
      if (isSigned) {
        this._lastSignedRequestTime = Date.now();
      } else {
        this.lastRequestTime = Date.now();
      }

      // Execute request
      try {
        const result = await requestFn();
        this._recordCircuitBreakerSuccess();
        resolve(result);
      } catch (error) {
        const classification = this._classifyError(error);
        
        // Record failure for circuit breaker (only for network/server errors)
        if (classification.retryable && (classification.reason === 'network_error' || classification.reason === 'server_error')) {
          this._recordCircuitBreakerFailure();
        }
        
        reject(error);
      }
    }

    this._isProcessingQueue = false;
  }

  /**
   * CRITICAL FIX: Validate order parameters before submission
   * @param {string} symbol - Trading symbol
   * @param {string} side - Order side (BUY/SELL)
   * @param {string} type - Order type (MARKET/LIMIT/STOP/etc)
   * @param {number} quantity - Order quantity
   * @param {number} price - Order price (optional)
   * @returns {Promise<Object>} { valid: boolean, errors: string[] }
   */
  async validateOrderParams(symbol, side, type, quantity, price = null) {
    const errors = [];
    const normalizedSymbol = this.normalizeSymbol(symbol);

    try {
      // Get filters from cache or API
      let filters = null;
      if (this.exchangeInfoService) {
        filters = this.exchangeInfoService.getFilters(normalizedSymbol);
      }
      
      if (!filters) {
        // Fallback: fetch from API
        const exchangeInfo = await this.getTradingExchangeSymbol(normalizedSymbol);
        if (exchangeInfo?.filters) {
          filters = {
            tickSize: exchangeInfo.filters.find(f => f.filterType === 'PRICE_FILTER')?.tickSize,
            stepSize: exchangeInfo.filters.find(f => f.filterType === 'LOT_SIZE')?.stepSize,
            minQty: exchangeInfo.filters.find(f => f.filterType === 'LOT_SIZE')?.minQty,
            maxQty: exchangeInfo.filters.find(f => f.filterType === 'LOT_SIZE')?.maxQty,
            minNotional: exchangeInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL')?.notional || 
                        exchangeInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL')?.minNotional
          };
        }
      }

      if (filters) {
        // Validate quantity
        const qty = parseFloat(quantity);
        const stepSize = parseFloat(filters.stepSize || '0.001');
        const minQty = parseFloat(filters.minQty || '0');
        const maxQty = parseFloat(filters.maxQty || '999999999');

        // Store for formatter helper
        filters._parsed = { stepSize, minQty, maxQty };

        if (qty < minQty) {
          errors.push(`Quantity ${qty} is below minimum ${minQty}`);
        }
        if (qty > maxQty) {
          errors.push(`Quantity ${qty} exceeds maximum ${maxQty}`);
        }
        // Check if quantity is multiple of stepSize
        // CRITICAL FIX: Avoid using % with floats (can produce false positives like 6706.9 % 0.1)
        // Instead, validate using "step count" which is much more stable:
        // qty is valid if (qty / stepSize) is (almost) an integer.
        const stepCount = qty / stepSize;
        const nearest = Math.round(stepCount);
        const diff = Math.abs(stepCount - nearest);
        if (diff > 1e-8) { // tolerance for floating point
          errors.push(`Quantity ${qty} is not a multiple of stepSize ${stepSize}`);
        }

        // Validate price (for LIMIT orders)
        if (price !== null && type !== 'MARKET') {
          const priceNum = parseFloat(price);
          const tickSize = parseFloat(filters.tickSize || '0.01');
          const minPrice = parseFloat(filters.minPrice || '0');

          if (priceNum < minPrice) {
            errors.push(`Price ${priceNum} is below minimum ${minPrice}`);
          }
          // Check if price is multiple of tickSize
          const priceRemainder = (priceNum % tickSize);
          if (priceRemainder > 0.00000001) {
            errors.push(`Price ${priceNum} is not a multiple of tickSize ${tickSize}`);
          }

          // Validate notional
          const minNotional = parseFloat(filters.minNotional || '5');
          const notional = qty * priceNum;
          if (notional < minNotional) {
            errors.push(`Notional value ${notional.toFixed(2)} is below minimum ${minNotional}`);
          }
        } else if (type === 'MARKET' && filters.minNotional) {
          // For MARKET orders, estimate notional from current price
          const currentPrice = await this.getPrice(normalizedSymbol);
          if (currentPrice) {
            const notional = qty * currentPrice;
            const minNotional = parseFloat(filters.minNotional || '5');
            if (notional < minNotional) {
              errors.push(`Estimated notional value ${notional.toFixed(2)} is below minimum ${minNotional}`);
            }
          }
        }
      }
    } catch (e) {
      // Validation errors are non-fatal, just log
      logger.debug(`[Binance] Order validation error: ${e?.message || e}`);
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Ensure local time is synced with Binance server time within TTL
   * CRITICAL FIX: Enhanced with auto-recovery on timestamp errors
   */
  async ensureTimeSync() {
    const now = Date.now();
    if (!Number.isFinite(this.serverTimeOffsetMs) || (now - this._lastTimeSyncAt) > this._timeSyncTTL) {
      await this.syncServerTime(true);
    }
  }

  /**
   * Sync local offset against Binance server time
   * Stores serverTimeOffsetMs = serverTime - clientNow
   */
  async syncServerTime(force = false) {
    try {
      const nowBefore = Date.now();
      // Try trading base first (respects testnet/production), then fallback to production data URL
      let serverTime = null;
      try {
        const res = await this.makeTradingPublicRequest('/fapi/v1/time', 'GET');
        serverTime = Number(res?.serverTime || res?.server_time || null);
      } catch (_) {}
      if (!Number.isFinite(serverTime)) {
        const res = await this.makeMarketDataRequest('/fapi/v1/time', 'GET');
        serverTime = Number(res?.serverTime || res?.server_time || null);
      }
      const nowAfter = Date.now();
      if (!Number.isFinite(serverTime)) {
        throw new Error('Failed to fetch Binance server time');
      }
      // Approximate mid-request time to reduce latency error
      const clientNow = Math.round((nowBefore + nowAfter) / 2);
      this.serverTimeOffsetMs = serverTime - clientNow;
      this._lastTimeSyncAt = Date.now();
      logger.debug(`Synced Binance server time. Offset: ${this.serverTimeOffsetMs} ms`);
    } catch (e) {
      logger.warn(`Time sync failed: ${e?.message || e}`);
    }
  }

  /**
   * Determine decimal precision from a tick/step size string.
   * Handles values like "0.01000000", "1", and scientific notation "1e-8".
   */
  getPrecisionFromIncrement(increment) {
    if (!increment) return 0;
    const str = increment.toString();

    // Handle scientific notation (e.g., 1e-8)
    const sciMatch = str.match(/e-(\d+)$/i);
    if (sciMatch) {
      return parseInt(sciMatch[1], 10);
    }

    if (!str.includes('.')) {
      return 0;
    }

    const decimals = str.split('.')[1].replace(/0+$/, '');
    return decimals.length;
  }

  /**
   * Make request for MARKET DATA only (always uses production API)
   * This ensures all analysis uses real market data regardless of trading mode
   */
  async makeMarketDataRequest(endpoint, method = 'GET', params = {}) {
    // Rate limiting: ensure minimum interval between requests (increased for market data)
    const marketDataMinInterval = Number(configService.getNumber('BINANCE_MARKET_DATA_MIN_INTERVAL_MS', 200)); // 200ms default for market data
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    const requiredInterval = marketDataMinInterval; // Use longer interval for market data
    if (timeSinceLastRequest < requiredInterval) {
      await new Promise(resolve => setTimeout(resolve, requiredInterval - timeSinceLastRequest));
    }
    this.lastRequestTime = Date.now();

    const url = new URL(endpoint, this.productionDataURL);
    
    // Add query parameters
    if (params && Object.keys(params).length > 0) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          url.searchParams.append(key, value);
        }
      });
    }
    
    // Use longer timeout for market data (klines, ticker) to handle slow connections
    const isMarketDataEndpoint = /klines|ticker|time/.test(endpoint);
    const baseTimeout = configService.getNumber('BINANCE_REQUEST_TIMEOUT_MS', 10000);
    const timeout = isMarketDataEndpoint 
      ? Number(configService.getNumber('BINANCE_MARKET_DATA_TIMEOUT_MS', 20000))
      : baseTimeout;

    const doFetch = async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(url.toString(), {
          method,
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
            'Origin': 'https://www.binance.com',
            'Referer': 'https://www.binance.com/'
          },
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!response.ok) {
          const text = await response.text();
          const error = new Error(`HTTP ${response.status}: ${text}`);
          error.status = response.status;
          error.responseText = text;
          throw error;
        }
        // Some proxies may return text/plain JSON
        const ctype = response.headers.get('content-type') || '';
        if (ctype.includes('application/json')) {
          return await response.json();
        }
        const text = await response.text();
        try { return JSON.parse(text); } catch (_) { return text; }
      } catch (e) {
        throw e;
      }
    };

    // Check rate limit block before making request
    if (!this._checkRateLimitBlock()) {
      const error = new Error(`Rate limit blocked - requests blocked until ${new Date(this._rateLimitBlockedUntil).toISOString()}`);
      error.status = 429;
      error.code = 'RATE_LIMIT_BLOCKED';
      throw error;
    }

    // Retry on 403/429/5xx/timeout with exponential backoff
    const maxAttempts = isMarketDataEndpoint ? 3 : 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Check rate limit block before each attempt
        if (!this._checkRateLimitBlock()) {
          const error = new Error(`Rate limit blocked - requests blocked until ${new Date(this._rateLimitBlockedUntil).toISOString()}`);
          error.status = 429;
          error.code = 'RATE_LIMIT_BLOCKED';
          throw error;
        }
        
        return await doFetch();
      } catch (error) {
        const msg = error?.message || '';
        const status = error?.status || 0;
        const is429 = status === 429 || /429|Too Many Requests|rate limit/i.test(msg);
        const isRetryable = is429 || /HTTP 403|HTTP 5\d{2}|network|fetch|aborted|timeout/i.test(msg);
        
        // CRITICAL: If 429 detected, trigger rate limit block immediately
        if (is429) {
          this._blockRateLimit();
        }
        
        if (attempt < maxAttempts && isRetryable) {
          // Exponential backoff: longer delay for 429, shorter for other errors
          let backoff;
          if (is429) {
            // For 429: exponential backoff with jitter (1s, 2s, 4s)
            backoff = Math.min(1000 * Math.pow(2, attempt - 1), 10000) + Math.random() * 1000;
            logger.warn(`[Binance-MarketData] ⚠️ Rate limit (429) on ${endpoint}. Waiting ${Math.round(backoff)}ms before retry ${attempt}/${maxAttempts}...`);
            // Update lastRequestTime to prevent immediate next request
            this.lastRequestTime = Date.now() + backoff;
          } else {
            backoff = 500 * attempt; // 500ms, 1s, 1.5s for other errors
            logger.warn(`[Binance-MarketData] ${endpoint} attempt ${attempt}/${maxAttempts} failed: ${msg}. Retrying in ${backoff}ms...`);
          }
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }
        // For invalid symbol status, log as debug instead of error to reduce spam
        if (msg.includes('Invalid symbol status') || msg.includes('-1122')) {
          logger.debug(`Market data request failed (invalid symbol): ${endpoint} - ${msg}`);
        } else if (msg.includes('aborted') || msg.includes('timeout')) {
          logger.warn(`[Binance-MarketData] ⚠️ ${endpoint} timed out after ${maxAttempts} attempts (timeout=${timeout}ms). Check network/server load.`);
        } else {
          logger.error(`❌ Market data request failed: ${endpoint}`, msg);
        }
        throw error;
      }
    }
  }

  /**
   * Make PUBLIC request against TRADING baseURL (used for testnet exchangeInfo without auth)
   */
  async makeTradingPublicRequest(endpoint, method = 'GET', params = {}) {
    // Check rate limit block before making request
    if (!this._checkRateLimitBlock()) {
      const error = new Error(`Rate limit blocked - requests blocked until ${new Date(this._rateLimitBlockedUntil).toISOString()}`);
      error.status = 429;
      error.code = 'RATE_LIMIT_BLOCKED';
      throw error;
    }

    // Rate limiting
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.minRequestInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest));
    }
    this.lastRequestTime = Date.now();

    const url = new URL(endpoint, this.baseURL);
    if (params && Object.keys(params).length > 0) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) url.searchParams.append(key, value);
      });
    }

    const response = await fetch(url.toString(), { method, headers: { 'Content-Type': 'application/json' } });
    if (!response.ok) {
      // CRITICAL: Check for 429 rate limit in response status
      if (response.status === 429) {
        this._blockRateLimit();
      }
      const text = await response.text();
      const error = new Error(`HTTP ${response.status}: ${text}`);
      error.status = response.status;
      throw error;
    }
    return await response.json();
  }

  /**
   * Make request for TRADING operations (uses testnet or production based on config)
   * CRITICAL FIX: Enhanced with request queue, error classification, and circuit breaker
   */
  async makeRequest(endpoint, method = 'GET', params = {}, requiresAuth = false, retries = 3) {
    // Disable retry for order operations to avoid duplicate orders
    const isOrderEndpoint = endpoint.includes('/fapi/v1/order') || endpoint.includes('/fapi/v1/allOpenOrders');
    if (isOrderEndpoint) {
      retries = 1; // Single attempt only for order operations
    }

    // CRITICAL FIX: Use request queue for rate limiting
    return this._queueRequest(async () => {
      return await this._makeRequestInternal(endpoint, method, params, requiresAuth, retries);
    }, requiresAuth);
  }

  /**
   * Internal request method (called from queue)
   */
  async _makeRequestInternal(endpoint, method = 'GET', params = {}, requiresAuth = false, retries = 3) {

    const url = `${this.baseURL}${endpoint}`;

    const timeout = configService.getNumber('BINANCE_REQUEST_TIMEOUT_MS', 10000);
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (requiresAuth) headers['X-MBX-APIKEY'] = this.apiKey;

    // Ensure server time sync if needed before signed requests
    if (requiresAuth) {
      await this.ensureTimeSync();
    }

    // Check rate limit block before making request
    if (!this._checkRateLimitBlock()) {
      const error = new Error(`Rate limit blocked - requests blocked until ${new Date(this._rateLimitBlockedUntil).toISOString()}`);
      error.status = 429;
      error.code = 'RATE_LIMIT_BLOCKED';
      throw error;
    }

    // CRITICAL FIX: Make request with retries and error classification
    let useDirectServerTime = false;
    for (let i = 0; i < retries; i++) {
      // Check rate limit block before each attempt
      if (!this._checkRateLimitBlock()) {
        const error = new Error(`Rate limit blocked - requests blocked until ${new Date(this._rateLimitBlockedUntil).toISOString()}`);
        error.status = 429;
        error.code = 'RATE_LIMIT_BLOCKED';
        throw error;
      }

      let queryString = '';
      let requestBody = null;

      try {
        // Build signed/unsigned params per attempt (fresh timestamp every try)
        if (requiresAuth) {
          let timestamp;
          if (useDirectServerTime) {
            // Fetch server time directly for highest accuracy
            try {
              const res = await this.makeTradingPublicRequest('/fapi/v1/time', 'GET');
              const st = Number(res?.serverTime || res?.server_time || 0);
              timestamp = st > 0 ? st : Date.now() + (this.serverTimeOffsetMs || 0);
            } catch (_) {
              timestamp = Date.now() + (this.serverTimeOffsetMs || 0);
            }
          } else {
            timestamp = Date.now() + (this.serverTimeOffsetMs || 0) + (this.timestampSkewMs || 0);
          }
          const recvWindow = Math.max(1000, Number(this.recvWindow) || 5000);
          const authParams = { ...params, timestamp, recvWindow };

          // Build canonical encoded query string with sorted keys
          const qs = new URLSearchParams();
          Object.keys(authParams)
            .sort()
            .forEach((key) => {
              const val = authParams[key];
              if (val !== undefined && val !== null) qs.append(key, String(val));
            });
          const qsString = qs.toString();
          const signature = crypto.createHmac('sha256', this.secretKey).update(qsString).digest('hex');

          if (method === 'GET' || method === 'DELETE') {
            queryString = '?' + qsString + '&signature=' + signature;
          } else {
            requestBody = qsString + '&signature=' + signature;
          }
        } else {
          if (Object.keys(params).length > 0) {
            queryString = '?' + new URLSearchParams(params).toString();
          }
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(url + queryString, { method, headers, body: requestBody, signal: controller.signal });

        clearTimeout(timeoutId);

        // CRITICAL FIX: Check content-type before parsing JSON
        // Binance may return HTML (error pages, rate limit pages, maintenance pages)
        // IMPORTANT: Response body can only be read once, so we must handle both cases carefully
        const contentType = response.headers.get('content-type') || '';
        let data;
        let responseText = null;
        
        try {
          // Always read as text first to handle both JSON and HTML
          responseText = await response.text();
          
          // Try to parse as JSON
          try {
            data = JSON.parse(responseText);
          } catch (parseError) {
            // Response is not valid JSON (likely HTML error page)
            // Check if it looks like HTML
            if (responseText.trim().startsWith('<!DOCTYPE') || responseText.trim().startsWith('<html') || responseText.trim().startsWith('<')) {
              const error = new Error(`Binance API returned HTML instead of JSON (status ${response.status}): ${responseText.substring(0, 200)}...`);
              error.status = response.status;
              error.responseText = responseText;
              error.isHtmlResponse = true;
              error.code = response.status >= 500 ? -1000 : -1001; // Use generic error code for HTML responses
              throw error;
            }
            
            // Not HTML but still not valid JSON - this is unexpected
            const error = new Error(`Binance API returned invalid JSON (${contentType}): ${parseError?.message || parseError}`);
            error.status = response.status;
            error.responseText = responseText;
            error.originalError = parseError;
            throw error;
          }
        } catch (parseError) {
          // If parse error occurs, create error with original error
          if (parseError.isHtmlResponse) {
            // For HTML responses, classify as server error (retryable if 5xx)
            const error = parseError;
            if (response.status >= 500) {
              error.retryable = true;
            }
            throw error;
          }
          // JSON parse error - not retryable (malformed response)
          const error = new Error(`Failed to parse Binance API response as JSON: ${parseError?.message || parseError}`);
          error.status = response.status;
          error.responseText = responseText;
          error.originalError = parseError;
          throw error;
        }
        
        if (!response.ok) {
          // CRITICAL: Check for 429 rate limit in response status
          if (response.status === 429) {
            this._blockRateLimit();
          }
          
          if (data.code && data.msg) {
            // CRITICAL FIX: Enhanced timestamp error handling with auto-recovery
            if (data.code === -1021) {
              logger.warn('Binance -1021 timestamp outside recvWindow. Syncing time and retrying...');
              await this.syncServerTime(true);
              useDirectServerTime = true;
              // retry next loop iteration
              await new Promise(r => setTimeout(r, 50));
              continue;
            }
            if (data.code === -1022) {
              // Signature invalid – often caused by param ordering/encoding or time skew; try resync then retry
              logger.warn('Binance -1022 invalid signature. Will sync time and retry with fresh canonical params.', {
                endpoint,
                method,
                recvWindow: this.recvWindow,
                serverTimeOffsetMs: this.serverTimeOffsetMs,
              });
              await this.syncServerTime(true);
              await new Promise(r => setTimeout(r, 50));
              continue;
            }
            if (data.code === -1111) {
              logger.error('Binance precision rejection', { endpoint, params: this.sanitizeParams(params), response: data });
            }
            
              // CRITICAL FIX: Handle timeout error (-1007) - retryable
            if (data.code === -1007) {
              logger.warn(`[Binance] Timeout error -1007 on ${endpoint}. This is retryable - will retry with backoff.`);
              // Continue to throw error so retry logic handles it
            }
            
            // CRITICAL FIX: Create error with code for classification
            // Suppress error log for -4400 (Quantitative Rules) as it's handled gracefully in OrderService
            const error = new Error(`Binance API Error ${data.code}: ${data.msg}`);
            error.code = data.code;
            error.status = response.status;
            if (data.code === -4400) {
              // Log as debug instead of error since OrderService handles it gracefully
              logger.debug(
                `[Binance] -4400 Quantitative Rules violation (handled in OrderService) | ` +
                `endpoint=${endpoint} symbol=${params?.symbol || 'N/A'}`
              );
            }
            throw error;
          }
          const error = new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
          error.status = response.status;
          throw error;
        }
        return data;
      } catch (error) {
        // CRITICAL FIX: Classify error and decide if retry is appropriate
        const classification = this._classifyError(error);
        
        // Don't retry non-retryable errors
        if (!classification.retryable) {
          logger.debug(`[Binance] Non-retryable error: ${classification.reason} (code: ${classification.code})`);
          throw error;
        }
        
        // Last attempt - throw error
        if (i === retries - 1) {
          throw error;
        }
        
        // Calculate backoff based on error type
        let backoff;
        if (classification.reason === 'rate_limit') {
          // Rate limit: longer backoff with jitter
          backoff = Math.min(1000 * Math.pow(2, i), 10000) + Math.random() * 1000;
          logger.warn(`[Binance] Rate limit hit, backing off ${Math.round(backoff)}ms before retry ${i + 1}/${retries}`);
        } else if (classification.reason === 'timeout_error' || classification.code === -1007) {
          // Timeout error (-1007): longer backoff (3s, 6s, 12s) since backend server is slow
          backoff = Math.min(3000 * Math.pow(2, i), 15000) + Math.random() * 1000;
          logger.warn(`[Binance] Timeout error (code: ${classification.code}), backing off ${Math.round(backoff)}ms before retry ${i + 1}/${retries}`);
        } else if (classification.reason === 'timestamp_error') {
          // Timestamp error: short backoff, time already synced
          backoff = 50;
        } else if (classification.reason === 'network_error') {
          // Network error: exponential backoff with jitter
          backoff = Math.min(2000 * Math.pow(2, i), 10000) + Math.random() * 500;
        } else {
          // Server error: exponential backoff
          backoff = 1000 * (i + 1);
        }
        
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }
  }

  /**
   * Set margin type for a symbol (ISOLATED or CROSSED)
   */
  async setMarginType(symbol, marginType = 'ISOLATED') {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const params = { symbol: normalizedSymbol, marginType: marginType.toUpperCase() };
    try {
      return await this.makeRequest('/fapi/v1/marginType', 'POST', params, true);
    } catch (e) {
      // Non-fatal if already set or not changeable
      logger.warn(`setMarginType warning for ${normalizedSymbol}: ${e.message || e}`);
      return null;
    }
  }

  /**
   * Set leverage for a symbol (1-125 depending on symbol)
   */
  async setLeverage(symbol, leverage = 5) {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const lev = Math.max(1, Math.min(parseInt(leverage) || 5, 125));
    const params = { symbol: normalizedSymbol, leverage: lev };
    try {
      return await this.makeRequest('/fapi/v1/leverage', 'POST', params, true);
    } catch (e) {
      logger.warn(`setLeverage warning for ${normalizedSymbol}: ${e.message || e}`);
      return null;
    }
  }

  /**
   * Get leverage brackets for a symbol (signed endpoint)
   */
  async getLeverageBrackets(symbol) {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const params = { symbol: normalizedSymbol };
    const data = await this.makeRequest('/fapi/v1/leverageBracket', 'GET', params, true);
    // API returns array (or object with array) depending on context; normalize
    const arr = Array.isArray(data) ? data : (data?.brackets || []);
    if (arr.length === 0) return [];
    // On some responses, each element is { symbol, brackets: [...] }
    if (arr[0]?.brackets) {
      const entry = arr.find(e => e.symbol === normalizedSymbol) || arr[0];
      return entry?.brackets || [];
    }
    // Or already brackets list
    return arr;
  }

  /**
   * Determine optimal (max allowed) leverage for given notional
   */
  async getOptimalLeverage(symbol, notionalUSDT) {
    try {
      const brackets = await this.getLeverageBrackets(symbol);
      if (!brackets || brackets.length === 0) return null;
      const n = Number(notionalUSDT) || 0;
      // Binance brackets typically have: notionalFloor, notionalCap, initialLeverage
      // Pick the bracket where floor < n <= cap; if notional==0, choose highest initialLeverage
      let chosen = null;
      if (n > 0) {
        chosen = brackets.find(b => (n > Number(b.notionalFloor || 0)) && (n <= Number(b.notionalCap || Number.MAX_SAFE_INTEGER)));
      }
      if (!chosen) {
        // If none matched, choose the bracket with max initialLeverage
        chosen = brackets.reduce((a, b) => (Number(b.initialLeverage || 0) > Number(a.initialLeverage || 0) ? b : a), brackets[0]);
      }
      const lev = parseInt(chosen?.initialLeverage || 0) || null;
      return lev;
    } catch (e) {
      logger.warn(`getOptimalLeverage failed for ${symbol}: ${e.message || e}`);
      return null;
    }
  }

  /**
   * Get current price
   */
  async getPrice(symbol) {
    const normalizedSymbol = this.normalizeSymbol(symbol);

    // Lấy giá ưu tiên từ WebSocket (production stream)
    const cachedPrice = webSocketManager.getPrice(normalizedSymbol);
    if (cachedPrice) {
      return cachedPrice;
    }

    // REST fallback cho ticker price:
    // - Production: tôn trọng cấu hình BINANCE_TICKER_REST_FALLBACK (tránh bị ban IP)
    // - Testnet   : LUÔN cho phép REST fallback (market data là production, chỉ trading là testnet)
    const globalFallback = configService.getBoolean('BINANCE_TICKER_REST_FALLBACK', false);
    const enableRestFallback = globalFallback || this.isTestnet;
    if (!enableRestFallback) {
      return null;
    }

    // Respect cooldown when reusing REST fallback price (increased to avoid rate limits)
    const fallbackEntry = this.restPriceFallbackCache.get(normalizedSymbol);
    const now = Date.now();
    const cooldownMs = Number(configService.getNumber('BINANCE_REST_PRICE_COOLDOWN_MS', 10000)); // Increased from 5s to 10s
    if (fallbackEntry && now - fallbackEntry.timestamp < cooldownMs) {
      return fallbackEntry.price;
    }

    try {
      const ticker = await this.makeMarketDataRequest('/fapi/v1/ticker/price', 'GET', { symbol: normalizedSymbol });
      const restPrice = parseFloat(ticker?.price);
      if (Number.isFinite(restPrice) && restPrice > 0) {
    // CRITICAL FIX: O(1) LRU eviction using Map insertion order
        if (this.restPriceFallbackCache.size >= this.maxPriceCacheSize && !this.restPriceFallbackCache.has(normalizedSymbol)) {
      // Remove oldest entry (first in Map)
      const oldestKey = this.restPriceFallbackCache.keys().next().value;
      if (oldestKey) {
        this.restPriceFallbackCache.delete(oldestKey);
      }
        }
        this.restPriceFallbackCache.set(normalizedSymbol, { price: restPrice, timestamp: now });
        logger.info(`Price for ${normalizedSymbol} not in WebSocket cache. Using REST fallback price ${restPrice}.`);
        return restPrice;
      }
    } catch (error) {
      logger.debug(`Failed REST fallback price fetch for ${normalizedSymbol}: ${error.message || error}`);
    }

    logger.debug(`Price for ${normalizedSymbol} not found via WebSocket or REST fallback.`);
    return null;
  }

  /**
   * Get 24h ticker
   */
  async getTicker(symbol) {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    return await this.makeMarketDataRequest('/fapi/v1/ticker/24hr', 'GET', { symbol: normalizedSymbol });
  }

  /**
   * Normalize symbol to Binance format
   * Converts formats like BTC/USDT, BTCUSD_PERP, BTCUSD-PERP to BTCUSDT
   * @param {string} symbol - Symbol in various formats
   * @returns {string} Normalized symbol (e.g., BTCUSDT)
   */
  normalizeSymbol(symbol) {
    if (!symbol) return symbol;
    
    // Remove slashes and colons (BTC/USDT -> BTCUSDT)
    let normalized = symbol.replace(/\//g, '').replace(/:/g, '');
    
    // Handle PERP formats: BTCUSD_PERP, BTCUSD-PERP -> BTCUSDT
    if (normalized.includes('_PERP') || normalized.includes('-PERP')) {
      normalized = normalized.replace(/[_-]PERP/g, '');
      // If ends with USD, convert to USDT
      if (normalized.endsWith('USD')) {
        normalized = normalized.replace(/USD$/, 'USDT');
      }
    }
    
    // If ends with USD (not USDT), convert to USDT
    if (normalized.endsWith('USD') && !normalized.endsWith('USDT')) {
      normalized = normalized.replace(/USD$/, 'USDT');
    }
    
    return normalized;
  }

  /**
   * Get exchange info for a symbol (includes filters like tickSize, stepSize)
   * @param {string} symbol - Trading symbol
   * @returns {Promise<Object>} Exchange info for the symbol
   */
  async getExchangeInfo(symbol) {
    if (!symbol) {
      return await this.makeMarketDataRequest('/fapi/v1/exchangeInfo', 'GET');
    }
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const data = await this.makeMarketDataRequest('/fapi/v1/exchangeInfo', 'GET', { symbol: normalizedSymbol });
    if (data.symbols && data.symbols.length > 0) {
      const found = data.symbols.find(s => s.symbol === normalizedSymbol);
      return found || null; // do not fallback to first symbol
    }
    return null;
  }

  /**
   * Get tickSize (price precision) for a symbol
   * @param {string} symbol - Trading symbol
   * @returns {Promise<string>} tickSize (e.g., "0.10", "0.01")
   */
  async getTradingExchangeSymbol(symbol) {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    try {
      const data = await this.makeTradingPublicRequest('/fapi/v1/exchangeInfo', 'GET', { symbol: normalizedSymbol });
      if (data?.symbols?.length) {
        return data.symbols.find(s => s.symbol === normalizedSymbol) || null;
      }
      return null;
    } catch (e) {
      // Fallback: try production data endpoint
      try {
        const data = await this.makeMarketDataRequest('/fapi/v1/exchangeInfo', 'GET', { symbol: normalizedSymbol });
        if (data?.symbols?.length) return data.symbols.find(s => s.symbol === normalizedSymbol) || null;
      } catch (_) {}
      return null;
    }
  }

  async getTickSize(symbol) {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    
    // Try to get from cache first (price tick size)
    if (this.exchangeInfoService?.getTickSize) {
      const cached = this.exchangeInfoService.getTickSize(normalizedSymbol);
      if (cached) {
        logger.debug(`[Cache Hit] getTickSize for ${normalizedSymbol}: ${cached}`);
        return cached;
      }
    }
    
    // Fallback to REST API if cache miss
    logger.debug(`[Cache Miss] getTickSize for ${normalizedSymbol}, falling back to REST API`);
    const exchangeInfo = await this.getTradingExchangeSymbol(symbol);
    if (!exchangeInfo || !exchangeInfo.filters) return '0.01';
    const priceFilter = exchangeInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
    return priceFilter?.tickSize || '0.01';
  }

  /**
   * Get trigger tickSize (stopPrice precision) for a symbol
   * Uses TRIGGER_ORDER_PRICE_FILTER if available, falls back to PRICE_FILTER
   */
  async getTriggerTickSize(symbol) {
    const normalizedSymbol = this.normalizeSymbol(symbol);

    // No cache layer yet; pull from exchangeInfo
    const exchangeInfo = await this.getTradingExchangeSymbol(symbol);
    if (!exchangeInfo || !exchangeInfo.filters) return await this.getTickSize(normalizedSymbol);
    const triggerFilter = exchangeInfo.filters.find(f => f.filterType === 'TRIGGER_ORDER_PRICE_FILTER');
    if (triggerFilter?.tickSize) return triggerFilter.tickSize;
    const priceFilter = exchangeInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
    return priceFilter?.tickSize || '0.01';
  }

  /**
   * Get price filter (minPrice, tickSize) for limit price
   */
  async getPriceFilter(symbol) {
    const info = await this.getTradingExchangeSymbol(symbol);
    const priceFilter = info?.filters?.find(f => f.filterType === 'PRICE_FILTER');
    return {
      minPrice: priceFilter?.minPrice || '0',
      maxPrice: priceFilter?.maxPrice || null,
      tickSize: priceFilter?.tickSize || '0.01'
    };
  }

  /**
   * Get trigger order price filter (minPrice, tickSize) for stopPrice
   */
  async getTriggerOrderPriceFilter(symbol) {
    const info = await this.getTradingExchangeSymbol(symbol);
    const triggerFilter = info?.filters?.find(f => f.filterType === 'TRIGGER_ORDER_PRICE_FILTER');
    if (triggerFilter) {
      return {
        minPrice: triggerFilter?.minPrice || '0',
        maxPrice: triggerFilter?.maxPrice || null,
        tickSize: triggerFilter?.tickSize || '0.01'
      };
    }
    // Fallback to price filter when trigger filter is not present
    return await this.getPriceFilter(symbol);
  }

  /**
   * Get percent price band for a symbol and order side (for price protection)
   * Uses PERCENT_PRICE_BY_SIDE if available, else PERCENT_PRICE.
   */
  async getPercentPriceBand(symbol, orderSideForPrice) {
    const info = await this.getTradingExchangeSymbol(symbol);
    if (!info?.filters) return null;

    const filter =
      info.filters.find(f => f.filterType === 'PERCENT_PRICE_BY_SIDE') ||
      info.filters.find(f => f.filterType === 'PERCENT_PRICE');

    if (!filter) return null;

    // For hedge mode: BUY uses askMultiplier*, SELL uses bidMultiplier*
    // For one-way: use multiplierUp/Down
    if (filter.filterType === 'PERCENT_PRICE_BY_SIDE') {
      const isBuy = orderSideForPrice === 'BUY';
      const up = isBuy ? filter.askMultiplierUp : filter.bidMultiplierUp;
      const down = isBuy ? filter.askMultiplierDown : filter.bidMultiplierDown;
      return {
        up: up ? parseFloat(up) : null,
        down: down ? parseFloat(down) : null
      };
    }

    return {
      up: filter.multiplierUp ? parseFloat(filter.multiplierUp) : null,
      down: filter.multiplierDown ? parseFloat(filter.multiplierDown) : null
    };
  }

  /**
   * Get stepSize (quantity precision) for a symbol
   * @param {string} symbol - Trading symbol
   * @returns {Promise<string>} stepSize (e.g., "0.001", "0.01")
   */
  async getStepSize(symbol) {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    
    // Try to get from cache first
    if (this.exchangeInfoService) {
      const cached = this.exchangeInfoService.getStepSize(normalizedSymbol);
      if (cached) {
        logger.debug(`[Cache Hit] getStepSize for ${normalizedSymbol}: ${cached}`);
        return cached;
      }
    }
    
    // Fallback to REST API if cache miss
    logger.debug(`[Cache Miss] getStepSize for ${normalizedSymbol}, falling back to REST API`);
    const exchangeInfo = await this.getTradingExchangeSymbol(symbol);
    if (!exchangeInfo || !exchangeInfo.filters) return '0.001';
    const lotSizeFilter = exchangeInfo.filters.find(f => f.filterType === 'LOT_SIZE');
    return lotSizeFilter?.stepSize || '0.001';
  }

  /**
   * Get minimum notional for a symbol
   * @param {string} symbol
   * @returns {Promise<number|null>}
   */
  async getMinNotional(symbol) {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    
    // Try to get from cache first
    if (this.exchangeInfoService) {
      const cached = this.exchangeInfoService.getMinNotional(normalizedSymbol);
      if (cached) {
        logger.debug(`[Cache Hit] getMinNotional for ${normalizedSymbol}: ${cached}`);
        return cached;
      }
    }
    
    // Fallback to REST API if cache miss
    logger.debug(`[Cache Miss] getMinNotional for ${normalizedSymbol}, falling back to REST API`);
    const exchangeInfo = await this.getTradingExchangeSymbol(symbol);
    if (!exchangeInfo || !exchangeInfo.filters) return null;
    const minNotionalFilter = exchangeInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');
    const val = minNotionalFilter?.notional || minNotionalFilter?.minNotional;
    const num = parseFloat(val);
    return Number.isFinite(num) ? num : null;
  }

  /**
   * Get maximum leverage for a symbol
   * @param {string} symbol - Trading symbol
   * @returns {Promise<number|null>} Maximum leverage or null if not found
   */
  async getMaxLeverage(symbol) {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    
    // Try to get from cache first
    if (this.exchangeInfoService) {
      const cached = this.exchangeInfoService.getMaxLeverage(normalizedSymbol);
      if (cached) {
        logger.debug(`[Cache Hit] getMaxLeverage for ${normalizedSymbol}: ${cached}`);
        return cached;
      }
    }
    
    // Fallback to REST API if cache miss
    logger.debug(`[Cache Miss] getMaxLeverage for ${normalizedSymbol}, falling back to REST API`);
    try {
      const brackets = await this.getLeverageBrackets(normalizedSymbol);
      if (!brackets || brackets.length === 0) return 125;
      const maxBracket = brackets.reduce((max, bracket) => {
        const leverage = parseInt(bracket.initialLeverage || 0);
        return leverage > parseInt(max.initialLeverage || 0) ? bracket : max;
      });
      return parseInt(maxBracket.initialLeverage || 125);
    } catch (e) {
      logger.warn(`getMaxLeverage failed for ${normalizedSymbol}: ${e.message || e}`);
      return 125; // Default to 125
    }
  }

  /**
   * Check whether account uses dual-side position mode (hedge)
   * @returns {Promise<boolean>}
   */
  async getDualSidePosition() {
    const now = Date.now();
    if (this._dualSidePosition !== null && now - this._positionModeCheckedAt < this._positionModeTTL) {
      return this._dualSidePosition;
    }
    try {
      const data = await this.makeRequest('/fapi/v1/positionSide/dual', 'GET', {}, true);
      const dual = !!data?.dualSidePosition;
      this._dualSidePosition = dual;
      this._positionModeCheckedAt = now;
      return dual;
    } catch (error) {
      logger.warn(`Failed to query positionSide mode, defaulting to one-way: ${error.message || error}`);
      this._dualSidePosition = false;
      this._positionModeCheckedAt = now;
      return false;
    }
  }

  /**
   * Round price according to tickSize
   * @param {number} price - Price to round
   * @param {string} tickSize - Tick size (e.g., "0.10", "0.01")
   * @returns {number} Rounded price
   */
  roundPrice(price, tickSize) {
    const tick = parseFloat(tickSize);
    if (tick === 0) return price;

    const precision = this.getPrecisionFromIncrement(tickSize);
  
    // CRITICAL FIX: Use more precise rounding to avoid floating point errors
    // Calculate the number of ticks
    const tickCount = Math.round(price / tick);
    // Multiply back to get exact price
    const rounded = tickCount * tick;
    
    // Format to exact precision to avoid floating point issues
    return Number(rounded.toFixed(precision));
  }

  /**
   * Round quantity according to stepSize
   * @param {number} quantity - Quantity to round
   * @param {string} stepSize - Step size (e.g., "0.001", "0.01")
   * @returns {number} Rounded quantity
   */
  formatQuantity(quantity, stepSize) {
    const q = Number(quantity);
    if (!Number.isFinite(q) || q <= 0) return '0';

    const precision = this.getPrecisionFromIncrement(stepSize);

    if (precision === 0) {
      return Math.floor(q).toString();
    }

    const factor = Math.pow(10, precision);
    const flooredQuantity = Math.floor(q * factor) / factor;
    return flooredQuantity.toFixed(precision);
  }

  /**
   * Get klines (candles)
   * Automatically handles multiple requests if limit > 1000 (Binance API limit)
   * Based on DOCS_FETCH_BTCUSDT_24H_DATA.md
   * 
   * @param {string} symbol - Trading symbol (e.g., BTCUSDT)
   * @param {string} interval - Time interval (1m, 5m, 15m, 30m, etc.)
   * @param {number} limit - Number of candles to fetch (max 1000 per request)
   * @param {number} endTime - Optional end timestamp (for historical data)
   * @returns {Promise<Array>} Array of candle objects
   */
  async getKlines(symbol, interval = '1m', limit = 100, endTime = null) {
    // Normalize symbol to Binance format
    const normalizedSymbol = this.normalizeSymbol(symbol);
    
    // Binance API limit: max 1000 candles per request
    const MAX_CANDLES_PER_REQUEST = 1000;
    
    // If limit <= 1000, fetch in single request
    if (limit <= MAX_CANDLES_PER_REQUEST) {
      const params = { symbol: normalizedSymbol, interval, limit };
      if (endTime) params.endTime = endTime;
      
      const data = await this.makeMarketDataRequest('/fapi/v1/klines', 'GET', params);
      
      // Convert to our format
      return data.map(candle => ({
        openTime: parseInt(candle[0]),
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[5]),
        closeTime: parseInt(candle[6]),
        quoteVolume: parseFloat(candle[7]),
        trades: parseInt(candle[8]),
        takerBuyBaseVolume: parseFloat(candle[9]),
        takerBuyQuoteVolume: parseFloat(candle[10])
      }));
    }
    
    // If limit > 1000, split into multiple requests
    // Strategy: Fetch from newest to oldest, then reverse
    const allCandles = [];
    let remaining = limit;
    let currentEndTime = endTime;
    
    while (remaining > 0) {
      const batchLimit = Math.min(remaining, MAX_CANDLES_PER_REQUEST);
      const params = { 
        symbol: normalizedSymbol, 
        interval, 
        limit: batchLimit 
      };
      
      if (currentEndTime) {
        params.endTime = currentEndTime;
      }
      
      const data = await this.makeMarketDataRequest('/fapi/v1/klines', 'GET', params);
      
      if (!data || data.length === 0) {
        break; // No more data available
      }
      
      // Convert to our format
      const batchCandles = data.map(candle => ({
        openTime: parseInt(candle[0]),
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[5]),
        closeTime: parseInt(candle[6]),
        quoteVolume: parseFloat(candle[7]),
        trades: parseInt(candle[8]),
        takerBuyBaseVolume: parseFloat(candle[9]),
        takerBuyQuoteVolume: parseFloat(candle[10])
      }));
      
      // Prepend to allCandles (newest first, we'll reverse later)
      allCandles.unshift(...batchCandles);
      
      // Update for next batch: use the oldest candle's openTime - 1ms
      if (batchCandles.length > 0) {
        currentEndTime = batchCandles[0].openTime - 1;
      }
      
      remaining -= batchCandles.length;
      
      // If we got fewer candles than requested, we've reached the limit
      if (batchCandles.length < batchLimit) {
        break;
      }
      
      // Add delay between requests to avoid rate limiting
      if (remaining > 0) {
        await new Promise(resolve => setTimeout(resolve, this.minRequestInterval));
      }
    }
    
    // Reverse to get chronological order (oldest first)
    // This matches the expected format in the documentation
    return allCandles.reverse();
  }

  /**
   * Get exchange info
   */
  async getExchangeInfo() {
    return await this.makeMarketDataRequest('/fapi/v1/exchangeInfo', 'GET');
  }

  /**
   * Format order quantity to comply with exchange rules
   * @param {string} symbol - Trading symbol
   * @param {number|string} quantity - Desired quantity
   * @returns {Promise<{quantity: string, minQty: number, maxQty: number, stepSize: number}>} Formatted quantity and limits
   */
  async formatOrderQuantity(symbol, quantity) {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    
    // Get symbol info with caching
    let symbolInfo;
    try {
      symbolInfo = await this.getTradingExchangeSymbol(normalizedSymbol);
    } catch (e) {
      logger.warn(`[Binance] Failed to get symbol info for ${normalizedSymbol}, using raw quantity: ${e?.message || e}`);
      return {
        quantity: quantity.toString(),
        minQty: 0,
        maxQty: Number.MAX_SAFE_INTEGER,
        stepSize: 0.00000001
      };
    }

    // Get LOT_SIZE filter
    const lotSizeFilter = symbolInfo.filters?.find(f => f.filterType === 'LOT_SIZE');
    if (!lotSizeFilter) {
      logger.warn(`[Binance] No LOT_SIZE filter for ${normalizedSymbol}, using raw quantity`);
      return {
        quantity: quantity.toString(),
        minQty: 0,
        maxQty: Number.MAX_SAFE_INTEGER,
        stepSize: 0.00000001
      };
    }

    // Parse filter values
    const stepSize = parseFloat(lotSizeFilter.stepSize);
    const minQty = parseFloat(lotSizeFilter.minQty);
    const maxQty = parseFloat(lotSizeFilter.maxQty);
    
    // Round to step size
    let formattedQty = Math.floor(quantity / stepSize) * stepSize;
    
    // Clamp to min/max
    formattedQty = Math.max(minQty, Math.min(maxQty, formattedQty));
    
    // Format to avoid scientific notation and trailing zeros
    const precision = this.getPrecisionFromIncrement(stepSize);
    const formattedStr = formattedQty.toFixed(precision).replace(/\.?0+$/, '');
    
    logger.debug(`[Binance] Formatted quantity: ${quantity} -> ${formattedStr} for ${normalizedSymbol} (min: ${minQty}, max: ${maxQty}, step: ${stepSize})`);
    
    return {
      quantity: formattedStr,
      minQty,
      maxQty,
      stepSize
    };
  }

  /**
   * Get account balance
   */
  async getBalance() {
    const data = await this.makeRequest('/fapi/v2/account', 'GET', {}, true);
    const usdtAsset = data.assets?.find(a => a.asset === 'USDT');
    return {
      free: parseFloat(usdtAsset?.availableBalance || 0),
      used: parseFloat(usdtAsset?.walletBalance || 0) - parseFloat(usdtAsset?.availableBalance || 0),
      total: parseFloat(usdtAsset?.walletBalance || 0),
      USDT: {
        free: parseFloat(usdtAsset?.availableBalance || 0),
        used: parseFloat(usdtAsset?.walletBalance || 0) - parseFloat(usdtAsset?.availableBalance || 0),
        total: parseFloat(usdtAsset?.walletBalance || 0)
      }
    };
  }

  /**
   * Fetch user trades for an order and compute average fill price
   */
  async getOrderAverageFillPrice(symbol, orderId) {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    try {
      const trades = await this.makeRequest('/fapi/v1/userTrades', 'GET', { symbol: normalizedSymbol, orderId }, true);
      if (!Array.isArray(trades) || trades.length === 0) return null;
      let sum = 0, qty = 0;
      for (const t of trades) {
        const p = parseFloat(t.price || 0);
        const q = parseFloat(t.qty || 0);
        if (p > 0 && q > 0) {
          sum += p * q;
          qty += q;
        }
      }
      if (qty <= 0) return null;
      return sum / qty;
    } catch (e) {
      logger.warn(`getOrderAverageFillPrice failed for ${normalizedSymbol}/${orderId}: ${e?.message || e}`);
      return null;
    }
  }

  /**
   * Place market order
   * CRITICAL FIX: Added parameter validation before submission
   */
  async placeMarketOrder(symbol, side, quantity, positionSide = 'BOTH', reduceOnly = false) {
    const normalizedSymbol = this.normalizeSymbol(symbol);

    const [stepSize, currentPrice, dualSide] = await Promise.all([
      this.getStepSize(normalizedSymbol),
      this.getPrice(normalizedSymbol),
      this.getDualSidePosition()
    ]);

    if (currentPrice === null) {
      throw new Error(`Could not retrieve price for ${normalizedSymbol} to place market order.`);
    }

    // CRITICAL FIX: Format quantity to comply with Binance LOT_SIZE (minQty/maxQty/stepSize)
    const { quantity: formattedQuantity, maxQty } = await this.formatOrderQuantity(normalizedSymbol, quantity);
    if (parseFloat(formattedQuantity) <= 0) {
      throw new Error(`Invalid quantity after formatting: ${formattedQuantity} (original: ${quantity}, stepSize: ${stepSize})`);
    }

    // CRITICAL FIX: Validate order parameters before submission
    const validation = await this.validateOrderParams(normalizedSymbol, side, 'MARKET', parseFloat(formattedQuantity), currentPrice);
    if (!validation.valid) {
      const error = new Error(`Order validation failed: ${validation.errors.join(', ')}`);
      error.validationErrors = validation.errors;
      throw error;
    }

    logger.debug(`Market order: quantity=${formattedQuantity}, price=${currentPrice}`);

    const params = {
      symbol: normalizedSymbol,
      side: side.toUpperCase(),
      type: 'MARKET',
      quantity: formattedQuantity
    };

    // Only add reduceOnly if in hedge mode (dual-side)
    // In one-way mode, closing is done by placing opposite order, reduceOnly not needed/not allowed
    if (reduceOnly && dualSide) {
      params.reduceOnly = 'true';
    }

    // Only include positionSide when account is in dual-side (hedge) mode
    if (dualSide && positionSide && positionSide !== 'BOTH') {
      params.positionSide = positionSide;
    }

    const data = await this.makeRequest('/fapi/v1/order', 'POST', params, true);
    if (!data || !data.orderId) {
      logger.error(`Failed to place market order: Invalid response from Binance`, { data, symbol, side, quantity: formattedQuantity });
      throw new Error(`Invalid order response: ${JSON.stringify(data)}`);
    }
    logger.info(`✅ Market order placed: ${side} ${formattedQuantity} ${symbol} - Order ID: ${data.orderId}`);
    return data;
  }

  /**
   * Place limit order
   * CRITICAL FIX: Added parameter validation before submission and retry logic for tickSize errors
   */
  async placeLimitOrder(symbol, side, quantity, price, positionSide = 'BOTH', timeInForce = 'GTC') {
    const normalizedSymbol = this.normalizeSymbol(symbol);

    // Get precision and account mode
    const [tickSize, dualSide] = await Promise.all([
      this.getTickSize(normalizedSymbol),
      this.getDualSidePosition()
    ]);

    let roundedPrice = this.roundPrice(price, tickSize);
    
    // CRITICAL FIX: Format quantity to comply with Binance LOT_SIZE (minQty/maxQty/stepSize)
    const { quantity: initialFormattedQuantity } = await this.formatOrderQuantity(normalizedSymbol, quantity);
    let formattedQuantity = initialFormattedQuantity;

    if (parseFloat(formattedQuantity) <= 0) {
      throw new Error(`Invalid quantity after formatting: ${formattedQuantity} (original: ${quantity})`);
    }

    if (roundedPrice <= 0) {
      throw new Error(`Invalid price after rounding: ${roundedPrice} (original: ${price}, tickSize: ${tickSize})`);
    }

    // Retry logic: tối đa 2 lần retry khi gặp lỗi tickSize validation
    const maxRetries = 2;
    let lastError = null;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // CRITICAL FIX: Re-round price on retry to ensure exact tickSize multiple
        if (attempt > 0) {
          logger.warn(`[BinanceDirectClient] Retry ${attempt}/${maxRetries} for placeLimitOrder: ${symbol} @ ${roundedPrice} (tickSize: ${tickSize})`);
          // Re-round price to ensure it's exactly a multiple of tickSize
          roundedPrice = this.roundPrice(price, tickSize);
          // Also re-format quantity in case of stepSize issues
          formattedQuantity = this.formatQuantity(quantity, stepSize);
        }

        // CRITICAL FIX: Validate order parameters before submission
        const validation = await this.validateOrderParams(normalizedSymbol, side, 'LIMIT', parseFloat(formattedQuantity), roundedPrice);
        if (!validation.valid) {
          // Check if error is related to tickSize
          const isTickSizeError = validation.errors.some(err => 
            err.includes('tickSize') || err.includes('multiple of')
          );
          
          if (isTickSizeError && attempt < maxRetries) {
            lastError = new Error(`Order validation failed: ${validation.errors.join(', ')}`);
            lastError.validationErrors = validation.errors;
            // Continue to retry
            await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1))); // Small delay before retry
            continue;
          }
          
          // If not tickSize error or max retries reached, throw error
          const error = new Error(`Order validation failed: ${validation.errors.join(', ')}`);
          error.validationErrors = validation.errors;
          throw error;
        }

        const params = {
          symbol: normalizedSymbol,
          side: side.toUpperCase(),
          type: 'LIMIT',
          quantity: formattedQuantity,
          price: roundedPrice.toString(),
          timeInForce
        };

        // Only include positionSide when account is in dual-side (hedge) mode
        if (dualSide && positionSide && positionSide !== 'BOTH') {
          params.positionSide = positionSide;
        }

        const data = await this.makeRequest('/fapi/v1/order', 'POST', params, true);
        if (!data || !data.orderId) {
          logger.error(`Failed to place limit order: Invalid response from Binance`, { data, symbol, side, quantity: formattedQuantity, price: roundedPrice });
          throw new Error(`Invalid order response: ${JSON.stringify(data)}`);
        }
        
        if (attempt > 0) {
          logger.info(`✅ Limit order placed after ${attempt} retry(ies): ${side} ${formattedQuantity} ${symbol} @ ${roundedPrice} - Order ID: ${data.orderId}`);
        } else {
          logger.info(`✅ Limit order placed: ${side} ${formattedQuantity} ${symbol} @ ${roundedPrice} - Order ID: ${data.orderId}`);
        }
        return data;
      } catch (error) {
        lastError = error;
        const errorMsg = error?.message || String(error);
        const isTickSizeError = errorMsg.includes('tickSize') || errorMsg.includes('multiple of');
        
        // Only retry for tickSize errors
        if (isTickSizeError && attempt < maxRetries) {
          logger.warn(`[BinanceDirectClient] TickSize validation error on attempt ${attempt + 1}/${maxRetries + 1}: ${errorMsg}. Retrying...`);
          await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1))); // Small delay before retry
          continue;
        }
        
        // If not tickSize error or max retries reached, throw error
        throw error;
      }
    }
    
    // Should not reach here, but just in case
    if (lastError) {
      throw lastError;
    }
    throw new Error(`Failed to place limit order after ${maxRetries + 1} attempts`);
  }

  /**
   * Get open positions
   */
  async getOpenPositions(symbol = null) {
    const params = symbol ? { symbol: this.normalizeSymbol(symbol) } : {};
    const data = await this.makeRequest('/fapi/v2/positionRisk', 'GET', params, true);
    if(null == data) return 0;
    return data.filter(p => parseFloat(p.positionAmt) !== 0);
  }

  /**
   * Format price according to tickSize
   * @param {number} price - Price to format
   * @param {string} tickSize - Tick size (e.g., "0.10", "0.01")
   * @returns {number} Formatted price
   */
  formatPrice(price, tickSize) {
    const tick = parseFloat(tickSize);
    if (tick === 0) return price;

    const precision = this.getPrecisionFromIncrement(tickSize);

    // CRITICAL FIX: Use more precise rounding to avoid floating point errors
    // Calculate the number of ticks
    const tickCount = Math.round(price / tick);
    // Multiply back to get exact price
    const rounded = tickCount * tick;
    
    // Format to exact precision to avoid floating point issues
    return Number(rounded.toFixed(precision));
  }

  /**
   * Create entry trigger order (STOP_MARKET)
   * For LONG: BUY STOP_MARKET with positionSide=LONG
   * For SHORT: SELL STOP_MARKET with positionSide=SHORT
   * @param {string} symbol - Trading symbol
   * @param {string} side - 'long' or 'short'
   * @param {number} entryPrice - Entry trigger price
   * @param {number} quantity - Order quantity
   * @returns {Promise<Object>} Order response
   */
  async createEntryTriggerOrder(symbol, side, entryPrice, quantity) {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    
    // Get precision info and current price
    const [tickSize, stepSize, currentPrice] = await Promise.all([
      this.getTickSize(normalizedSymbol),
      this.getStepSize(normalizedSymbol),
      this.getPrice(normalizedSymbol)
    ]);
    
    // Format price
    const formattedPrice = this.formatPrice(entryPrice, tickSize);
    
    // Format quantity
    let formattedQuantity = this.formatQuantity(quantity, stepSize);
    
    // Check minimum notional (quantity * stopPrice >= 100 USDT for Binance Futures)
    const minNotional = 100;
    let notional = formattedQuantity * formattedPrice;
    
    // If notional is too small, increase quantity to meet minimum
    if (notional < minNotional) {
      const requiredQuantity = minNotional / formattedPrice;
      formattedQuantity = this.formatQuantity(requiredQuantity, stepSize);
      notional = formattedQuantity * formattedPrice;
      
      // Double check after rounding
      if (notional < minNotional) {
        // Round up one more step
        const step = parseFloat(stepSize);
        formattedQuantity = this.formatQuantity(requiredQuantity + step, stepSize);
        notional = formattedQuantity * formattedPrice;
      }
    }
    
    if (parseFloat(formattedQuantity) <= 0) {
      throw new Error(`Invalid quantity after formatting: ${formattedQuantity} (original: ${quantity}, stepSize: ${stepSize})`);
    }
    
    if (notional < minNotional) {
      throw new Error(`Notional value ${notional.toFixed(2)} USDT is too small. Minimum is ${minNotional} USDT for ${symbol}`);
    }
    
    // Determine order side and position side
    const orderSide = side === 'long' ? 'BUY' : 'SELL';
    const positionSide = side === 'long' ? 'LONG' : 'SHORT';
    
    logger.debug(`Entry trigger order: quantity=${formattedQuantity}, stopPrice=${formattedPrice}, notional=${notional.toFixed(2)} USDT`);
    
    const params = {
      symbol: normalizedSymbol,
      side: orderSide,
      type: 'STOP_MARKET',
      positionSide: positionSide,
      stopPrice: formattedPrice.toString(),
      quantity: formattedQuantity.toString(),
      closePosition: 'false',
      timeInForce: 'GTC'
    };
    
    logger.info(`Creating entry trigger order: ${orderSide} ${formattedQuantity} ${normalizedSymbol} @ ${formattedPrice} (${positionSide})`);
    
    try {
      const data = await this.makeRequestWithRetry('/fapi/v1/order', 'POST', params, true);
      if (!data || !data.orderId) {
        logger.error(`Failed to place entry trigger order: Invalid response from Binance`, { data, symbol: normalizedSymbol, side, entryPrice, quantity: formattedQuantity });
        throw new Error(`Invalid order response: ${JSON.stringify(data)}`);
      }
      logger.info(`✅ Entry trigger order placed: Order ID: ${data.orderId}`);
      return data;
    } catch (error) {
      logger.error(`Failed to create entry trigger order:`, error);
      throw error;
    }
  }

  /**
   * Create Take Profit Limit order
   * @param {string} symbol - Trading symbol
   * @param {string} side - 'long' or 'short' (original position side)
   * @param {number} tpPrice - Take profit price
   * @param {number} quantity - Order quantity (optional, use closePosition=true if not provided)
   * @returns {Promise<Object>} Order response
   */
  async createTpLimitOrder(symbol, side, tpPrice, quantity = null) {
    const normalizedSymbol = this.normalizeSymbol(symbol);

    // Get precision info & account mode
    const [priceTickSize, triggerTickSize, stepSize, dualSide] = await Promise.all([
      this.getTickSize(normalizedSymbol),           // PRICE_FILTER tick for limit price
      this.getTriggerTickSize(normalizedSymbol),    // TRIGGER_ORDER_PRICE_FILTER tick for stopPrice
      this.getStepSize(normalizedSymbol),
      this.getDualSidePosition()
    ]);

    // Use integer step arithmetic per filter
    const priceTick = parseFloat(priceTickSize);
    const triggerTick = parseFloat(triggerTickSize);
    const pricePrecision = this.getPrecisionFromIncrement(priceTickSize);
    const triggerPrecision = this.getPrecisionFromIncrement(triggerTickSize);

    // Compute stop steps/price using triggerTick
    const stopSteps = Math.round(tpPrice / triggerTick);
    const stopNum = stopSteps * triggerTick;
    const stopPriceStr = stopNum.toFixed(triggerPrecision);

    // Compute limit price relative to stop
    // Binance rule (U-M Futures, TP limit):
    // - SELL (closing long): price must be >= stopPrice
    // - BUY (closing short): price must be <= stopPrice
    const isSell = side === 'long';
    let limitNum = isSell ? (stopNum + priceTick) : (stopNum - priceTick);
    // Safety: ensure limit != stop and > 0
    if (limitNum === stopNum) {
      limitNum = isSell ? (stopNum + 2 * priceTick) : (stopNum - 2 * priceTick);
    }
    if (limitNum <= 0) {
      // push away from 0 by one more tick above 0
      limitNum = Math.max(priceTick, stopNum + priceTick);
    }
    const limitPriceStr = limitNum.toFixed(pricePrecision);

    // Safety check to prevent -2021 "Order would immediately trigger"
    // NOTE: For SHORT positions, we allow TP to cross entry (stopNum >= currentPrice) for early loss-cutting
    // This is intentional behavior - trailing TP can move above entry to cut losses early
    const currentPrice = await this.getPrice(normalizedSymbol);
    if (currentPrice) {
      const stopNum = parseFloat(stopPriceStr);
      if (side === 'long' && stopNum <= currentPrice) {
        logger.warn(`[TP-SKIP] TP price ${stopNum} for LONG is at or below current price ${currentPrice}. Skipping order to prevent immediate trigger.`);
        return null;
      }
      // REMOVED: Safety check for SHORT positions
      // We allow TP to be >= currentPrice for SHORT positions to enable early loss-cutting
      // The trailing TP logic intentionally allows TP to cross entry price for SHORT positions
    }

    // Determine position side
    const positionSide = side === 'long' ? 'LONG' : 'SHORT';
    // For TP: long position closes with SELL, short position closes with BUY
    const orderSide = side === 'long' ? 'SELL' : 'BUY';
    
    // Debug logging to verify side is correct
    if (side !== 'long' && side !== 'short') {
      logger.error(`[TP-ERROR] Invalid side value: ${side} (expected 'long' or 'short')`);
    }
    logger.debug(`[TP] Creating TP order: symbol=${normalizedSymbol}, side=${side}, positionSide=${positionSide}, orderSide=${orderSide}, stopPrice=${stopPriceStr}, limitPrice=${limitPriceStr}`);

    const params = {
      symbol: normalizedSymbol,
      side: orderSide,
      type: 'TAKE_PROFIT',
      stopPrice: stopPriceStr, // Trigger price
      price: limitPriceStr, // Limit price (adjusted to be slightly better than stop price)
      closePosition: quantity ? 'false' : 'true',
      timeInForce: 'GTC'
    };

    // Only include positionSide in dual-side (hedge) mode
    if (dualSide) {
      params.positionSide = positionSide;
    }

    // Add quantity if provided
    if (quantity) {
      const formattedQuantity = this.formatQuantity(quantity, stepSize);
      if (parseFloat(formattedQuantity) <= 0) {
        throw new Error(`Invalid quantity after formatting: ${formattedQuantity}`);
      }
      params.quantity = formattedQuantity; // Pass as string
    }

    logger.info(`Creating TP limit order: ${orderSide} ${normalizedSymbol} @ stopPrice=${stopPriceStr}, limitPrice=${limitPriceStr}${dualSide ? ` (${positionSide})` : ''}`);

    try {
      // Try TAKE_PROFIT order type first
      const data = await this.makeRequestWithRetry('/fapi/v1/order', 'POST', params, true);
      if (!data || !data.orderId) {
        logger.error(`Failed to place TP limit order: Invalid response from Binance`, { data, symbol: normalizedSymbol, side, tpPrice, stopPriceStr, limitPriceStr });
        throw new Error(`Invalid order response: ${JSON.stringify(data)}`);
      }
      logger.info(`✅ TP limit order placed: Order ID: ${data.orderId}`);
      return data;
    } catch (error) {
      const errorMsg = error?.message || String(error);
      
      // If TAKE_PROFIT is not supported, fallback to LIMIT order with reduceOnly
      if (errorMsg.includes('-4120') || errorMsg.includes('Order type not supported') || errorMsg.includes('Algo Order API')) {
        logger.warn(`[TP Fallback] TAKE_PROFIT order type not supported, using LIMIT order with reduceOnly instead`);
        
        // Fallback: Use LIMIT order with reduceOnly=true
        // CRITICAL FIX: Must include closePosition=true OR quantity for LIMIT orders
        const fallbackParams = {
          symbol: normalizedSymbol,
          side: orderSide,
          type: 'LIMIT',
          price: limitPriceStr,
          timeInForce: 'GTC',
          reduceOnly: 'true'
        };
        
        // Only include positionSide in dual-side (hedge) mode
        if (dualSide) {
          fallbackParams.positionSide = positionSide;
        }
        
        // If quantity provided, use it; otherwise use closePosition=true
        if (params.quantity) {
          fallbackParams.quantity = params.quantity;
        } else if (quantity) {
          const formattedQuantity = this.formatQuantity(quantity, stepSize);
          if (parseFloat(formattedQuantity) > 0) {
            fallbackParams.quantity = formattedQuantity;
          } else {
            // No valid quantity, use closePosition instead
            fallbackParams.closePosition = 'true';
          }
        } else {
          // No quantity at all, use closePosition
          fallbackParams.closePosition = 'true';
        }
        
        try {
          const fallbackData = await this.makeRequestWithRetry('/fapi/v1/order', 'POST', fallbackParams, true);
          if (!fallbackData || !fallbackData.orderId) {
            logger.error(`Failed to place TP limit order (fallback): Invalid response from Binance`, { data: fallbackData, symbol: normalizedSymbol, side, tpPrice });
            throw new Error(`Invalid order response: ${JSON.stringify(fallbackData)}`);
          }
          logger.info(`✅ TP limit order placed (fallback LIMIT): Order ID: ${fallbackData.orderId}`);
          return fallbackData;
        } catch (fallbackError) {
          logger.error(`Failed to create TP limit order (fallback also failed):`, {
            error: fallbackError?.message || String(fallbackError),
            symbol: normalizedSymbol,
            side,
            params: this.sanitizeParams(fallbackParams)
          });
          throw fallbackError;
        }
      }
      
      // For other errors, log and throw
      logger.error(`Failed to create TP limit order:`, {
        error: errorMsg,
        symbol: normalizedSymbol,
        side,
        priceTickSize,
        triggerTickSize,
        stepSize,
        tpPrice,
        stopPriceStr,
        limitPriceStr,
        params: this.sanitizeParams(params)
      });
      throw error;
    }
  }

  /**
   * Create Stop Loss Limit order
   * @param {string} symbol - Trading symbol
   * @param {string} side - 'long' or 'short' (original position side)
   * @param {number} slPrice - Stop loss price
   * @param {number} quantity - Order quantity (optional, use closePosition=true if not provided)
   * @returns {Promise<Object>} Order response
   */
  async createSlLimitOrder(symbol, side, slPrice, quantity = null) {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    
    // Get precision info & account mode
    const [tickSize, stepSize, dualSide] = await Promise.all([
      this.getTickSize(normalizedSymbol),
      this.getStepSize(normalizedSymbol),
      this.getDualSidePosition()
    ]);
    
    // Fetch price bounds to avoid -4016 / -4024 (price outside allowed band)
    const [priceFilter, triggerFilter, percentBand, markPrice] = await Promise.all([
      this.getPriceFilter(normalizedSymbol),
      this.getTriggerOrderPriceFilter(normalizedSymbol),
      this.getPercentPriceBand(normalizedSymbol, side === 'long' ? 'SELL' : 'BUY'),
      this.getPrice(normalizedSymbol)
    ]);

    const clampPrice = (val, filter) => {
      const minP = parseFloat(filter?.minPrice || '0');
      const maxP = parseFloat(filter?.maxPrice || '0');
      let v = parseFloat(val);
      if (minP > 0 && v < minP) v = minP;
      if (maxP > 0 && v > maxP) v = maxP;
      return v;
    };

    // Format stop price (trigger price) with trigger filter bounds
    let stopPrice = this.formatPrice(slPrice, triggerFilter?.tickSize || tickSize);
    stopPrice = this.formatPrice(clampPrice(stopPrice, triggerFilter), triggerFilter?.tickSize || tickSize);
    
    // For STOP (stop loss) orders, use the same rule as TP: set limit slightly worse to increase fill probability
    // SELL orders: limit price slightly lower than stop
    // BUY orders: limit price slightly higher than stop
    const tick = parseFloat(tickSize);
    let limitPrice;
    const orderSideForSl = side === 'long' ? 'SELL' : 'BUY';
    if (orderSideForSl === 'SELL') {
      // SELL: set limit below stop
      limitPrice = this.formatPrice(stopPrice - tick, priceFilter?.tickSize || tickSize);
    } else {
      // BUY: set limit above stop
      limitPrice = this.formatPrice(stopPrice + tick, priceFilter?.tickSize || tickSize);
    }

    // Apply percent price protection band FIRST (uses mark price) - this is the strictest constraint
    if (markPrice && percentBand) {
      const mp = parseFloat(markPrice);
      if (mp > 0) {
        const bandMin = percentBand.down ? mp * percentBand.down : null;
        const bandMax = percentBand.up ? mp * percentBand.up : null;
        if (bandMin && limitPrice < bandMin) {
          logger.warn(
            `[SL Clamp] Limit price ${limitPrice} below percent band min ${bandMin.toFixed(8)} for ${normalizedSymbol}, clamping`
          );
          limitPrice = this.formatPrice(bandMin, priceFilter?.tickSize || tickSize);
        }
        if (bandMax && limitPrice > bandMax) {
          logger.warn(
            `[SL Clamp] Limit price ${limitPrice} above percent band max ${bandMax.toFixed(8)} for ${normalizedSymbol}, clamping`
          );
          limitPrice = this.formatPrice(bandMax, priceFilter?.tickSize || tickSize);
        }
      }
    }

    // Then clamp to PRICE_FILTER bounds (minPrice/maxPrice)
    const clampedLimit = clampPrice(limitPrice, priceFilter);
    if (Math.abs(clampedLimit - limitPrice) > parseFloat(priceFilter?.tickSize || tickSize) * 0.1) {
      logger.warn(
        `[SL Clamp] Limit price ${limitPrice} clamped to ${clampedLimit.toFixed(8)} for ${normalizedSymbol} ` +
        `(min=${priceFilter?.minPrice || 'N/A'}, max=${priceFilter?.maxPrice || 'N/A'})`
      );
    }
    limitPrice = this.formatPrice(clampedLimit, priceFilter?.tickSize || tickSize);
    
    // CRITICAL: After formatPrice, ensure price is still within bounds (formatPrice may round up)
    const maxP = parseFloat(priceFilter?.maxPrice || '0');
    const minP = parseFloat(priceFilter?.minPrice || '0');
    const formattedLimitNum = parseFloat(limitPrice);
    if (maxP > 0 && formattedLimitNum > maxP) {
      // formatPrice rounded up too much, use maxPrice directly
      logger.warn(
        `[SL Clamp] Formatted limit price ${limitPrice} exceeds maxPrice ${maxP.toFixed(8)} for ${normalizedSymbol}, using maxPrice`
      );
      limitPrice = String(maxP);
    }
    if (minP > 0 && formattedLimitNum < minP) {
      // formatPrice rounded down too much, use minPrice directly
      logger.warn(
        `[SL Clamp] Formatted limit price ${limitPrice} below minPrice ${minP.toFixed(8)} for ${normalizedSymbol}, using minPrice`
      );
      limitPrice = String(minP);
    }

    // Ensure directional relationship still holds after clamping
    // SELL: limit must be < stop; BUY: limit must be > stop
    if (orderSideForSl === 'SELL' && limitPrice >= stopPrice) {
      // Try to set limit just below stop, but respect price bounds
      const targetLimit = parseFloat(stopPrice) - tick;
      const clampedTarget = clampPrice(targetLimit, priceFilter);
      if (markPrice && percentBand) {
        const mp = parseFloat(markPrice);
        if (mp > 0) {
          const bandMin = percentBand.down ? mp * percentBand.down : null;
          if (bandMin && clampedTarget < bandMin) {
            logger.warn(
              `[SL Clamp] Cannot maintain SELL limit < stop relationship for ${normalizedSymbol} ` +
              `(stop=${stopPrice}, would need limit < ${stopPrice} but min allowed=${bandMin.toFixed(8)})`
            );
            // Use minimum allowed price
            limitPrice = this.formatPrice(bandMin, priceFilter?.tickSize || tickSize);
          } else {
            limitPrice = this.formatPrice(clampedTarget, priceFilter?.tickSize || tickSize);
          }
        }
      } else {
        limitPrice = this.formatPrice(clampedTarget, priceFilter?.tickSize || tickSize);
      }
    }
    if (orderSideForSl === 'BUY' && limitPrice <= stopPrice) {
      // Try to set limit just above stop, but respect price bounds
      const targetLimit = parseFloat(stopPrice) + tick;
      const clampedTarget = clampPrice(targetLimit, priceFilter);
      if (markPrice && percentBand) {
        const mp = parseFloat(markPrice);
        if (mp > 0) {
          const bandMax = percentBand.up ? mp * percentBand.up : null;
          if (bandMax && clampedTarget > bandMax) {
            logger.warn(
              `[SL Clamp] Cannot maintain BUY limit > stop relationship for ${normalizedSymbol} ` +
              `(stop=${stopPrice}, would need limit > ${stopPrice} but max allowed=${bandMax.toFixed(8)})`
            );
            // Use maximum allowed price
            limitPrice = this.formatPrice(bandMax, priceFilter?.tickSize || tickSize);
          } else {
            limitPrice = this.formatPrice(clampedTarget, priceFilter?.tickSize || tickSize);
          }
        }
      } else {
        limitPrice = this.formatPrice(clampedTarget, priceFilter?.tickSize || tickSize);
      }
    }
    
    // Determine position side
    const positionSide = side === 'long' ? 'LONG' : 'SHORT';
    // For SL: long position closes with SELL, short position closes with BUY
    const orderSide = side === 'long' ? 'SELL' : 'BUY';
    
    const params = {
      symbol: normalizedSymbol,
      side: orderSide,
      type: 'STOP',
      stopPrice: stopPrice.toString(), // Trigger price (when price reaches this, order activates)
      price: limitPrice.toString(), // Limit price (adjusted to be slightly better than stop price)
      timeInForce: 'GTC'
    };

    // Only include positionSide in dual-side (hedge) mode
    if (dualSide) {
      params.positionSide = positionSide;
    }
    
    // Add quantity if provided
    if (quantity) {
      const formattedQuantity = this.formatQuantity(quantity, stepSize);
      if (parseFloat(formattedQuantity) <= 0) {
        throw new Error(`Invalid quantity after formatting: ${formattedQuantity}`);
      }
      params.quantity = formattedQuantity; // Pass as string
      params.closePosition = 'false';
      // NOTE: Do NOT set reduceOnly when quantity is provided for STOP orders
      // Binance will automatically treat it as reduce-only based on positionSide
    } else {
      // No quantity: use closePosition=true (and optionally reduceOnly for -4400 compliance)
      params.closePosition = 'true';
      // For STOP orders with closePosition, reduceOnly may not be needed/allowed
      // Only set it if Binance requires it (e.g., during -4400 quant rule windows)
      // For now, don't set it to avoid -1106 error
    }
    
    // Safety check to prevent -2021 "Order would immediately trigger"
    const currentPrice = await this.getPrice(normalizedSymbol);
    if (currentPrice) {
      const stopNum = parseFloat(stopPrice);
      if (side === 'long' && stopNum >= currentPrice) {
        logger.warn(`[SL-SKIP] SL price ${stopNum} for LONG is at or above current price ${currentPrice}. Skipping order to prevent immediate trigger.`);
        return null;
      }
      if (side === 'short' && stopNum <= currentPrice) {
        logger.warn(`[SL-SKIP] SL price ${stopNum} for SHORT is at or below current price ${currentPrice}. Skipping order to prevent immediate trigger.`);
        return null;
      }
    }
    
    logger.info(`Creating SL limit order: ${orderSide} ${normalizedSymbol} @ stopPrice=${stopPrice}, limitPrice=${limitPrice}${dualSide ? ` (${positionSide})` : ''}`);
    
    try {
      const data = await this.makeRequestWithRetry('/fapi/v1/order', 'POST', params, true);
      if (!data || !data.orderId) {
        logger.error(`Failed to place SL limit order: Invalid response from Binance`, { data, symbol: normalizedSymbol, side, slPrice, stopPrice, limitPrice });
        throw new Error(`Invalid order response: ${JSON.stringify(data)}`);
      }
      logger.info(`✅ SL limit order placed: Order ID: ${data.orderId}`);
      return data;
    } catch (error) {
      const errorMsg = error?.message || String(error);
      const errorCode = error?.code || error?.status;
      
      // Debug logging
      logger.debug(
        `[createSlLimitOrder] Error caught | symbol=${normalizedSymbol} ` +
        `errorCode=${errorCode} errorMsg=${errorMsg.substring(0, 100)}`
      );
      
      // Handle -4120: Order type not supported → fallback to LIMIT order with reduceOnly
      if (errorCode === -4120 || errorCode === '-4120' || errorMsg.includes('-4120') || errorMsg.includes('Order type not supported') || errorMsg.includes('Algo Order API')) {
        logger.warn(
          `[SL Fallback] STOP order type not supported for ${normalizedSymbol}, ` +
          `using LIMIT order with reduceOnly instead | errorCode=${errorCode}`
        );
        
        // Fallback: Use LIMIT order
        const fallbackParams = {
          symbol: normalizedSymbol,
          side: orderSide,
          type: 'LIMIT',
          price: limitPrice.toString(),
          timeInForce: 'GTC'
        };
        
        if (dualSide) {
          fallbackParams.positionSide = positionSide;
        }
        
        if (quantity) {
          const formattedQuantity = this.formatQuantity(quantity, stepSize);
          if (parseFloat(formattedQuantity) > 0) {
            fallbackParams.quantity = formattedQuantity;
            // For LIMIT orders with quantity, set reduceOnly to comply with -4400 quant rules
            // Binance allows reduceOnly with quantity for LIMIT orders
            fallbackParams.reduceOnly = 'true';
          }
        } else {
          fallbackParams.closePosition = 'true';
          // Do NOT set reduceOnly when using closePosition (Binance doesn't allow both)
        }
        
        try {
          const fallbackData = await this.makeRequestWithRetry('/fapi/v1/order', 'POST', fallbackParams, true);
          if (!fallbackData || !fallbackData.orderId) {
            logger.error(`Failed to place SL limit order (fallback): Invalid response from Binance`, { data: fallbackData, symbol: normalizedSymbol, side, slPrice });
            throw new Error(`Invalid order response: ${JSON.stringify(fallbackData)}`);
          }
          logger.info(`✅ SL limit order placed (fallback LIMIT): Order ID: ${fallbackData.orderId}`);
          return fallbackData;
        } catch (fallbackError) {
          logger.error(`Failed to create SL limit order (fallback also failed):`, {
            error: fallbackError?.message || String(fallbackError),
            symbol: normalizedSymbol,
            side,
            params: this.sanitizeParams(fallbackParams)
          });
          throw fallbackError;
        }
      }
      
      // For other errors, log and throw
      logger.error(`Failed to create SL limit order:`, {
        error: errorMsg,
        symbol: normalizedSymbol,
        side,
        slPrice,
        stopPrice,
        limitPrice,
        params: this.sanitizeParams(params)
      });
      throw error;
    }
  }

  /**
   * Make request with retry logic for 5xx errors
   * @param {string} endpoint - API endpoint
   * @param {string} method - HTTP method
   * @param {Object} params - Request parameters
   * @param {boolean} requiresAuth - Whether authentication is required
   * @param {number} retries - Number of retries remaining
   * @returns {Promise<Object>} Response data
   */
  async makeRequestWithRetry(endpoint, method = 'GET', params = {}, requiresAuth = false, retries = 3) {
    // Disable retry for order operations to avoid duplicate orders
    const isOrderEndpoint = endpoint.includes('/fapi/v1/order') || endpoint.includes('/fapi/v1/allOpenOrders');
    if (isOrderEndpoint) {
      retries = 0; // No retry for order operations
    }
    
    try {
      return await this.makeRequest(endpoint, method, params, requiresAuth);
    } catch (error) {
      // Check if it's a 5xx error and we have retries left
      if (retries > 0 && error.message?.match(/HTTP 5\d{2}/)) {
        logger.warn(`Request failed with 5xx error, retrying... (${retries} retries left)`);
        await new Promise(resolve => setTimeout(resolve, 1000 * (4 - retries))); // Exponential backoff
        return this.makeRequestWithRetry(endpoint, method, params, requiresAuth, retries - 1);
      }
      
      // Handle common Binance errors
      if (error.message?.includes('-4061')) {
        throw new Error('Position side mismatch. Please check your account position mode settings.');
      }
      if (error.message?.includes('-1111')) {
        throw new Error('Precision error. Price or quantity format is incorrect.');
      }
      if (error.message?.includes('-2019')) {
        // Margin insufficient - log clearly but don't modify error message (caller needs to handle)
        logger.error(
          `[Binance] ❌ Margin insufficient (-2019) | endpoint=${endpoint} ` +
          `symbol=${params?.symbol || 'N/A'} side=${params?.side || 'N/A'} ` +
          `type=${params?.type || 'N/A'} amount=${params?.quantity || params?.amount || 'N/A'}`
        );
        // Keep original error message for caller to handle
        throw error;
      }
      
      throw error;
    }
  }

  /**
   * Cancel order by orderId
   */
  async cancelAllOpenOrders(symbol) {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    logger.info(`[BinanceDirectClient] Cancelling all open orders for ${normalizedSymbol}...`);
    return await this.makeRequest('/fapi/v1/allOpenOrders', 'DELETE', { symbol: normalizedSymbol }, true);
  }

  /**
   * List open orders for a symbol
   */
  async getOpenOrders(symbol) {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    return await this.makeRequest('/fapi/v1/openOrders', 'GET', { symbol: normalizedSymbol }, true);
  }

  /**
   * Create CLOSE-POSITION STOP_MARKET
   * LONG closes with SELL; SHORT closes with BUY.
   */
  async createCloseStopMarket(symbol, side, stopPrice, position = null, bot = null) {
    const normalizedSymbol = this.normalizeSymbol(symbol);

    const [tickSize, dualSide, currentPrice] = await Promise.all([
      this.getTickSize(normalizedSymbol),
      this.getDualSidePosition(),
      this.getPrice(normalizedSymbol)
    ]);

    const formattedStop = this.formatPrice(stopPrice, tickSize);
    const orderSide = side === 'long' ? 'SELL' : 'BUY';
    const positionSide = side === 'long' ? 'LONG' : 'SHORT';

    // Validate side vs market to avoid -2021
    let finalStop = formattedStop;
    const nudgePct = 0.005;
    if (Number.isFinite(currentPrice) && currentPrice > 0) {
      if (side === 'long' && finalStop >= currentPrice) {
        finalStop = this.formatPrice(currentPrice * (1 - nudgePct), tickSize);
      }
      if (side === 'short' && finalStop <= currentPrice) {
        finalStop = this.formatPrice(currentPrice * (1 + nudgePct), tickSize);
      }
    }

    const params = {
      symbol: normalizedSymbol,
      side: orderSide,
      type: 'STOP_MARKET',
      stopPrice: String(finalStop),
      closePosition: 'true',
      timeInForce: 'GTC',
      workingType: 'MARK_PRICE' // Use MARK_PRICE for better trigger accuracy
    };

    // Add deterministic clientOrderId to reliably map WS fills back to DB position
    // Format: OC_B{botId}_P{positionId}_EXIT / _SL
    try {
      const botId = bot?.id;
      const posId = position?.id;
      if (botId && posId) {
        params.newClientOrderId = `OC_B${botId}_P${posId}_EXIT`;
      }
    } catch (_) {}

    if (dualSide) params.positionSide = positionSide;

    // CRITICAL FIX: TP/SL orders use standard /fapi/v1/order endpoint
    // DO NOT use algoOrder endpoint or algoType parameter for regular TP/SL orders
    // algoOrder endpoint is only for OCO, trailing stop, etc.
    try {
    return await this.makeRequestWithRetry('/fapi/v1/order', 'POST', params, true);
    } catch (error) {
      const errorMsg = error?.message || String(error);
      const errorCode = error?.code || error?.status;
      
      // Handle -4120: Order type not supported → fallback to MARKET order with reduceOnly
      if (errorCode === -4120 || errorCode === '-4120' || errorMsg.includes('-4120') || errorMsg.includes('Order type not supported') || errorMsg.includes('Algo Order API')) {
        logger.warn(
          `[SL Fallback] STOP_MARKET order type not supported for ${normalizedSymbol}, ` +
          `using MARKET order with reduceOnly instead | pos=${position?.id || 'N/A'}`
        );
        
        // Fallback: Use MARKET order with reduceOnly=true to close position
        const fallbackParams = {
          symbol: normalizedSymbol,
          side: orderSide,
          type: 'MARKET',
          closePosition: 'true'
        };
        
        if (dualSide) {
          fallbackParams.positionSide = positionSide;
        }
        
        // Add clientOrderId if available
        try {
          const botId = bot?.id;
          const posId = position?.id;
          if (botId && posId) {
            fallbackParams.newClientOrderId = `OC_B${botId}_P${posId}_SL_FB`;
          }
        } catch (_) {}
        
        try {
          const fallbackData = await this.makeRequestWithRetry('/fapi/v1/order', 'POST', fallbackParams, true);
          logger.info(
            `[SL Fallback] ✅ MARKET order placed (fallback) | pos=${position?.id || 'N/A'} ` +
            `orderId=${fallbackData?.orderId || 'N/A'}`
          );
          return fallbackData;
        } catch (fallbackError) {
          logger.error(
            `[SL Fallback] ❌ Failed to create MARKET order (fallback) | pos=${position?.id || 'N/A'} ` +
            `error=${fallbackError?.message || fallbackError}`
          );
          throw fallbackError;
        }
      }
      
      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Create CLOSE-POSITION TAKE_PROFIT_MARKET
   * LONG closes with SELL; SHORT closes with BUY.
   */
  async createCloseTakeProfitMarket(symbol, side, stopPrice, position = null, bot = null) {
    const normalizedSymbol = this.normalizeSymbol(symbol);

    const [tickSize, dualSide, currentPrice] = await Promise.all([
      this.getTickSize(normalizedSymbol),
      this.getDualSidePosition(),
      this.getPrice(normalizedSymbol)
    ]);

    const formattedStop = this.formatPrice(stopPrice, tickSize);
    const orderSide = side === 'long' ? 'SELL' : 'BUY';
    const positionSide = side === 'long' ? 'LONG' : 'SHORT';

    // Validate side vs market to avoid -2021
    let finalStop = formattedStop;
    const nudgePct = 0.005;
    if (Number.isFinite(currentPrice) && currentPrice > 0) {
      // TAKE_PROFIT_MARKET trigger direction is opposite of STOP_MARKET
      if (side === 'long' && finalStop <= currentPrice) {
        finalStop = this.formatPrice(currentPrice * (1 + nudgePct), tickSize);
      }
      if (side === 'short' && finalStop >= currentPrice) {
        finalStop = this.formatPrice(currentPrice * (1 - nudgePct), tickSize);
      }
    }

    const params = {
      symbol: normalizedSymbol,
      side: orderSide,
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: String(finalStop),
      closePosition: 'true',
      timeInForce: 'GTC',
      workingType: 'MARK_PRICE' // Use MARK_PRICE for better trigger accuracy
    };

    // Add deterministic clientOrderId to reliably map WS fills back to DB position
    // Format: OC_B{botId}_P{positionId}_TP
    try {
      const botId = bot?.id;
      const posId = position?.id;
      if (botId && posId) {
        params.newClientOrderId = `OC_B${botId}_P${posId}_TP`;
      }
    } catch (_) {}

    if (dualSide) params.positionSide = positionSide;

    // CRITICAL FIX: TP/SL orders use standard /fapi/v1/order endpoint
    // DO NOT use algoOrder endpoint or algoType parameter for regular TP/SL orders
    // algoOrder endpoint is only for OCO, trailing stop, etc.
    try {
    return await this.makeRequestWithRetry('/fapi/v1/order', 'POST', params, true);
    } catch (error) {
      const errorMsg = error?.message || String(error);
      const errorCode = error?.code || error?.status;
      
      // Handle -4120: Order type not supported → fallback to LIMIT order with reduceOnly
      if (errorCode === -4120 || errorCode === '-4120' || errorMsg.includes('-4120') || errorMsg.includes('Order type not supported') || errorMsg.includes('Algo Order API')) {
        logger.warn(
          `[TP Fallback] TAKE_PROFIT_MARKET order type not supported for ${normalizedSymbol}, ` +
          `using LIMIT order with reduceOnly instead | pos=${position?.id || 'N/A'} stopPrice=${finalStop}`
        );
        
        // Fallback: Use LIMIT order. Must include EITHER quantity or closePosition=true.
        // IMPORTANT: Binance does not allow reduceOnly together with closePosition=true.
        const fallbackParams = {
          symbol: normalizedSymbol,
          side: orderSide,
          type: 'LIMIT',
          price: String(finalStop),
          timeInForce: 'GTC'
        };
        
        if (dualSide) {
          fallbackParams.positionSide = positionSide;
        }
        
        // Add clientOrderId if available
        try {
          const botId = bot?.id;
          const posId = position?.id;
          if (botId && posId) {
            fallbackParams.newClientOrderId = `OC_B${botId}_P${posId}_TP_FB`;
          }
        } catch (_) {}

        // Quantity handling:
        // - Prefer an explicit quantity and set reduceOnly=true (Binance rejects LIMIT + closePosition=true with -4136)
        // - As a fallback, try to fetch current position size from the exchange
        // - Only if everything fails, we will fall back to closePosition=true (may be rejected, but we log and surface)
        let fallbackQuantity = params.quantity;
        try {
          if (!fallbackQuantity && position) {
            const stepSize = await this.getStepSize(normalizedSymbol);
            const openPositions = await this.getOpenPositions(normalizedSymbol);
            const posSideFilter = dualSide ? positionSide : null;
            const posMatch = Array.isArray(openPositions)
              ? openPositions.find(
                  p =>
                    p.symbol === normalizedSymbol &&
                    (posSideFilter ? p.positionSide === posSideFilter : true) &&
                    Math.abs(parseFloat(p.positionAmt || 0)) > 0
                )
              : null;
            if (posMatch) {
              const posAmt = Math.abs(parseFloat(posMatch.positionAmt || 0));
              fallbackQuantity = this.formatQuantity(posAmt, stepSize);
            }
          }
        } catch (qtyErr) {
          logger.warn(`[TP Fallback] Unable to derive quantity for LIMIT fallback | pos=${position?.id || 'N/A'} error=${qtyErr?.message || qtyErr}`);
        }

        if (fallbackQuantity) {
          fallbackParams.quantity = fallbackQuantity;
          fallbackParams.reduceOnly = 'true';
        } else {
          // Last resort: closePosition=true (may be rejected with -4136, but we surface the error)
          fallbackParams.closePosition = 'true';
        }
        
        try {
          const fallbackData = await this.makeRequestWithRetry('/fapi/v1/order', 'POST', fallbackParams, true);
          logger.info(
            `[TP Fallback] ✅ LIMIT order placed (fallback) | pos=${position?.id || 'N/A'} ` +
            `orderId=${fallbackData?.orderId || 'N/A'} price=${finalStop}`
          );
          return fallbackData;
        } catch (fallbackError) {
          logger.error(
            `[TP Fallback] ❌ Failed to create LIMIT order (fallback) | pos=${position?.id || 'N/A'} ` +
            `error=${fallbackError?.message || fallbackError}`
          );
          throw fallbackError;
        }
      }
      
      // Re-throw other errors
      throw error;
    }
  }

  async cancelOrder(symbol, orderId) {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const params = { symbol: normalizedSymbol, orderId: orderId };
    const data = await this.makeRequestWithRetry('/fapi/v1/order', 'DELETE', params, true);
    return data;
  }

  /**
   * Get order status
   */
  async getOrder(symbol, orderId) {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const params = { symbol: normalizedSymbol, orderId: orderId };
    const data = await this.makeRequest('/fapi/v1/order', 'GET', params, true);
    return data; // contains status: NEW|PARTIALLY_FILLED|FILLED|CANCELED|EXPIRED
  }

  sanitizeParams(params) {
    if (!params) return params;
    const clone = { ...params };
    if (clone.signature) delete clone.signature;
    if (clone.timestamp) delete clone.timestamp;
    return clone;
  }
}

