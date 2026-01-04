import { BinanceDirectClient } from './BinanceDirectClient.js';
import logger from '../utils/logger.js';

// Simple EMA calculation utility
function calculateEMA(closes, period) {
  if (!closes || closes.length < period) {
    return null;
  }
  const k = 2 / (period + 1);
  let ema = closes[0]; // Start with the first price
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

class TrendFilterService {
  constructor() {
    // Use a public client for fetching public data (klines)
    // No API keys needed, so we can instantiate it directly.
    // We assume Binance for now as it's the primary exchange.
    this.publicClient = new BinanceDirectClient(null, null, false); // false = production
    this.emaCache = new Map();
    this.cacheTTL = 15 * 60 * 1000; // 15 minutes
    logger.info('[TrendFilterService] Initialized public client for EMA filter.');
  }

  async getEMA(symbol, interval, period) {
    const cacheKey = `${symbol}:${interval}:${period}`;
    const cached = this.emaCache.get(cacheKey);

    if (cached && (Date.now() - cached.timestamp < this.cacheTTL)) {
      return cached.value;
    }

    try {
      // Fetch slightly more candles than the period to ensure accuracy
      const limit = period + 50;
      const klines = await this.publicClient.getKlines(symbol, interval, limit);
      
      const klinesCount = klines ? klines.length : 0;
      if (klinesCount < period) {
        logger.warn(`[TrendFilterService] Not enough klines for ${symbol} ${interval} to calculate EMA${period}. Required: ${period}, Found: ${klinesCount}`);
        return null;
      }

      // Extract close prices from objects and add debug logging
      const closes = klines.map(k => {
        const close = parseFloat(k && k.close); // CORRECTED: use k.close
        if (!Number.isFinite(close)) {
          logger.warn(`[TrendFilterService] Invalid close price found in kline data for ${symbol}:`, k);
        }
        return close;
      }).filter(c => Number.isFinite(c)); // Filter out any NaN/Infinity values

      if (closes.length < period) {
        logger.warn(`[TrendFilterService] Not enough valid close prices for ${symbol} ${interval} after filtering. Required: ${period}, Found: ${closes.length}`);
        return null;
      }

      logger.debug(
        `[TrendFilterService] Calculating EMA${period} for ${symbol} ${interval} with ${closes.length} candles. ` +
        `First close: ${closes[0]}, Last close: ${closes[closes.length - 1]}`
      );
      
      const emaValue = calculateEMA(closes, period);
      logger.debug(`[TrendFilterService] Raw EMA value for ${symbol} ${interval}: ${emaValue}`);
      
      if (Number.isFinite(emaValue)) {
        this.emaCache.set(cacheKey, { value: emaValue, timestamp: Date.now() });
        logger.debug(`[TrendFilterService] Cached EMA${period} for ${symbol} ${interval}: ${emaValue}`)
      } else {
        logger.warn(`[TrendFilterService] EMA calculation resulted in a non-finite value for ${symbol} ${interval}: ${emaValue}`)
      }
      
      return Number.isFinite(emaValue) ? emaValue : null;

    } catch (error) {
      logger.error(`[TrendFilterService] Failed to get EMA for ${symbol} ${interval}:`, error.message);
      // Return stale cache data if available
      return cached ? cached.value : null;
    }
  }
}

// Export a singleton instance
export const trendFilterService = new TrendFilterService();
