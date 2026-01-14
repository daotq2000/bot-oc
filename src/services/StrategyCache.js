import { Strategy } from '../models/Strategy.js';
import logger from '../utils/logger.js';

/**
 * StrategyCache
 * 
 * In-memory cache cho strategies để tối ưu hiệu năng realtime detection.
 * Cache key: exchange|symbol|oc|bot_id
 * 
 * Optimized for O(1) lookup with secondary indexes:
 * - byKey: Map<key, strategy> - primary cache
 * - bySymbol: Map<exchange|symbol, Set<key>> - secondary index for getStrategies()
 * 
 * Thread-safe với Map operations (JavaScript single-threaded nhưng async-safe)
 */
export class StrategyCache {
  constructor() {
    // Primary cache: key -> strategy
    // key = `${exchange}|${symbol}|${oc}|${bot_id}`
    this.cache = new Map();
    
    // Secondary index: exchange|symbol -> Set<key>
    // Enables O(1) lookup for getStrategies() instead of O(n)
    this.indexBySymbol = new Map();
    
    this.lastRefreshTime = 0;
    this.refreshTTL = 1800000; // 30 minutes
    this.isRefreshing = false;
    this._refreshPromise = null; // Track ongoing refresh to prevent duplicates
  }

  /**
   * Generate cache key for strategy
   * @param {string} exchange - Exchange name
   * @param {string} symbol - Symbol (normalized)
   * @param {number} oc - OC threshold
   * @param {number} botId - Bot ID
   * @returns {string} Cache key
   */
  generateKey(exchange, symbol, interval, oc, botId) {
    const normalizedExchange = (exchange || '').toLowerCase();
    const normalizedSymbol = String(symbol || '').toUpperCase().replace(/[\/:_]/g, '');
    const normalizedInterval = String(interval || '').toLowerCase();
    return `${normalizedExchange}|${normalizedSymbol}|${normalizedInterval}|${oc}|${botId}`;
  }

  /**
   * Generate symbol index key for secondary index
   * @param {string} exchange - Exchange name
   * @param {string} symbol - Symbol (normalized)
   * @returns {string} Symbol index key
   */
  generateSymbolKey(exchange, symbol) {
    const normalizedExchange = (exchange || '').toLowerCase();
    const normalizedSymbol = String(symbol || '').toUpperCase().replace(/[\/:_]/g, '');
    return `${normalizedExchange}|${normalizedSymbol}`;
  }

  /**
   * Add strategy to indexes
   * @private
   * @param {string} key - Cache key
   * @param {Object} strategy - Strategy object
   */
  _addToIndexes(key, strategy) {
    // Add to primary cache
    this.cache.set(key, strategy);
    
    // Add to secondary index
    const exchange = (strategy.exchange || '').toLowerCase();
    const symbol = String(strategy.symbol || '').toUpperCase().replace(/[\/:_]/g, '');
    const symKey = this.generateSymbolKey(exchange, symbol);
    
    if (!this.indexBySymbol.has(symKey)) {
      this.indexBySymbol.set(symKey, new Set());
    }
    this.indexBySymbol.get(symKey).add(key);
  }

  /**
   * Remove strategy from indexes
   * @private
   * @param {string} key - Cache key
   */
  _removeFromIndexes(key) {
    const strategy = this.cache.get(key);
    if (!strategy) return;
    
    // Remove from primary cache
    this.cache.delete(key);
    
    // Remove from secondary index
    const exchange = (strategy.exchange || '').toLowerCase();
    const symbol = String(strategy.symbol || '').toUpperCase().replace(/[\/:_]/g, '');
    const symKey = this.generateSymbolKey(exchange, symbol);
    
    const keySet = this.indexBySymbol.get(symKey);
    if (keySet) {
      keySet.delete(key);
      // Clean up empty sets
      if (keySet.size === 0) {
        this.indexBySymbol.delete(symKey);
      }
    }
  }

