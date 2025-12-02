import ccxt from 'ccxt';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { BinanceDirectClient } from './BinanceDirectClient.js';
import logger from '../utils/logger.js';

/**
 * Exchange Service - Wrapper for CCXT with proxy support
 */
export class ExchangeService {
  constructor(bot) {
    this.bot = bot;
    this.exchange = null; // For trading operations (testnet) - CCXT
    this.publicExchange = null; // For public data (mainnet) - CCXT
    this.binanceDirectClient = null; // Direct API client for Binance (no CCXT)
    this.proxyAgent = null;
    this.apiKeyValid = true; // Track if API key is valid
  }

  /**
   * Normalize user-provided symbols to the format CCXT expects
   * @param {string} symbol - Raw symbol from strategy/bot config
   * @param {string|null} marketType - 'spot', 'swap', etc.
   * @returns {string} Formatted symbol for exchange calls
   */
  formatSymbolForExchange(symbol, marketType = null) {
    if (!symbol) return symbol;

    let formatted = symbol.trim().toUpperCase();
    formatted = formatted.replace(/\s+/g, '');

    if (!formatted.includes('/') && formatted.includes('_')) {
      formatted = formatted.replace(/_/g, '/');
    }

    // Convert BTCUSDT -> BTC/USDT
    if (!formatted.includes('/') && formatted.endsWith('USDT')) {
      formatted = `${formatted.replace(/USDT$/, '')}/USDT`;
    }

    if (formatted.includes(':')) {
      return formatted;
    }

    const isSwap =
      marketType === 'swap' ||
      (!marketType &&
        (this.exchange?.options?.defaultType === 'swap' ||
          this.bot.exchange === 'gate' ||
          this.bot.exchange === 'mexc' ||
          this.bot.exchange === 'binance'));

    if (isSwap && formatted.includes('/')) {
      const [base, quote] = formatted.split('/');
      if (base && quote) {
        return `${base}/${quote}:${quote}`;
      }
    }

    return formatted;
  }

  /**
   * Initialize exchange connection
   */
  async initialize() {
    try {
      let exchangeClass;
      if (this.bot.exchange === 'mexc') {
        exchangeClass = ccxt.mexc;
      } else if (this.bot.exchange === 'gate') {
        exchangeClass = ccxt.gateio;
      } else if (this.bot.exchange === 'binance') {
        exchangeClass = ccxt.binance;
      } else {
        throw new Error(`Unsupported exchange: ${this.bot.exchange}`);
      }
      
      // For Binance: Use direct API client (no CCXT)
      if (this.bot.exchange === 'binance') {
        // Use direct HTTP client instead of CCXT for Binance
        const isTestnet = true; // Always use testnet for trading
        this.binanceDirectClient = new BinanceDirectClient(
          this.bot.access_key,
          this.bot.secret_key,
          isTestnet
        );
        logger.info(`Binance direct API client initialized for bot ${this.bot.id} - Trading from ${this.binanceDirectClient.baseURL}, Market data from ${this.binanceDirectClient.productionDataURL}`);
        this.apiKeyValid = true; // Direct client doesn't need loadMarkets()
      } else {
        // For other exchanges, use normal config
        const config = {
          apiKey: this.bot.access_key,
          secret: this.bot.secret_key,
          enableRateLimit: true,
          options: {
            defaultType: 'swap'
          }
        };
        this.exchange = new exchangeClass(config);
      }

      // For non-Binance exchanges
      if (this.bot.exchange !== 'binance') {
        // Add UID for MEXC if provided
        if (this.bot.exchange === 'mexc' && this.bot.uid) {
          this.exchange.uid = this.bot.uid;
        }

        // Setup proxy if provided
        // Proxy support is disabled temporarily

        // Only enable sandbox mode for non-Binance exchanges or if explicitly requested
        const sandboxEnabled =
          process.env.CCXT_SANDBOX === 'true' ||
          (this.bot.exchange === 'gate' && process.env.GATE_SANDBOX === 'true') ||
          (this.bot.exchange === 'mexc' && process.env.MEXC_SANDBOX === 'true');

        if (sandboxEnabled && typeof this.exchange.setSandboxMode === 'function') {
          this.exchange.setSandboxMode(true);
          logger.info(
            `Sandbox mode enabled for bot ${this.bot.id} on ${this.bot.exchange}`
          );
        }

        // Test connection for non-Binance
        await this.exchange.loadMarkets();
        logger.info(`Exchange ${this.bot.exchange} initialized for bot ${this.bot.id}`);
        this.apiKeyValid = true;
      }
      // Binance uses direct client, no need to loadMarkets()

      return true;
    } catch (error) {
      logger.error(`Failed to initialize exchange for bot ${this.bot.id}:`, error);
      throw error;
    }
  }

