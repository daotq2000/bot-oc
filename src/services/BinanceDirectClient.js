/**
 * Binance Direct API Client - Direct HTTP calls without CCXT
 * Based on SUMMARY_PRODUCTION_DATA_AND_TESTNET_TRADING.md
 */

import crypto from 'crypto';
import logger from '../utils/logger.js';
import { webSocketManager } from './WebSocketManager.js';

export class BinanceDirectClient {
  constructor(apiKey, secretKey, isTestnet = true) {
    this.apiKey = apiKey;
    this.secretKey = secretKey;
    this.isTestnet = isTestnet;
    
    // Production data URL (always use production for market data)
    this.productionDataURL = 'https://fapi.binance.com';
    
    // Trading URL (testnet or production)
    this.baseURL = isTestnet 
      ? (process.env.BINANCE_FUTURES_ENDPOINT || 'https://testnet.binancefuture.com')
      : 'https://fapi.binance.com';
    
    this.minRequestInterval = 100; // 100ms between requests
    this.lastRequestTime = 0;
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
    
    try {
      const response = await fetch(url.toString(), {
        method,
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
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
      // Don't log again if already logged above
      if (!error.message?.includes('HTTP')) {
        logger.error(`❌ Market data request failed: ${endpoint}`, error.message);
      }
      throw error;
    }
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
          body: requestBody
        });
        
        const data = await response.json();
        
        if (!response.ok) {
          if (data.code && data.msg) {
            throw new Error(`Binance API Error ${data.code}: ${data.msg}`);
          }
          throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
        }
        
        return data;
      } catch (error) {
        if (i === retries - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // Exponential backoff
      }
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

    // If price is not in cache, return null and let the caller handle it
    logger.warn(`Price for ${normalizedSymbol} not found in WebSocket cache.`);
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
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const data = await this.makeMarketDataRequest('/fapi/v1/exchangeInfo', 'GET', { symbol: normalizedSymbol });
    
    if (data.symbols && data.symbols.length > 0) {
      return data.symbols[0];
    }
    return null;
  }