  /**
   * Refresh cache from database
   * @param {boolean} force - Force refresh even if TTL not expired
   * @returns {Promise<Map>} Updated cache
   */
  async refresh(force = false) {
    // Prevent concurrent refreshes - return existing promise if already refreshing
    if (this._refreshPromise) {
      logger.debug('[StrategyCache] Refresh already in progress, waiting for existing refresh');
      return this._refreshPromise.then(() => this.cache);
    }

    // Check cache TTL (unless forced)
    if (!force && this.cache.size > 0 && (Date.now() - this.lastRefreshTime) < this.refreshTTL) {
      logger.debug('[StrategyCache] Using cached strategies (TTL not expired)');
      return this.cache;
    }

    this.isRefreshing = true;
    const startTime = Date.now();

    // CRITICAL FIX: Atomic update - build new cache before replacing old one
    // This prevents cache from being empty if refresh fails
    const newCache = new Map();
    const newIndexBySymbol = new Map();

    // Create refresh promise to prevent concurrent refreshes
    this._refreshPromise = (async () => {
    try {
      logger.info('[StrategyCache] Refreshing strategy cache from database...');
      
      // Get all active strategies
      const strategies = await Strategy.findAll(null, true);
      
        // Build new cache and index
      for (const strategy of strategies) {
        const exchange = (strategy.exchange || '').toLowerCase();
        const symbol = String(strategy.symbol || '').toUpperCase().replace(/[\/:_]/g, '');
        const oc = Number(strategy.oc || 0);
        const botId = Number(strategy.bot_id || 0);

          // CRITICAL FIX: Allow oc === 0 (use Number.isNaN instead of !oc)
          if (!exchange || !symbol || Number.isNaN(oc) || !botId) {
          logger.warn(`[StrategyCache] Skipping invalid strategy ${strategy.id}: exchange=${exchange}, symbol=${symbol}, oc=${oc}, botId=${botId}`);
          continue;
        }

        const key = this.generateKey(exchange, symbol, strategy.interval, oc, botId);
          newCache.set(key, strategy);
          
          // Build secondary index
          const symKey = this.generateSymbolKey(exchange, symbol);
          if (!newIndexBySymbol.has(symKey)) {
            newIndexBySymbol.set(symKey, new Set());
          }
          newIndexBySymbol.get(symKey).add(key);
        }

        // Atomic swap: only replace if build succeeded
        this.cache = newCache;
        this.indexBySymbol = newIndexBySymbol;
      this.lastRefreshTime = Date.now();
      const duration = Date.now() - startTime;

      logger.info(`[StrategyCache] Cache refreshed: ${this.cache.size} strategies in ${duration}ms`);

      return this.cache;
    } catch (error) {
      logger.error('[StrategyCache] Failed to refresh cache:', { message: error?.message, stack: error?.stack });
        // Return existing cache on error (cache is not cleared)
      return this.cache;
    } finally {
      this.isRefreshing = false;
        this._refreshPromise = null;
    }
    })();

    return this._refreshPromise;
  }

