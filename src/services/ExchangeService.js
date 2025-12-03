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
    this._binanceConfiguredSymbols = new Set(); // symbols configured with leverage/margin
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
      const { symbol, side, amount, type = 'limit', price, positionSide } = params;

      // For Binance: use direct client
      if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
        const normalizedSymbol = this.binanceDirectClient.normalizeSymbol(symbol);

        // Validate symbol is tradable on Binance Futures (testnet/prod accordingly)
        const symbolInfo = await this.binanceDirectClient.getTradingExchangeSymbol(normalizedSymbol);
        if (!symbolInfo || symbolInfo.status !== 'TRADING') {
          throw new Error(`Symbol ${normalizedSymbol} is not available for trading on Binance Futures.`);
        }
        
        // Calculate quantity and notional (USDT)
        const currentPrice = price || await this.getTickerPrice(symbol);
        const quantity = amount / currentPrice;
        const notional = amount; // USDT-margined futures: price * qty = amount

        // Configure margin type and optimal leverage per symbol per notional
        try {
          const marginType = (process.env.BINANCE_DEFAULT_MARGIN_TYPE || 'CROSSED').toUpperCase();
          await this.binanceDirectClient.setMarginType(normalizedSymbol, marginType);
          const optimalLev = await this.binanceDirectClient.getOptimalLeverage(normalizedSymbol, notional);
          const desiredLev = optimalLev || parseInt(process.env.BINANCE_DEFAULT_LEVERAGE || '5');
          // Cache last applied leverage to avoid redundant calls
          this._binanceLeverageMap = this._binanceLeverageMap || new Map();
          if (this._binanceLeverageMap.get(normalizedSymbol) !== desiredLev) {
            await this.binanceDirectClient.setLeverage(normalizedSymbol, desiredLev);
            this._binanceLeverageMap.set(normalizedSymbol, desiredLev);
            logger.info(`Set leverage for ${normalizedSymbol} to ${desiredLev} (optimal) for bot ${this.bot.id}`);
          }
        } catch (cfgErr) {
          logger.warn(`Binance leverage/margin setup warning for ${normalizedSymbol}: ${cfgErr?.message || cfgErr}`);
        }

        // Respect strategy amount: do NOT auto-increase to meet min notional.
        // Validate against MIN_NOTIONAL; if not enough, throw to skip trade.
        const minNotional = await this.binanceDirectClient.getMinNotional(normalizedSymbol);
        if (minNotional && amount < minNotional) {
          throw new Error(`Amount ${amount} USDT is below minimum notional ${minNotional} USDT for ${normalizedSymbol}.`);
        }

        logger.debug(`Calculated quantity: ${quantity} for ${symbol} (amount: ${amount} USDT, price: ${currentPrice})`);

        let order;
        if (type === 'market') {
          order = await this.binanceDirectClient.placeMarketOrder(
            normalizedSymbol,
            side,
            quantity,
            positionSide
          );
        } else {
          order = await this.binanceDirectClient.placeLimitOrder(
            normalizedSymbol,
            side,
            quantity,
            price,
            positionSide
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
      const msg = error?.message || '';
      const soft = (
        msg.includes('not available for trading on Binance Futures') ||
        msg.includes('below minimum notional') ||
        msg.includes('Invalid price after rounding') ||
        msg.includes('Precision is over the maximum') ||
        msg.includes('-1121') || msg.includes('-1111') || msg.includes('-4061')
      );
      if (soft) {
        logger.warn(`Create order validation for bot ${this.bot.id}: ${msg}`);
      } else {
        logger.error(`Failed to create order for bot ${this.bot.id}:`, error);
      }
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
      // For Binance: use direct client and reduce-only with exact position size
      if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
        const normalizedSymbol = this.binanceDirectClient.normalizeSymbol(symbol);
        // Get open positions to determine exact reducible amount
        const positions = await this.binanceDirectClient.getOpenPositions(normalizedSymbol);
        const desiredSide = side === 'long' ? 'BUY' : 'SELL'; // order side to close is opposite, but we decide below
        const positionSide = side === 'long' ? 'LONG' : 'SHORT';

        // Find matching position
        let pos = null;
        if (Array.isArray(positions)) {
          // PositionRisk returns both LONG/SHORT entries in dual-side, or one entry in one-way
          pos = positions.find(p => p.symbol === normalizedSymbol && (p.positionSide ? p.positionSide === positionSide : true));
          // If not found by side (one-way), take any non-zero
          if (!pos) pos = positions.find(p => p.symbol === normalizedSymbol && parseFloat(p.positionAmt) !== 0);
        }

        const posAmt = pos ? Math.abs(parseFloat(pos.positionAmt || 0)) : 0;
        if (!pos || posAmt === 0) {
          logger.warn(`No open position to close for ${normalizedSymbol}, skip close.`);
          return { skipped: true };
        }

        // Use stepSize to floor quantity <= posAmt
        const stepSize = await this.binanceDirectClient.getStepSize(normalizedSymbol);
        const qtyStr = this.binanceDirectClient.formatQuantity(posAmt, stepSize);
        const qty = parseFloat(qtyStr);
        if (qty <= 0) {
          logger.warn(`Computed close quantity <= 0 for ${normalizedSymbol}, skip.`);
          return { skipped: true };
        }

        const closeSide = side === 'long' ? 'SELL' : 'BUY';
        const order = await this.binanceDirectClient.placeMarketOrder(
          normalizedSymbol,
          closeSide,
          qty,
          positionSide,
          true // reduceOnly
        );
        logger.info(`Position closed for bot ${this.bot.id}:`, {
          orderId: order.orderId,
          symbol,
          side,
          amount
        });
        return order;
      }

      // For closing on other exchanges, reverse the side and use CCXT
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
      const msg = error?.message || '';
      if (msg.includes('-2022') || msg.toLowerCase().includes('reduceonly')) {
        // Race condition: position already reduced/closed by TP/SL or other order
        logger.warn(`ReduceOnly close skipped for bot ${this.bot.id} (${symbol}): ${msg}`);
        return { skipped: true };
      }
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
   * Create Take Profit Limit order (reduce-only)
   * Only implemented for Binance (direct client) for now
   * @param {string} symbol
   * @param {'long'|'short'} side - original position side
   * @param {number} tpPrice
   * @param {number} quantity
   */
  async createTakeProfitLimit(symbol, side, tpPrice, quantity) {
    if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
      const normalizedSymbol = this.binanceDirectClient.normalizeSymbol(symbol);
      const data = await this.binanceDirectClient.createTpLimitOrder(normalizedSymbol, side, tpPrice, quantity);
      return data;
    }
    throw new Error('createTakeProfitLimit not supported on this exchange');
  }

  async createStopLossLimit(symbol, side, slPrice, quantity) {
    if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
      const normalizedSymbol = this.binanceDirectClient.normalizeSymbol(symbol);
      const data = await this.binanceDirectClient.createSlLimitOrder(normalizedSymbol, side, slPrice, quantity);
      return data;
    }
    throw new Error('createStopLossLimit not supported on this exchange');
  }

  async getTickSize(symbol) {
    if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
      return await this.binanceDirectClient.getTickSize(symbol);
    }
    return '0.01';
  }

  async createEntryTriggerOrder(symbol, side, entryPrice, quantity) {
    if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
      const normalizedSymbol = this.binanceDirectClient.normalizeSymbol(symbol);
      return await this.binanceDirectClient.createEntryTriggerOrder(normalizedSymbol, side, entryPrice, quantity);
    }
    throw new Error('createEntryTriggerOrder not supported on this exchange');
  }

  async getClosableQuantity(symbol, side) {
    if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
      const normalizedSymbol = this.binanceDirectClient.normalizeSymbol(symbol);
      const positions = await this.binanceDirectClient.getOpenPositions(normalizedSymbol);
      const positionSide = side === 'long' ? 'LONG' : 'SHORT';
      let pos = null;
      if (Array.isArray(positions)) {
        pos = positions.find(p => p.symbol === normalizedSymbol && (p.positionSide ? p.positionSide === positionSide : true));
        if (!pos) pos = positions.find(p => p.symbol === normalizedSymbol && parseFloat(p.positionAmt) !== 0);
      }
      const posAmt = pos ? Math.abs(parseFloat(pos.positionAmt || 0)) : 0;
      if (posAmt <= 0) return 0;
      const stepSize = await this.binanceDirectClient.getStepSize(normalizedSymbol);
      return parseFloat(this.binanceDirectClient.formatQuantity(posAmt, stepSize));
    }
    return 0;
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
      // Binance: use direct client
      if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
        const normalizedSymbol = this.binanceDirectClient.normalizeSymbol(symbol);
        const result = await this.binanceDirectClient.cancelOrder(normalizedSymbol, orderId);
        logger.info(`Order cancelled for bot ${this.bot.id}:`, { orderId, symbol: normalizedSymbol });
        return result;
      }

      // Other exchanges: use CCXT
      const marketSymbol = this.formatSymbolForExchange(symbol, 'swap');
      const result = await this.exchange.cancelOrder(orderId, marketSymbol);
      logger.info(`Order cancelled for bot ${this.bot.id}:`, { orderId, symbol: marketSymbol });
      return result;
    } catch (error) {
      logger.error(`Failed to cancel order for bot ${this.bot.id}:`, error);
      throw error;
    }
  }
}

