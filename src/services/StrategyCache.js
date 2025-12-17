import { Strategy } from '../models/Strategy.js';
import logger from '../utils/logger.js';

/**
 * StrategyCache
 * 
 * In-memory cache cho strategies để tối ưu hiệu năng realtime detection.
 * Cache key: exchange|symbol|oc|bot_id
 * 
 * Thread-safe với Map operations (JavaScript single-threaded nhưng async-safe)
 */
export class StrategyCache {
  constructor() {
    // Cache structure: Map<key, strategy>
    // key = `${exchange}|${symbol}|${oc}|${bot_id}`
    this.cache = new Map();
    this.lastRefreshTime = 0;
    this.refreshTTL = 1800000; // 30 minutes
    this.isRefreshing = false;
  }

  /**
   * Generate cache key for strategy
   * @param {string} exchange - Exchange name
   * @param {string} symbol - Symbol (normalized)
   * @param {number} oc - OC threshold
   * @param {number} botId - Bot ID
   * @returns {string} Cache key
   */
  generateKey(exchange, symbol, oc, botId) {
    const normalizedExchange = (exchange || '').toLowerCase();
    const normalizedSymbol = String(symbol || '').toUpperCase().replace(/[\/:_]/g, '');
    return `${normalizedExchange}|${normalizedSymbol}|${oc}|${botId}`;
  }

  /**
   * Refresh cache from database
   * @returns {Promise<Map>} Updated cache
   */
  async refresh() {
    // Prevent concurrent refreshes
    if (this.isRefreshing) {
      logger.debug('[StrategyCache] Refresh already in progress, using existing cache');
      return this.cache;
    }

    // Check cache TTL
    if (this.cache.size > 0 && (Date.now() - this.lastRefreshTime) < this.refreshTTL) {
      logger.debug('[StrategyCache] Using cached strategies');
      return this.cache;
    }

    this.isRefreshing = true;
    const startTime = Date.now();

    try {
      logger.info('[StrategyCache] Refreshing strategy cache from database...');
      
      // Get all active strategies
      const strategies = await Strategy.findAll(null, true);
      
      // Clear existing cache
      this.cache.clear();

      // Build new cache
      for (const strategy of strategies) {
        const exchange = (strategy.exchange || '').toLowerCase();
        const symbol = String(strategy.symbol || '').toUpperCase().replace(/[\/:_]/g, '');
        const oc = Number(strategy.oc || 0);
        const botId = Number(strategy.bot_id || 0);

        if (!exchange || !symbol || !oc || !botId) {
          logger.warn(`[StrategyCache] Skipping invalid strategy ${strategy.id}: exchange=${exchange}, symbol=${symbol}, oc=${oc}, botId=${botId}`);
          continue;
        }

        const key = this.generateKey(exchange, symbol, oc, botId);
        this.cache.set(key, strategy);
      }

      this.lastRefreshTime = Date.now();
      const duration = Date.now() - startTime;

      logger.info(`[StrategyCache] Cache refreshed: ${this.cache.size} strategies in ${duration}ms`);

      return this.cache;
    } catch (error) {
      logger.error('[StrategyCache] Failed to refresh cache:', error?.message || error);
      // Return existing cache on error
      return this.cache;
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Get strategies matching exchange and symbol
   * @param {string} exchange - Exchange name
   * @param {string} symbol - Symbol (normalized)
   * @returns {Array<Object>} Array of matching strategies
   */
  getStrategies(exchange, symbol) {
    const normalizedExchange = (exchange || '').toLowerCase();
    const normalizedSymbol = String(symbol || '').toUpperCase().replace(/[\/:_]/g, '');
    
    const matches = [];
    for (const [key, strategy] of this.cache.entries()) {
      const [cachedExchange, cachedSymbol] = key.split('|');
      if (cachedExchange === normalizedExchange && cachedSymbol === normalizedSymbol) {
        matches.push(strategy);
      }
    }

    return matches;
  }

  /**
   * Get strategy by key
   * @param {string} exchange - Exchange name
   * @param {string} symbol - Symbol
   * @param {number} oc - OC threshold
   * @param {number} botId - Bot ID
   * @returns {Object|null} Strategy or null
   */
  getStrategy(exchange, symbol, oc, botId) {
    const key = this.generateKey(exchange, symbol, oc, botId);
    return this.cache.get(key) || null;
  }

  /**
   * Check if cache needs refresh
   * @returns {boolean} True if cache should be refreshed
   */
  needsRefresh() {
    return (Date.now() - this.lastRefreshTime) >= this.refreshTTL;
  }

  /**
   * Get cache size
   * @returns {number} Number of cached strategies
   */
  size() {
    return this.cache.size;
  }

  /**
   * Clear cache
   */
  clear() {
    this.cache.clear();
    this.lastRefreshTime = 0;
    logger.info('[StrategyCache] Cache cleared');
  }

  /**
   * Invalidate cache (force refresh on next call)
   */
  invalidate() {
    this.lastRefreshTime = 0;
    logger.debug('[StrategyCache] Cache invalidated');
  }
}

// Export singleton instance
export const strategyCache = new StrategyCache();