  /**
   * Get strategies matching exchange and symbol
   * Optimized O(1) lookup using secondary index instead of O(n) scan
   * @param {string} exchange - Exchange name
   * @param {string} symbol - Symbol (normalized)
   * @param {boolean} autoRefresh - Auto refresh if cache is stale (default: true)
   * @returns {Array<Object>} Array of matching strategies
   */
  getStrategies(exchange, symbol, autoRefresh = true) {
    // CRITICAL FIX: Auto refresh if cache is stale (lazy refresh)
    if (autoRefresh && this.needsRefresh()) {
      // Trigger refresh in background (non-blocking)
      this.refresh().catch(err => {
        logger.error('[StrategyCache] Auto refresh failed in getStrategies:', { message: err?.message, stack: err?.stack });
      });
    }

    const symKey = this.generateSymbolKey(exchange, symbol);
    const keySet = this.indexBySymbol.get(symKey);
    
    if (!keySet || keySet.size === 0) {
      return [];
    }

    // CRITICAL FIX: O(1) lookup using secondary index instead of O(n) scan
    const matches = [];
    for (const key of keySet) {
      const strategy = this.cache.get(key);
      if (strategy) {
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
    const key = this.generateKey(exchange, symbol, strategy.interval, oc, botId);
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
    this.indexBySymbol.clear();
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

  /**
   * Add or update a single strategy to cache (hot-update)
   * Useful when strategy is created/updated without full cache refresh
   * @param {Object} strategy - Strategy object
   * @returns {boolean} True if added/updated, false if invalid
   */
  addStrategy(strategy) {
    const exchange = (strategy.exchange || '').toLowerCase();
    const symbol = String(strategy.symbol || '').toUpperCase().replace(/[\/:_]/g, '');
    const oc = Number(strategy.oc || 0);
    const botId = Number(strategy.bot_id || 0);

    // CRITICAL FIX: Allow oc === 0
    if (!exchange || !symbol || Number.isNaN(oc) || !botId) {
      logger.warn(`[StrategyCache] Cannot add invalid strategy ${strategy.id}: exchange=${exchange}, symbol=${symbol}, oc=${oc}, botId=${botId}`);
      return false;
    }

    const key = this.generateKey(exchange, symbol, strategy.interval, oc, botId);
    this._addToIndexes(key, strategy);
    logger.debug(`[StrategyCache] Added strategy ${strategy.id} to cache (key: ${key})`);
    return true;
  }

  /**
   * Remove a single strategy from cache (hot-update)
   * Useful when strategy is deleted without full cache refresh
   * @param {Object} strategy - Strategy object (must have id, exchange, symbol, oc, bot_id)
   * @returns {boolean} True if removed, false if not found
   */
  removeStrategy(strategy) {
    const exchange = (strategy.exchange || '').toLowerCase();
    const symbol = String(strategy.symbol || '').toUpperCase().replace(/[\/:_]/g, '');
    const oc = Number(strategy.oc || 0);
    const botId = Number(strategy.bot_id || 0);

    if (!exchange || !symbol || Number.isNaN(oc) || !botId) {
      logger.warn(`[StrategyCache] Cannot remove invalid strategy ${strategy.id}`);
      return false;
    }

    const key = this.generateKey(exchange, symbol, oc, botId);
    const existed = this.cache.has(key);
    this._removeFromIndexes(key);
    
    if (existed) {
      logger.debug(`[StrategyCache] Removed strategy ${strategy.id} from cache (key: ${key})`);
    }
    return existed;
  }

  /**
   * Update a single strategy in cache (hot-update)
   * Useful when strategy is updated without full cache refresh
   * @param {Object} strategy - Updated strategy object
   * @returns {boolean} True if updated, false if invalid or not found
   */
  updateStrategy(strategy) {
    const exchange = (strategy.exchange || '').toLowerCase();
    const symbol = String(strategy.symbol || '').toUpperCase().replace(/[\/:_]/g, '');
    const oc = Number(strategy.oc || 0);
    const botId = Number(strategy.bot_id || 0);

    // CRITICAL FIX: Allow oc === 0
    if (!exchange || !symbol || Number.isNaN(oc) || !botId) {
      logger.warn(`[StrategyCache] Cannot update invalid strategy ${strategy.id}`);
      return false;
    }

    const key = this.generateKey(exchange, symbol, oc, botId);
    
    // Check if key changed (exchange/symbol/oc/bot_id changed)
    const oldStrategy = this.cache.get(key);
    if (oldStrategy && oldStrategy.id === strategy.id) {
      // Same key, just update
      this._addToIndexes(key, strategy);
      logger.debug(`[StrategyCache] Updated strategy ${strategy.id} in cache (key: ${key})`);
      return true;
    } else if (oldStrategy) {
      // Key collision (different strategy with same key) - this shouldn't happen but handle it
      logger.warn(`[StrategyCache] Key collision for ${key}: existing strategy ${oldStrategy.id}, new strategy ${strategy.id}`);
      this._addToIndexes(key, strategy);
      return true;
    } else {
      // New key, add it
      this._addToIndexes(key, strategy);
      logger.debug(`[StrategyCache] Added strategy ${strategy.id} to cache (new key: ${key})`);
      return true;
    }
  }

  /**
   * Get all strategies for a specific bot
   * @param {number} botId - Bot ID
   * @returns {Array<Object>} Array of strategies for the bot
   */
  getStrategiesByBot(botId) {
    const matches = [];
    for (const [key, strategy] of this.cache.entries()) {
      if (Number(strategy.bot_id) === Number(botId)) {
        matches.push(strategy);
      }
    }
    return matches;
  }
}

// Export singleton instance
export const strategyCache = new StrategyCache();

