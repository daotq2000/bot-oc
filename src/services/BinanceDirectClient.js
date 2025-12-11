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
    
    // Load all config values from database with defaults
    this.restPriceFallbackCooldownMs = Number(configService.getNumber('BINANCE_REST_PRICE_COOLDOWN_MS', 5000));
    this.minRequestInterval = Number(configService.getNumber('BINANCE_MIN_REQUEST_INTERVAL_MS', 100));
    
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
    // Rate limiting: ensure minimum interval between requests
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.minRequestInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest));
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
    
    const timeout = configService.getNumber('BINANCE_REQUEST_TIMEOUT_MS', 10000);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url.toString(), {
        method,
        headers: {
          'Content-Type': 'application/json'
        },
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(`HTTP ${response.status}: ${errorText}`);
        
        // For invalid symbol status, log as debug instead of error to reduce spam
        if (errorText.includes('Invalid symbol status') || errorText.includes('-1122')) {
          logger.debug(`Market data request failed (invalid symbol): ${endpoint} - ${errorText}`);
        } else {
          logger.error(`❌ Market data request failed: ${endpoint}`, errorText);
        }
        
        throw error;
      }
      
      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      // Don't log again if already logged above
      if (!error.message?.includes('HTTP')) {
        logger.error(`❌ Market data request failed: ${endpoint}`, error.message);
      }
      throw error;
    }
  }

  /**
   * Make PUBLIC request against TRADING baseURL (used for testnet exchangeInfo without auth)
   */
  async makeTradingPublicRequest(endpoint, method = 'GET', params = {}) {
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
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
    return await response.json();
  }

  /**
   * Make request for TRADING operations (uses testnet or production based on config)
   */
  async makeRequest(endpoint, method = 'GET', params = {}, requiresAuth = false, retries = 3) {
    // Rate limiting
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.minRequestInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest));
    }
    this.lastRequestTime = Date.now();

    const url = `${this.baseURL}${endpoint}`;
    const timestamp = Date.now();
    
    let queryString = '';
    let requestBody = null;
    
    // Authentication với API key và secret
    if (requiresAuth) {
      const authParams = { ...params, timestamp };
      
      if (method === 'GET') {
        const sortedParams = Object.keys(authParams)
          .sort()
          .map(key => `${key}=${authParams[key]}`)
          .join('&');
        
        const signature = crypto
          .createHmac('sha256', this.secretKey)
          .update(sortedParams)
          .digest('hex');
        
        queryString = '?' + sortedParams + '&signature=' + signature;
      } else {
        // POST requests
        requestBody = new URLSearchParams(authParams).toString();
        const signature = crypto
          .createHmac('sha256', this.secretKey)
          .update(requestBody)
          .digest('hex');
        requestBody += '&signature=' + signature;
      }
    } else {
      // No auth, just add params to query string
      if (Object.keys(params).length > 0) {
        queryString = '?' + new URLSearchParams(params).toString();
      }
    }
    
    const timeout = configService.getNumber('BINANCE_REQUEST_TIMEOUT_MS', 10000);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded'
    };
    
    if (requiresAuth) {
      headers['X-MBX-APIKEY'] = this.apiKey;
    }
    
    // Make request with retries
    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(url + queryString, {
          method,
          headers,
          body: requestBody,
          signal: controller.signal
        });

        clearTimeout(timeoutId);
        
        const data = await response.json();
        
        if (!response.ok) {
          if (data.code && data.msg) {
            if (data.code === -1111) {
              logger.error('Binance precision rejection', {
                endpoint,
                params: this.sanitizeParams(params),
                response: data
              });
            }
            throw new Error(`Binance API Error ${data.code}: ${data.msg}`);
          }
          throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
        }
        
        return data;
      } catch (error) {
        clearTimeout(timeoutId);
        if (i === retries - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // Exponential backoff
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

    // Get price exclusively from WebSocket cache
    const cachedPrice = webSocketManager.getPrice(normalizedSymbol);
    if (cachedPrice) {
      return cachedPrice;
    }

    // Respect cooldown when reusing REST fallback price
    const fallbackEntry = this.restPriceFallbackCache.get(normalizedSymbol);
    const now = Date.now();
    if (fallbackEntry && now - fallbackEntry.timestamp < this.restPriceFallbackCooldownMs) {
      return fallbackEntry.price;
    }

    try {
      const ticker = await this.makeMarketDataRequest('/fapi/v1/ticker/price', 'GET', { symbol: normalizedSymbol });
      const restPrice = parseFloat(ticker?.price);
      if (Number.isFinite(restPrice) && restPrice > 0) {
        this.restPriceFallbackCache.set(normalizedSymbol, { price: restPrice, timestamp: now });
        logger.warn(`Price for ${normalizedSymbol} not in WebSocket cache. Using REST fallback price ${restPrice}.`);
        return restPrice;
      }
    } catch (error) {
      logger.error(`Failed REST fallback price fetch for ${normalizedSymbol}:`, error.message || error);
    }

    logger.warn(`Price for ${normalizedSymbol} not found via WebSocket or REST fallback.`);
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
    
    // Try to get from cache first
    if (this.exchangeInfoService) {
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
  
    // Round to nearest tick
    const rounded = Math.round(price / tick) * tick;
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

    const formattedQuantity = this.formatQuantity(quantity, stepSize);
    if (parseFloat(formattedQuantity) <= 0) {
      throw new Error(`Invalid quantity after formatting: ${formattedQuantity} (original: ${quantity}, stepSize: ${stepSize})`);
    }

    logger.debug(`Market order: quantity=${formattedQuantity}, price=${currentPrice}`);

    const params = {
      symbol: normalizedSymbol,
      side: side.toUpperCase(),
      type: 'MARKET',
      quantity: formattedQuantity
    };

    if (reduceOnly) {
      params.reduceOnly = 'true';
    }

    // Only include positionSide when account is in dual-side (hedge) mode
    if (dualSide && positionSide && positionSide !== 'BOTH') {
      params.positionSide = positionSide;
    }

    const data = await this.makeRequest('/fapi/v1/order', 'POST', params, true);
    logger.info(`✅ Market order placed: ${side} ${formattedQuantity} ${symbol} - Order ID: ${data.orderId}`);
    return data;
  }

  /**
   * Place limit order
   */
  async placeLimitOrder(symbol, side, quantity, price, positionSide = 'BOTH', timeInForce = 'GTC') {
    const normalizedSymbol = this.normalizeSymbol(symbol);

    // Get precision and account mode
    const [tickSize, stepSize, dualSide] = await Promise.all([
      this.getTickSize(normalizedSymbol),
      this.getStepSize(normalizedSymbol),
      this.getDualSidePosition()
    ]);

    const roundedPrice = this.roundPrice(price, tickSize);
    const formattedQuantity = this.formatQuantity(quantity, stepSize);

    if (parseFloat(formattedQuantity) <= 0) {
      throw new Error(`Invalid quantity after formatting: ${formattedQuantity} (original: ${quantity}, stepSize: ${stepSize})`);
    }

    if (roundedPrice <= 0) {
      throw new Error(`Invalid price after rounding: ${roundedPrice} (original: ${price}, tickSize: ${tickSize})`);
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
    logger.info(`✅ Limit order placed: ${side} ${formattedQuantity} ${symbol} @ ${roundedPrice} - Order ID: ${data.orderId}`);
    return data;
  }

  /**
   * Get open positions
   */
  async getOpenPositions(symbol = null) {
    const params = symbol ? { symbol: this.normalizeSymbol(symbol) } : {};
    const data = await this.makeRequest('/fapi/v2/positionRisk', 'GET', params, true);
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

    // Round to nearest tick
    const rounded = Math.round(price / tick) * tick;
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
    const [tickSize, stepSize, dualSide] = await Promise.all([
      this.getTickSize(normalizedSymbol),
      this.getStepSize(normalizedSymbol),
      this.getDualSidePosition()
    ]);

    // Format price
    const formattedPrice = this.formatPrice(tpPrice, tickSize);

    // Safety check to prevent -2021 "Order would immediately trigger"
    const currentPrice = await this.getPrice(normalizedSymbol);
    if (currentPrice) {
      if (side === 'long' && formattedPrice <= currentPrice) {
        logger.warn(`[TP-SKIP] TP price ${formattedPrice} for LONG is at or below current price ${currentPrice}. Skipping order to prevent immediate trigger.`);
        return null;
      }
      if (side === 'short' && formattedPrice >= currentPrice) {
        logger.warn(`[TP-SKIP] TP price ${formattedPrice} for SHORT is at or above current price ${currentPrice}. Skipping order to prevent immediate trigger.`);
        return null;
      }
    }

    // Determine position side
    const positionSide = side === 'long' ? 'LONG' : 'SHORT';
    // For TP: long position closes with SELL, short position closes with BUY
    const orderSide = side === 'long' ? 'SELL' : 'BUY';

    const params = {
      symbol: normalizedSymbol,
      side: orderSide,
      type: 'TAKE_PROFIT',
      stopPrice: formattedPrice.toString(), // Trigger price
      price: formattedPrice.toString(), // Limit price
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

    logger.info(`Creating TP limit order: ${orderSide} ${normalizedSymbol} @ ${formattedPrice}${dualSide ? ` (${positionSide})` : ''}`);

    try {
      const data = await this.makeRequestWithRetry('/fapi/v1/order', 'POST', params, true);
      logger.info(`✅ TP limit order placed: Order ID: ${data.orderId}`);
      return data;
    } catch (error) {
      logger.error(`Failed to create TP limit order:`, error);
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
    
    // Format price
    const formattedPrice = this.formatPrice(slPrice, tickSize);
    
    // Determine position side
    const positionSide = side === 'long' ? 'LONG' : 'SHORT';
    // For SL: long position closes with SELL, short position closes with BUY
    const orderSide = side === 'long' ? 'SELL' : 'BUY';
    
    const params = {
      symbol: normalizedSymbol,
      side: orderSide,
      type: 'STOP',
      stopPrice: formattedPrice.toString(), // Trigger price (when price reaches this, order activates)
      price: formattedPrice.toString(), // Limit price (order executes at this price)
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
    
    logger.info(`Creating SL limit order: ${orderSide} ${normalizedSymbol} @ ${formattedPrice}${dualSide ? ` (${positionSide})` : ''}`);
    
    try {
      const data = await this.makeRequestWithRetry('/fapi/v1/order', 'POST', params, true);
      logger.info(`✅ SL limit order placed: Order ID: ${data.orderId}`);
      return data;
    } catch (error) {
      logger.error(`Failed to create SL limit order:`, error);
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
        throw new Error('Insufficient margin. Please check your account balance.');
      }
      
      throw error;
    }
  }

  /**
   * Cancel order by orderId
   */
  async cancelOrder(symbol, orderId) {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const params = { symbol: normalizedSymbol, orderId: orderId };
    const data = await this.makeRequest('/fapi/v1/order', 'DELETE', params, true);
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

