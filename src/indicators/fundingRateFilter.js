/**
 * Funding Rate Filter for Futures Trading
 * 
 * Funding rate is a periodic payment between long and short traders in perpetual futures.
 * - Positive funding rate: Longs pay shorts (market is bullish sentiment)
 * - Negative funding rate: Shorts pay longs (market is bearish sentiment)
 * 
 * Trading Logic:
 * - If funding is extremely positive (>0.1%), avoid LONG (longs are paying too much, likely to reverse)
 * - If funding is extremely negative (<-0.1%), avoid SHORT (shorts are paying too much, likely to squeeze)
 * - Moderate funding aligns with market direction and is acceptable
 * 
 * Use cases:
 * 1. Avoid entering positions against extreme sentiment
 * 2. Detect potential liquidation cascades (extreme funding often precedes them)
 * 3. Sentiment confirmation for trade direction
 */

import { configService } from '../services/ConfigService.js';
import logger from '../utils/logger.js';

// Default thresholds (per 8-hour funding period)
const FUNDING_THRESHOLDS = {
  // Extreme levels - avoid trading in this direction
  EXTREME_POSITIVE: 0.10,     // 0.10% = 10 bps per 8h, very bullish sentiment
  EXTREME_NEGATIVE: -0.10,    // -0.10% = -10 bps per 8h, very bearish sentiment
  
  // Warning levels - reduce position size or be cautious
  HIGH_POSITIVE: 0.05,        // 0.05% = 5 bps per 8h, bullish sentiment  
  HIGH_NEGATIVE: -0.05,       // -0.05% = -5 bps per 8h, bearish sentiment
  
  // Neutral zone - no restriction
  NEUTRAL_LOW: -0.01,         // -0.01%
  NEUTRAL_HIGH: 0.01          // 0.01%
};

// Cache for funding rates
const fundingRateCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache TTL

/**
 * Fetch funding rate from exchange
 * 
 * @param {ExchangeService} exchangeService - Exchange service instance
 * @param {string} symbol - Trading symbol (e.g., 'BTCUSDT')
 * @returns {Promise<number|null>} Funding rate as decimal (e.g., 0.0001 = 0.01%)
 */
export async function fetchFundingRate(exchangeService, symbol) {
  if (!exchangeService || !symbol) {
    return null;
  }
  
  // Check cache first
  const cacheKey = `${exchangeService.bot?.id || 'default'}_${symbol}`;
  const cached = fundingRateCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.value;
  }
  
  try {
    let fundingRate = null;
    
    // Try different methods based on exchange
    const exchange = exchangeService.exchange;
    const exchangeName = (exchangeService.bot?.exchange || 'binance').toLowerCase();
    
    if (exchangeName === 'binance' && exchangeService.directClient) {
      // Binance Direct Client
      const futuresClient = exchangeService.directClient;
      const premiumIndex = await futuresClient.futuresPremiumIndex(symbol);
      if (premiumIndex && premiumIndex.lastFundingRate !== undefined) {
        fundingRate = parseFloat(premiumIndex.lastFundingRate);
      }
    } else if (exchange?.fetchFundingRate) {
      // CCXT method
      const response = await exchange.fetchFundingRate(symbol);
      if (response && response.fundingRate !== undefined) {
        fundingRate = parseFloat(response.fundingRate);
      }
    } else if (exchange?.fapiPublic) {
      // Binance Futures API fallback
      const response = await exchange.fapiPublicGetPremiumIndex({ symbol });
      if (response && response.lastFundingRate !== undefined) {
        fundingRate = parseFloat(response.lastFundingRate);
      }
    }
    
    // Cache the result
    if (fundingRate !== null && Number.isFinite(fundingRate)) {
      fundingRateCache.set(cacheKey, { value: fundingRate, timestamp: Date.now() });
      logger.debug(`[FundingRateFilter] ${symbol} funding rate: ${(fundingRate * 100).toFixed(4)}%`);
    }
    
    return fundingRate;
    
  } catch (error) {
    logger.debug(`[FundingRateFilter] Failed to fetch funding rate for ${symbol}: ${error?.message || error}`);
    return null;
  }
}

/**
 * Analyze funding rate and determine trading implications
 * 
 * @param {number} fundingRate - Funding rate as decimal (e.g., 0.0001 = 0.01%)
 * @returns {Object} { sentiment: string, level: string, avoidLong: boolean, avoidShort: boolean }
 */
