import { Candle } from '../models/Candle.js';
import { calculateOC, getCandleDirection } from '../utils/calculator.js';
import logger from '../utils/logger.js';

/**
 * Candle Service - Fetch and store candle data
 */
export class CandleService {
  constructor(exchangeService) {
    this.exchangeService = exchangeService;
    this.exchange = exchangeService.bot?.exchange || 'mexc'; // Default to mexc for backward compatibility
  }

  /**
   * Update candles for symbol and interval
   * @param {string} symbol - Trading symbol
   * @param {string} interval - Time interval
   * @returns {Promise<number>} Number of candles updated
   */
  async updateCandles(symbol, interval) {
    try {
      // Fetch latest candles from exchange (try swap first, fallback to spot)
      let candles = [];

      try {
        candles = await this.exchangeService.fetchOHLCV(symbol, interval, 100, 'swap');
      } catch (error) {
        // Handle invalid symbol status (symbol delisted or not trading)
        if (error.message?.includes('Invalid symbol status') || 
            error.message?.includes('-1122') ||
            error.message?.includes('symbol status')) {
          logger.debug(`Symbol ${symbol} is invalid or delisted, skipping candle update`);
          return 0; // Skip silently for invalid symbols
        }
        
        if (error.name === 'BadSymbol' || error.message?.includes('BadSymbol')) {
          candles = await this.exchangeService.fetchOHLCV(symbol, interval, 100, 'spot');
        } else {
          throw error;
        }
      }
      
      if (candles.length === 0) {
        logger.warn(`No candles fetched for ${symbol} ${interval}`);
        return 0;
      }

      // Convert CCXT format [timestamp, open, high, low, close, volume] to our format
      // MEXC may return candles in different format, normalize them
      const candlesForDB = candles.map(candle => {
        if (Array.isArray(candle)) {
          // CCXT format: [timestamp, open, high, low, close, volume]
          const openTime = candle[0];
          const timeframeMs = this.getTimeframeMs(interval);
          return {
            exchange: this.exchange,
            symbol: symbol,
            interval: interval,
            open_time: openTime,
            open: parseFloat(candle[1]),
            high: parseFloat(candle[2]),
            low: parseFloat(candle[3]),
            close: parseFloat(candle[4]),
            volume: parseFloat(candle[5]),
            close_time: openTime + timeframeMs - 1
          };
        } else {
          // Already object format (MEXC may return this way)
          // MEXC fields: openTime, open, high, low, close, volume, closeTime, quoteAssetVolume, numberOfTrades, takerBuyBaseAssetVolume, takerBuyQuoteAssetVolume
          const openTime = candle.open_time || candle.openTime || candle.t;
          const closeTime = candle.close_time || candle.closeTime || (openTime + this.getTimeframeMs(interval) - 1);
          
          return {
            exchange: this.exchange,
            symbol: symbol,
            interval: interval,
            open_time: openTime,
            open: parseFloat(candle.open || candle.o),
            high: parseFloat(candle.high || candle.h),
            low: parseFloat(candle.low || candle.l),
            close: parseFloat(candle.close || candle.c),
            volume: parseFloat(candle.volume || candle.v || 0),
            close_time: closeTime
          };
        }
      });

      // Bulk insert/update
      const count = await Candle.bulkInsert(candlesForDB);
      logger.debug(`Updated ${count} candles for ${this.exchange} ${symbol} ${interval}`);

      return count;
    } catch (error) {
      // Handle invalid symbol status gracefully
      if (error.message?.includes('Invalid symbol status') || 
          error.message?.includes('-1122') ||
          error.message?.includes('symbol status')) {
        logger.debug(`Symbol ${symbol} is invalid or delisted, skipping candle update`);
        return 0; // Skip silently for invalid symbols
      }
      
      logger.error(`Failed to update candles for ${symbol} ${interval}:`, error);
      throw error;
    }
  }

  /**
   * Get timeframe in milliseconds
   * @param {string} interval - Time interval (1m, 5m, etc.)
   * @returns {number} Milliseconds
   */
  getTimeframeMs(interval) {
    const units = {
      'm': 60 * 1000,
      'h': 60 * 60 * 1000,
      'd': 24 * 60 * 60 * 1000
    };
    const match = interval.match(/^(\d+)([mhd])$/);
    if (!match) return 60000; // Default 1 minute
    const value = parseInt(match[1]);
    const unit = match[2];
    return value * units[unit];
  }

  /**
   * Get latest closed candle
   * @param {string} symbol - Trading symbol
   * @param {string} interval - Time interval
   * @returns {Promise<Object|null>} Latest candle
   */
  async getLatestCandle(symbol, interval) {
    try {
      const candle = await Candle.getLatest(this.exchange, symbol, interval);
      return candle;
    } catch (error) {
      logger.error(`Failed to get latest candle for ${this.exchange} ${symbol} ${interval}:`, error);
      throw error;
    }
  }

  /**
   * Get previous candle (before latest)
   * @param {string} symbol - Trading symbol
   * @param {string} interval - Time interval
   * @returns {Promise<Object|null>} Previous candle
   */
  async getPreviousCandle(symbol, interval) {
    try {
      const candle = await Candle.getPrevious(this.exchange, symbol, interval);
      return candle;
    } catch (error) {
      logger.error(`Failed to get previous candle for ${this.exchange} ${symbol} ${interval}:`, error);
      throw error;
    }
  }

  /**
   * Get historical candles
   * @param {string} symbol - Trading symbol
   * @param {string} interval - Time interval
   * @param {number} limit - Number of candles
   * @returns {Promise<Array>} Array of candles
   */
  async getCandles(symbol, interval, limit = 100) {
    try {
      const candles = await Candle.getCandles(this.exchange, symbol, interval, limit);
      return candles;
    } catch (error) {
      logger.error(`Failed to get candles for ${this.exchange} ${symbol} ${interval}:`, error);
      throw error;
    }
  }

  /**
   * Calculate candle metrics
   * @param {Object} candle - Candle object
   * @returns {Object} { oc, direction }
   */
  calculateCandleMetrics(candle) {
    if (!candle) {
      return { oc: 0, direction: 'neutral' };
    }

    const oc = calculateOC(candle.open, candle.close);
    const direction = getCandleDirection(candle.open, candle.close);

    return { oc, direction };
  }

  /**
   * Calculate OC from open and close prices
   * @param {number} open - Open price
   * @param {number} close - Close price
   * @returns {number} OC percentage
   */
  calculateOC(open, close) {
    return calculateOC(open, close);
  }

  /**
   * Get candle direction from open and close prices
   * @param {number} open - Open price
   * @param {number} close - Close price
   * @returns {'bullish'|'bearish'}
   */
  getCandleDirection(open, close) {
    return getCandleDirection(open, close);
  }

  /**
   * Check if candle is closed (current time > close_time)
   * @param {Object} candle - Candle object
   * @returns {boolean}
   */
  isCandleClosed(candle) {
    if (!candle || !candle.close_time) return false;
    return Date.now() > candle.close_time;
  }

  /**
   * Get current candle (may be incomplete)
   * @param {string} symbol - Trading symbol
   * @param {string} interval - Time interval
   * @returns {Promise<Object|null>} Current candle
   */
  async getCurrentCandle(symbol, interval) {
    try {
      // Fetch latest candle from exchange (may be incomplete)
      const candles = await this.exchangeService.fetchOHLCV(symbol, interval, 1);
      if (candles.length === 0) return null;

      return candles[0];
    } catch (error) {
      logger.error(`Failed to get current candle for ${symbol} ${interval}:`, error);
      throw error;
    }
  }
}