  /**
   * Parse proxy string to URL
   * Format: IP:PORT:USER:PASS
   * @param {string} proxy - Proxy string
   * @returns {string} Proxy URL
   */
  parseProxy(proxy) {
    if (!proxy) return null;
    const [host, port, username, password] = proxy.split(':');
    return `http://${username}:${password}@${host}:${port}`;
  }

  /**
   * Get balance for spot or futures wallet
   * @param {string} type - 'spot' or 'future'
   * @returns {Promise<Object>} { free, used, total }
   */
  async getBalance(type = 'spot') {
    try {
      // For Binance: use direct client
      if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
        if (type === 'future') {
          return await this.binanceDirectClient.getBalance();
        } else {
          // Spot balance not implemented in direct client yet
          throw new Error('Spot balance not supported for Binance direct client');
        }
      }

      // For other exchanges: use CCXT
      if (!this.exchange) {
        throw new Error(`Exchange not initialized for bot ${this.bot.id}`);
      }

      if (type === 'future') {
        // For futures, use swap balance
        const balance = await this.exchange.fetchBalance({ type: 'swap' });
        return {
          free: balance.USDT?.free || 0,
          used: balance.USDT?.used || 0,
          total: balance.USDT?.total || 0
        };
      } else {
        // For spot
        const balance = await this.exchange.fetchBalance();
        return {
          free: balance.USDT?.free || 0,
          used: balance.USDT?.used || 0,
          total: balance.USDT?.total || 0
        };
      }
    } catch (error) {
      logger.error(`Failed to get ${type} balance for bot ${this.bot.id}:`, error);
      throw error;
    }
  }

  /**
   * Create order
   * @param {Object} params - Order parameters
   * @param {string} params.symbol - Trading symbol
   * @param {string} params.side - 'buy' or 'sell'
   * @param {number} params.amount - Order amount
   * @param {string} params.type - 'market' or 'limit'
   * @param {number} params.price - Price (for limit orders)
   * @returns {Promise<Object>} Order object
   */
  async createOrder(params) {
    try {
      const { symbol, side, amount, type = 'limit', price } = params;

      // For Binance: use direct client
      if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
        const normalizedSymbol = this.binanceDirectClient.normalizeSymbol(symbol);
        
        // Calculate quantity from amount in USDT
        const currentPrice = price || await this.getTickerPrice(symbol);
        let quantity = amount / currentPrice;
        
        // BinanceDirectClient will handle precision rounding
        // We just need to ensure we have enough USDT for minimum quantity
        // Get stepSize to calculate minimum quantity needed
        const stepSize = await this.binanceDirectClient.getStepSize(normalizedSymbol);
        const minQuantity = parseFloat(stepSize);
        const minUSDT = minQuantity * currentPrice;
        
        if (amount < minUSDT) {
          throw new Error(`Amount ${amount} USDT is too small. Minimum needed: ${minUSDT.toFixed(2)} USDT for ${symbol} at price ${currentPrice} (minQuantity: ${minQuantity})`);
        }
        
        logger.debug(`Calculated quantity: ${quantity} for ${symbol} (amount: ${amount} USDT, price: ${currentPrice}, stepSize: ${stepSize})`);
        
        let order;
        if (type === 'market') {
          order = await this.binanceDirectClient.placeMarketOrder(
            normalizedSymbol,
            side,
            quantity
          );
        } else {
          order = await this.binanceDirectClient.placeLimitOrder(
            normalizedSymbol,
            side,
            quantity,
            price
          );
        }
        
        // Convert to CCXT-like format
        return {
          id: order.orderId.toString(),
          symbol: normalizedSymbol,
          type: type,
          side: side,
          amount: quantity,
          price: price || currentPrice,
          status: 'closed',
          filled: quantity,
          remaining: 0,
          timestamp: Date.now(),
          datetime: new Date().toISOString()
        };
      }

      // For other exchanges: use CCXT
      const marketSymbol = this.formatSymbolForExchange(symbol, 'swap');
      const order = await this.exchange.createOrder(
        marketSymbol,
        type,
        side,
        amount,
        price
      );

      logger.info(`Order created for bot ${this.bot.id}:`, {
        orderId: order.id,
        symbol,
        side,
        amount,
        price
      });

      return order;
    } catch (error) {
      logger.error(`Failed to create order for bot ${this.bot.id}:`, error);
      throw error;
    }
  }

  /**
   * Close position
   * @param {string} symbol - Trading symbol
   * @param {string} side - 'long' or 'short'
   * @param {number} amount - Position amount
   * @returns {Promise<Object>} Order object
   */
  async closePosition(symbol, side, amount) {
    try {
      // For closing, reverse the side
      const orderSide = side === 'long' ? 'sell' : 'buy';
      const marketSymbol = this.formatSymbolForExchange(symbol, 'swap');
      
      const order = await this.exchange.createMarketOrder(
        marketSymbol,
        orderSide,
        amount
      );

      logger.info(`Position closed for bot ${this.bot.id}:`, {
        orderId: order.id,
        symbol,
        side,
        amount
      });

      return order;
    } catch (error) {
      logger.error(`Failed to close position for bot ${this.bot.id}:`, error);
      throw error;
    }
  }

  /**
   * Transfer from spot to futures wallet
   * @param {number} amount - Amount to transfer
   * @returns {Promise<Object>} Transfer result
   */
  async transferSpotToFuture(amount) {
    try {
      if (this.bot.exchange === 'mexc') {
        // MEXC transfer
        const result = await this.exchange.transfer('USDT', amount, 'spot', 'swap');
        logger.info(`Spot to future transfer for bot ${this.bot.id}: ${amount} USDT`);
        return result;
      } else if (this.bot.exchange === 'binance') {
        // Binance transfer
        const result = await this.exchange.transfer('USDT', amount, 'spot', 'future');
        logger.info(`Spot to future transfer for bot ${this.bot.id}: ${amount} USDT`);
        return result;
      } else {
        // Gate.io transfer
        const result = await this.exchange.transfer('USDT', amount, 'spot', 'future');
        logger.info(`Spot to future transfer for bot ${this.bot.id}: ${amount} USDT`);
        return result;
      }
    } catch (error) {
      logger.error(`Failed to transfer spot to future for bot ${this.bot.id}:`, error);
      throw error;
    }
  }

  /**
   * Transfer from futures to spot wallet
   * @param {number} amount - Amount to transfer
   * @returns {Promise<Object>} Transfer result
   */
  async transferFutureToSpot(amount) {
    try {
      if (this.bot.exchange === 'mexc') {
        // MEXC transfer
        const result = await this.exchange.transfer('USDT', amount, 'swap', 'spot');
        logger.info(`Future to spot transfer for bot ${this.bot.id}: ${amount} USDT`);
        return result;
      } else if (this.bot.exchange === 'binance') {
        // Binance transfer
        const result = await this.exchange.transfer('USDT', amount, 'future', 'spot');
        logger.info(`Future to spot transfer for bot ${this.bot.id}: ${amount} USDT`);
        return result;
      } else {
        // Gate.io transfer
        const result = await this.exchange.transfer('USDT', amount, 'future', 'spot');
        logger.info(`Future to spot transfer for bot ${this.bot.id}: ${amount} USDT`);
        return result;
      }
    } catch (error) {
      logger.error(`Failed to transfer future to spot for bot ${this.bot.id}:`, error);
      throw error;
    }
  }

  /**
   * Withdraw to external wallet
   * @param {number} amount - Amount to withdraw
   * @param {string} address - Withdrawal address
   * @param {string} network - Network (BEP20, ERC20, TRC20)
   * @returns {Promise<Object>} Withdrawal result
   */
  async withdraw(amount, address, network = 'BEP20') {
    try {
      const code = 'USDT';
      const params = {
        network: network.toLowerCase()
      };

      const result = await this.exchange.withdraw(code, amount, address, undefined, undefined, params);
      
      logger.info(`Withdrawal initiated for bot ${this.bot.id}:`, {
        amount,
        address,
        network,
        txid: result.id
      });

      return result;
    } catch (error) {
      logger.error(`Failed to withdraw for bot ${this.bot.id}:`, error);
      throw error;
    }
  }

  /**
   * Get open positions
   * @param {string} symbol - Optional symbol filter
   * @returns {Promise<Array>} Array of positions
   */
  async getOpenPositions(symbol = null) {
    try {
      // For Binance: use direct client
      if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
        return await this.binanceDirectClient.getOpenPositions(symbol);
      }

      // For other exchanges: use CCXT
      const positions = await this.exchange.fetchPositions(symbol);
      return positions.filter(p => p.contracts > 0);
    } catch (error) {
      logger.error(`Failed to get open positions for bot ${this.bot.id}:`, error);
      throw error;
    }
  }

  /**
   * Fetch OHLCV (candlestick) data
   * @param {string} symbol - Trading symbol
   * @param {string} timeframe - Timeframe (1m, 5m, 1h, etc.)
   * @param {number} limit - Number of candles
   * @returns {Promise<Array>} Array of candles
   */
  async fetchOHLCV(symbol, timeframe, limit = 100, marketType = null) {
    try {
      const marketSymbol = this.formatSymbolForExchange(symbol, marketType);
      const params = {};

      if (marketType) {
        params.type = marketType;
      }

      // For Binance: use direct client (production data)
      if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
        const klines = await this.binanceDirectClient.getKlines(symbol, timeframe, limit);
        // Convert to CCXT format
        return klines.map(candle => [
          candle.openTime,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume
        ]);
      }
      
      // For other exchanges: use CCXT
      const exchange = (this.bot.exchange === 'binance' && this.publicExchange) 
        ? this.publicExchange 
        : this.exchange;
      
      const candles = await exchange.fetchOHLCV(
        marketSymbol,
        timeframe,
        undefined,
        limit,
        params
      );
      
      // Convert to our format
      return candles.map(candle => ({
        symbol,
        interval: timeframe,
        open_time: candle[0],
        open: candle[1],
        high: candle[2],
        low: candle[3],
        close: candle[4],
        volume: candle[5],
        close_time: candle[0] + this.getTimeframeMs(timeframe) - 1
      }));
    } catch (error) {
      // Handle invalid symbol status gracefully - don't log as error
      if (error.message?.includes('Invalid symbol status') || 
          error.message?.includes('-1122') ||
          error.message?.includes('symbol status')) {
        // Let it propagate but don't log as error
        throw error;
      }
      
      logger.error(`Failed to fetch OHLCV for bot ${this.bot.id}:`, error);
      throw error;
    }
  }

  /**
   * Get current ticker price
   * @param {string} symbol - Trading symbol
   * @returns {Promise<number>} Current price
   */
  async getTickerPrice(symbol) {
    try {
      // For Binance: use direct client (production data)
      if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
        return await this.binanceDirectClient.getPrice(symbol);
      }
      
      // For other exchanges: use CCXT
      const marketSymbol = this.formatSymbolForExchange(symbol, 'swap');
      const exchange = (this.bot.exchange === 'binance' && this.publicExchange) 
        ? this.publicExchange 
        : this.exchange;
      const ticker = await exchange.fetchTicker(marketSymbol);
      return ticker.last;
    } catch (error) {
      logger.error(`Failed to get ticker price for bot ${this.bot.id}:`, error);
      throw error;
    }
  }

  /**
   * Get timeframe in milliseconds
   * @param {string} timeframe - Timeframe string
   * @returns {number} Milliseconds
   */
  getTimeframeMs(timeframe) {
    const units = {
      'm': 60 * 1000,
      'h': 60 * 60 * 1000,
      'd': 24 * 60 * 60 * 1000
    };

    const match = timeframe.match(/(\d+)([mhd])/);
    if (!match) return 60000; // Default 1 minute

    const value = parseInt(match[1]);
    const unit = match[2];
    return value * units[unit];
  }

  /**
   * Cancel order
   * @param {string} orderId - Order ID
   * @param {string} symbol - Trading symbol
   * @returns {Promise<Object>} Cancellation result
   */
  async cancelOrder(orderId, symbol) {
    try {
      const result = await this.exchange.cancelOrder(orderId, symbol);
      logger.info(`Order cancelled for bot ${this.bot.id}:`, { orderId, symbol });
      return result;
    } catch (error) {
      logger.error(`Failed to cancel order for bot ${this.bot.id}:`, error);
      throw error;
    }
  }
}