export function analyzeFundingRate(fundingRate) {
  if (!Number.isFinite(fundingRate)) {
    return { 
      sentiment: 'UNKNOWN', 
      level: 'UNKNOWN', 
      avoidLong: false, 
      avoidShort: false,
      fundingRatePct: null
    };
  }
  
  // Convert to percentage for easier comparison
  const ratePct = fundingRate * 100;
  
  // Load configurable thresholds
  const extremePositive = Number(configService.getNumber('FUNDING_EXTREME_POSITIVE', FUNDING_THRESHOLDS.EXTREME_POSITIVE));
  const extremeNegative = Number(configService.getNumber('FUNDING_EXTREME_NEGATIVE', FUNDING_THRESHOLDS.EXTREME_NEGATIVE));
  const highPositive = Number(configService.getNumber('FUNDING_HIGH_POSITIVE', FUNDING_THRESHOLDS.HIGH_POSITIVE));
  const highNegative = Number(configService.getNumber('FUNDING_HIGH_NEGATIVE', FUNDING_THRESHOLDS.HIGH_NEGATIVE));
  
  let sentiment = 'NEUTRAL';
  let level = 'NORMAL';
  let avoidLong = false;
  let avoidShort = false;
  
  if (ratePct >= extremePositive) {
    // Extremely positive - longs are paying too much, potential long squeeze
    sentiment = 'EXTREMELY_BULLISH';
    level = 'EXTREME';
    avoidLong = true; // Avoid going long when funding is extremely positive
    
  } else if (ratePct >= highPositive) {
    // High positive - bullish sentiment, be cautious with longs
    sentiment = 'BULLISH';
    level = 'HIGH';
    // Don't block, just warning
    
  } else if (ratePct <= extremeNegative) {
    // Extremely negative - shorts are paying too much, potential short squeeze
    sentiment = 'EXTREMELY_BEARISH';
    level = 'EXTREME';
    avoidShort = true; // Avoid going short when funding is extremely negative
    
  } else if (ratePct <= highNegative) {
    // High negative - bearish sentiment, be cautious with shorts
    sentiment = 'BEARISH';
    level = 'HIGH';
    // Don't block, just warning
    
  } else {
    // Neutral zone
    sentiment = ratePct > 0 ? 'SLIGHTLY_BULLISH' : ratePct < 0 ? 'SLIGHTLY_BEARISH' : 'NEUTRAL';
    level = 'NORMAL';
  }
  
  return {
    sentiment,
    level,
    avoidLong,
    avoidShort,
    fundingRatePct: ratePct,
    thresholds: { extremePositive, extremeNegative, highPositive, highNegative }
  };
}

/**
 * Entry gate: Check if funding rate allows entry in specified direction
 * 
 * @param {string} direction - 'LONG' or 'SHORT' (or 'bullish'/'bearish')
 * @param {ExchangeService} exchangeService - Exchange service instance
 * @param {string} symbol - Trading symbol
 * @returns {Promise<Object>} { ok: boolean, reason: string, fundingRatePct: number, sentiment: string }
 */
export async function checkFundingRateGate(direction, exchangeService, symbol) {
  const enabled = configService.getBoolean('FUNDING_RATE_FILTER_ENABLED', true);
  if (!enabled) {
    return { ok: true, reason: 'funding_filter_disabled' };
  }
  
  // Normalize direction
  const dir = String(direction || '').toUpperCase();
  const isLong = dir === 'LONG' || dir === 'BULLISH';
  const isShort = dir === 'SHORT' || dir === 'BEARISH';
  
  if (!isLong && !isShort) {
    return { ok: false, reason: 'funding_invalid_direction' };
  }
  
  // Fetch funding rate
  const fundingRate = await fetchFundingRate(exchangeService, symbol);
  
  if (fundingRate === null) {
    // Fail open - allow trade if we can't fetch funding rate
    const failOpen = configService.getBoolean('FUNDING_FAIL_OPEN', true);
    if (failOpen) {
      return { ok: true, reason: 'funding_rate_unavailable_fail_open' };
    } else {
      return { ok: false, reason: 'funding_rate_unavailable' };
    }
  }
  
  const analysis = analyzeFundingRate(fundingRate);
  
  // Check if direction is blocked
  if (isLong && analysis.avoidLong) {
    return {
      ok: false,
      reason: `funding_extreme_positive_avoid_long_${analysis.fundingRatePct.toFixed(4)}%`,
      fundingRatePct: analysis.fundingRatePct,
      sentiment: analysis.sentiment,
      level: analysis.level
    };
  }
  
  if (isShort && analysis.avoidShort) {
    return {
      ok: false,
      reason: `funding_extreme_negative_avoid_short_${analysis.fundingRatePct.toFixed(4)}%`,
      fundingRatePct: analysis.fundingRatePct,
      sentiment: analysis.sentiment,
      level: analysis.level
    };
  }
  
  // Passed - funding rate is acceptable
  return {
    ok: true,
    reason: `funding_ok_${analysis.sentiment.toLowerCase()}`,
    fundingRatePct: analysis.fundingRatePct,
    sentiment: analysis.sentiment,
    level: analysis.level
  };
}

/**
 * Get funding rate sentiment for logging/display
 * 
 * @param {ExchangeService} exchangeService - Exchange service instance
 * @param {string} symbol - Trading symbol
 * @returns {Promise<Object>} { fundingRatePct, sentiment, level, nextFundingTime }
 */
export async function getFundingRateSentiment(exchangeService, symbol) {
  const fundingRate = await fetchFundingRate(exchangeService, symbol);
  
  if (fundingRate === null) {
    return { fundingRatePct: null, sentiment: 'UNKNOWN', level: 'UNKNOWN' };
  }
  
  return analyzeFundingRate(fundingRate);
}

/**
 * Clear funding rate cache (useful for testing or manual refresh)
 */
export function clearFundingRateCache() {
  fundingRateCache.clear();
  logger.debug('[FundingRateFilter] Cache cleared');
}

export default {
  fetchFundingRate,
  analyzeFundingRate,
  checkFundingRateGate,
  getFundingRateSentiment,
  clearFundingRateCache
};