  /**
   * Get tickSize (price precision) for a symbol
   * @param {string} symbol - Trading symbol
   * @returns {Promise<string>} tickSize (e.g., "0.10", "0.01")
   */
  async getTickSize(symbol) {
    const exchangeInfo = await this.getExchangeInfo(symbol);
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
    const exchangeInfo = await this.getExchangeInfo(symbol);
    if (!exchangeInfo || !exchangeInfo.filters) return '0.001';
    
    const lotSizeFilter = exchangeInfo.filters.find(f => f.filterType === 'LOT_SIZE');
    return lotSizeFilter?.stepSize || '0.001';
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
    
    // Find precision: count decimal places
    const precision = tickSize.indexOf('1') - 1;
    if (precision < 0) {
      // If no '1' found, count decimal places differently
      const parts = tickSize.split('.');
      const precision = parts.length > 1 ? parts[1].length : 0;
      return Number(price.toFixed(precision));
    }
    
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
  roundQuantity(quantity, stepSize) {
    const step = parseFloat(stepSize);
    if (step === 0) return quantity;
    
    // Find precision: count decimal places
    const precision = stepSize.indexOf('1') - 1;
    if (precision < 0) {
      // If no '1' found, count decimal places differently
      const parts = stepSize.split('.');
      const precision = parts.length > 1 ? parts[1].length : 0;
      return Number(quantity.toFixed(precision));
    }
    
    // Round down to nearest step (floor)
    const rounded = Math.floor(quantity / step) * step;
    return Number(rounded.toFixed(precision));
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
   * Place market order
   */
  async placeMarketOrder(symbol, side, quantity, positionSide = 'BOTH') {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    
    // Get stepSize and current price for this symbol
    const [stepSize, currentPrice] = await Promise.all([
      this.getStepSize(normalizedSymbol),
      this.getPrice(normalizedSymbol)
    ]);
    
    // Round quantity correctly
    let roundedQuantity = this.roundQuantity(quantity, stepSize);
    
    // Check minimum notional (quantity * price >= 100 USDT for Binance Futures)
    const minNotional = 100;
    let notional = roundedQuantity * currentPrice;
    
    // If notional is too small, increase quantity to meet minimum
    if (notional < minNotional) {
      const requiredQuantity = minNotional / currentPrice;
      roundedQuantity = this.roundQuantity(requiredQuantity, stepSize);
      notional = roundedQuantity * currentPrice;
      
      // Double check after rounding up
      if (notional < minNotional) {
        // Round up one more step
        const step = parseFloat(stepSize);
        roundedQuantity = this.roundQuantity(requiredQuantity + step, stepSize);
        notional = roundedQuantity * currentPrice;
      }
    }
    
    if (roundedQuantity <= 0) {
      throw new Error(`Invalid quantity after rounding: ${roundedQuantity} (original: ${quantity}, stepSize: ${stepSize})`);
    }
    
    if (notional < minNotional) {
      throw new Error(`Notional value ${notional.toFixed(2)} USDT is too small. Minimum is ${minNotional} USDT for ${symbol}`);
    }
    
    logger.debug(`Market order: quantity=${roundedQuantity}, price=${currentPrice}, notional=${notional.toFixed(2)} USDT`);
    
    const params = {
      symbol: normalizedSymbol,
      side: side.toUpperCase(),
      type: 'MARKET',
      quantity: roundedQuantity.toString()
    };
    
    if (positionSide !== 'BOTH') {
      params.positionSide = positionSide;
    }
    
    const data = await this.makeRequest('/fapi/v1/order', 'POST', params, true);
    logger.info(`✅ Market order placed: ${side} ${quantity} ${symbol} - Order ID: ${data.orderId}`);
    return data;
  }

  /**
   * Place limit order
   */
  async placeLimitOrder(symbol, side, quantity, price, positionSide = 'BOTH', timeInForce = 'GTC') {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    
    // Get tickSize and stepSize for this symbol and round correctly
    const [tickSize, stepSize] = await Promise.all([
      this.getTickSize(normalizedSymbol),
      this.getStepSize(normalizedSymbol)
    ]);
    
    const roundedPrice = this.roundPrice(price, tickSize);
    const roundedQuantity = this.roundQuantity(quantity, stepSize);
    
    if (roundedQuantity <= 0) {
      throw new Error(`Invalid quantity after rounding: ${roundedQuantity} (original: ${quantity}, stepSize: ${stepSize})`);
    }
    
    if (roundedPrice <= 0) {
      throw new Error(`Invalid price after rounding: ${roundedPrice} (original: ${price}, tickSize: ${tickSize})`);
    }
    
    const params = {
      symbol: normalizedSymbol,
      side: side.toUpperCase(),
      type: 'LIMIT',
      quantity: roundedQuantity.toString(),
      price: roundedPrice.toString(),
      timeInForce
    };
    
    if (positionSide !== 'BOTH') {
      params.positionSide = positionSide;
    }
    
    const data = await this.makeRequest('/fapi/v1/order', 'POST', params, true);
    logger.info(`✅ Limit order placed: ${side} ${quantity} ${symbol} @ ${price} - Order ID: ${data.orderId}`);
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
    
    // Find precision: count decimal places
    const precision = tickSize.indexOf('1') - 1;
    if (precision < 0) {
      // If no '1' found, count decimal places differently
      const parts = tickSize.split('.');
      const precision = parts.length > 1 ? parts[1].length : 0;
      return Number(price.toFixed(precision));
    }
    
    // Round to nearest tick
    const rounded = Math.round(price / tick) * tick;
    return Number(rounded.toFixed(precision));
  }

  /**
   * Format quantity according to stepSize
   * @param {number} quantity - Quantity to format
   * @param {string} stepSize - Step size (e.g., "0.001", "0.01")
   * @returns {number} Formatted quantity
   */
  formatQuantity(quantity, stepSize) {
    const step = parseFloat(stepSize);
    if (step === 0) return quantity;
    
    // Find precision: count decimal places
    const precision = stepSize.indexOf('1') - 1;
    if (precision < 0) {
      // If no '1' found, count decimal places differently
      const parts = stepSize.split('.');
      const precision = parts.length > 1 ? parts[1].length : 0;
      return Number(quantity.toFixed(precision));
    }
    
    // Round down to nearest step (floor)
    const rounded = Math.floor(quantity / step) * step;
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
    
    if (formattedQuantity <= 0) {
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
    
    // Get precision info
    const [tickSize, stepSize] = await Promise.all([
      this.getTickSize(normalizedSymbol),
      this.getStepSize(normalizedSymbol)
    ]);
    
    // Format price
    const formattedPrice = this.formatPrice(tpPrice, tickSize);
    
    // Determine position side
    const positionSide = side === 'long' ? 'LONG' : 'SHORT';
    // For TP: long position closes with SELL, short position closes with BUY
    const orderSide = side === 'long' ? 'SELL' : 'BUY';
    
    const params = {
      symbol: normalizedSymbol,
      side: orderSide,
      type: 'TAKE_PROFIT',
      positionSide: positionSide,
      stopPrice: formattedPrice.toString(), // Trigger price (when price reaches this, order activates)
      price: formattedPrice.toString(), // Limit price (order executes at this price)
      closePosition: quantity ? 'false' : 'true',
      reduceOnly: 'true',
      timeInForce: 'GTC'
    };
    
    // Add quantity if provided
    if (quantity) {
      const formattedQuantity = this.formatQuantity(quantity, stepSize);
      if (formattedQuantity <= 0) {
        throw new Error(`Invalid quantity after formatting: ${formattedQuantity}`);
      }
      params.quantity = formattedQuantity.toString();
    }
    
    logger.info(`Creating TP limit order: ${orderSide} ${normalizedSymbol} @ ${formattedPrice} (${positionSide})`);
    
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
    
    // Get precision info
    const [tickSize, stepSize] = await Promise.all([
      this.getTickSize(normalizedSymbol),
      this.getStepSize(normalizedSymbol)
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
      positionSide: positionSide,
      stopPrice: formattedPrice.toString(), // Trigger price (when price reaches this, order activates)
      price: formattedPrice.toString(), // Limit price (order executes at this price)
      closePosition: quantity ? 'false' : 'true',
      reduceOnly: 'true',
      timeInForce: 'GTC'
    };
    
    // Add quantity if provided
    if (quantity) {
      const formattedQuantity = this.formatQuantity(quantity, stepSize);
      if (formattedQuantity <= 0) {
        throw new Error(`Invalid quantity after formatting: ${formattedQuantity}`);
      }
      params.quantity = formattedQuantity.toString();
    }
    
    logger.info(`Creating SL limit order: ${orderSide} ${normalizedSymbol} @ ${formattedPrice} (${positionSide})`);
    
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
}

