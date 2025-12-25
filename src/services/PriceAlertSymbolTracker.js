import { PriceAlertConfig } from '../models/PriceAlertConfig.js';
import { exchangeInfoService } from './ExchangeInfoService.js';
import { configService } from './ConfigService.js';
import logger from '../utils/logger.js';

/**
 * PriceAlertSymbolTracker
 * 
 * Quản lý tracking symbols cho Price Alert system:
 * - Load symbols từ price_alert_config (nếu symbols không rỗng)
 * - Fallback sang symbol_filters nếu symbols rỗng
 * - Group symbols theo exchange (mexc, binance)
 * - Đảm bảo unique symbols per exchange
 */
export class PriceAlertSymbolTracker {
  constructor() {
    this.trackingSymbols = new Map(); // exchange -> Set<symbol>
    this.lastRefreshTime = 0;
    this.refreshTTL = 60000; // 60 seconds (increased from 30s to reduce DB pressure)
    this.isRefreshing = false;
    this._refreshPromise = null; // Promise lock for concurrent refresh prevention
  }

  /**
   * Normalize symbol format
   * @param {string} symbol - Symbol to normalize
   * @returns {string} Normalized symbol
   */
  normalizeSymbol(symbol) {
    if (!symbol) return null;
    return String(symbol).toUpperCase().replace(/[\/:_]/g, '');
  }

  /**
   * Check if cache needs refresh
   * @returns {boolean} True if cache should be refreshed
   */
  needsRefresh() {
    return (Date.now() - this.lastRefreshTime) >= this.refreshTTL;
  }

  /**
   * Refresh tracking symbols from price_alert_config and symbol_filters
   * @param {boolean} force - Force refresh even if TTL not expired
   * @returns {Promise<Map<string, Set<string>>>} Map of exchange -> Set of symbols
   */
  async refresh(force = false) {
    // CRITICAL FIX: Use promise lock to prevent concurrent refreshes
    if (this._refreshPromise) {
      logger.debug('[PriceAlertSymbolTracker] Refresh already in progress, waiting for existing refresh');
      return this._refreshPromise.then(() => this.trackingSymbols);
    }

    // Check cache TTL (unless forced)
    if (!force && this.trackingSymbols.size > 0 && !this.needsRefresh()) {
      logger.debug('[PriceAlertSymbolTracker] Using cached tracking symbols (TTL not expired)');
      return this.trackingSymbols;
    }

    this.isRefreshing = true;
    const startTime = Date.now();

    // Create refresh promise to prevent concurrent refreshes
    this._refreshPromise = (async () => {
      try {
      logger.info('[PriceAlertSymbolTracker] Refreshing tracking symbols...');
      const newTrackingSymbols = new Map();

        // CRITICAL FIX: Cache DB symbols per exchange to avoid N+1 queries
        // Map<exchange, symbol[]>
        const symbolsFromDbByExchange = new Map();

      // Get all active price alert configs
      // Note: PriceAlertConfig.findAll() already filters by is_active = TRUE in SQL
      const configs = await PriceAlertConfig.findAll();
      // Double-check: handle both boolean true and number 1 from MySQL
      const activeConfigs = configs.filter(cfg => cfg.is_active === true || cfg.is_active === 1 || cfg.is_active === '1');

      logger.info(`[PriceAlertSymbolTracker] Found ${activeConfigs.length} active alert configs (total configs: ${configs.length})`);

      for (const config of activeConfigs) {
        const exchange = (config.exchange || 'mexc').toLowerCase();
        
        // Initialize exchange set if not exists
        if (!newTrackingSymbols.has(exchange)) {
          newTrackingSymbols.set(exchange, new Set());
        }

        const exchangeSymbols = newTrackingSymbols.get(exchange);

        // Parse symbols from config
        let symbols = [];
        if (config.symbols) {
          if (typeof config.symbols === 'string') {
            try {
              symbols = JSON.parse(config.symbols);
            } catch (e) {
              logger.warn(`[PriceAlertSymbolTracker] Failed to parse symbols for config ${config.id}: ${e?.message || e}`);
              symbols = [];
            }
          } else if (Array.isArray(config.symbols)) {
            symbols = config.symbols;
          }
        }

        // If symbols array is not empty, use it
        if (Array.isArray(symbols) && symbols.length > 0) {
          logger.debug(`[PriceAlertSymbolTracker] Config ${config.id} (${exchange}): Using ${symbols.length} symbols from config`);
          for (const symbol of symbols) {
            const normalized = this.normalizeSymbol(symbol);
            if (normalized) {
              exchangeSymbols.add(normalized);
            }
          }
            // Log metric per config
            logger.info(`[PriceAlertSymbolTracker] Config ${config.id} (${exchange}): Tracking ${exchangeSymbols.size} unique symbols (from config)`);
        } else {
          // Fallback: Load from symbol_filters table
          logger.debug(`[PriceAlertSymbolTracker] Config ${config.id} (${exchange}): symbols is empty, loading from symbol_filters...`);
          try {
            const useFilters = configService.getBoolean('PRICE_ALERT_USE_SYMBOL_FILTERS', true);
            if (useFilters) {
                // CRITICAL FIX: Cache DB query per exchange to avoid N+1
                if (!symbolsFromDbByExchange.has(exchange)) {
              const maxSymbols = Number(configService.getNumber('PRICE_ALERT_MAX_SYMBOLS', 5000));
              const dbSymbols = await exchangeInfoService.getSymbolsFromDB(exchange, true, maxSymbols);
                  symbolsFromDbByExchange.set(exchange, dbSymbols);
                  logger.info(`[PriceAlertSymbolTracker] Loaded ${dbSymbols.length} symbols from symbol_filters for ${exchange} (cached for other configs)`);
                }
              
                const dbSymbols = symbolsFromDbByExchange.get(exchange);
                const symbolsBefore = exchangeSymbols.size;
              
              for (const symbol of dbSymbols) {
                const normalized = this.normalizeSymbol(symbol);
                if (normalized) {
                  exchangeSymbols.add(normalized);
                }
              }
                
                const symbolsAdded = exchangeSymbols.size - symbolsBefore;
                // Log metric per config
                logger.info(`[PriceAlertSymbolTracker] Config ${config.id} (${exchange}): Tracking ${exchangeSymbols.size} unique symbols (${symbolsAdded} from symbol_filters)`);
            } else {
              logger.debug(`[PriceAlertSymbolTracker] Config ${config.id} (${exchange}): PRICE_ALERT_USE_SYMBOL_FILTERS is disabled, skipping fallback`);
                logger.info(`[PriceAlertSymbolTracker] Config ${config.id} (${exchange}): Tracking 0 symbols (no symbols in config, fallback disabled)`);
            }
          } catch (e) {
            logger.error(`[PriceAlertSymbolTracker] Config ${config.id} (${exchange}): Failed to load symbols from symbol_filters: ${e?.message || e}`);
              logger.info(`[PriceAlertSymbolTracker] Config ${config.id} (${exchange}): Tracking ${exchangeSymbols.size} unique symbols (fallback failed)`);
          }
        }
      }

        // Update tracking symbols (atomic swap)
      this.trackingSymbols = newTrackingSymbols;
      this.lastRefreshTime = Date.now();

      // Log summary
      for (const [exchange, symbols] of this.trackingSymbols.entries()) {
        logger.info(`[PriceAlertSymbolTracker] ${exchange.toUpperCase()}: Tracking ${symbols.size} unique symbols`);
      }

      const duration = Date.now() - startTime;
      logger.info(`[PriceAlertSymbolTracker] Refresh completed in ${duration}ms`);

      return this.trackingSymbols;
    } catch (error) {
      logger.error('[PriceAlertSymbolTracker] Refresh failed:', error?.message || error);
        // Return existing tracking symbols on error (cache preserved)
      return this.trackingSymbols;
    } finally {
      this.isRefreshing = false;
        this._refreshPromise = null;
    }
    })();

    return this._refreshPromise;
  }

  /**
   * Get tracking symbols for a specific exchange
   * CRITICAL FIX: Returns immutable copy to prevent caller from modifying cache
   * @param {string} exchange - Exchange name (mexc, binance)
   * @param {boolean} autoRefresh - Auto refresh if cache is stale (default: true)
   * @returns {Set<string>} Set of normalized symbols (immutable copy)
   */
  getSymbolsForExchange(exchange, autoRefresh = true) {
    // CRITICAL FIX: Auto refresh if cache is stale (lazy refresh)
    if (autoRefresh && this.needsRefresh()) {
      // Trigger refresh in background (non-blocking)
      this.refresh().catch(err => {
        logger.error('[PriceAlertSymbolTracker] Auto refresh failed in getSymbolsForExchange:', err?.message || err);
      });
    }

    const normalizedExchange = (exchange || 'mexc').toLowerCase();
    const symbols = this.trackingSymbols.get(normalizedExchange);
    
    // CRITICAL FIX: Return immutable copy to prevent caller from modifying cache
    return symbols ? new Set(symbols) : new Set();
  }

  /**
   * Get all tracking symbols
   * CRITICAL FIX: Returns immutable copy to prevent caller from modifying cache
   * @param {boolean} autoRefresh - Auto refresh if cache is stale (default: true)
   * @returns {Map<string, Set<string>>} Map of exchange -> Set of symbols (immutable copy)
   */
  getAllSymbols(autoRefresh = true) {
    // CRITICAL FIX: Auto refresh if cache is stale (lazy refresh)
    if (autoRefresh && this.needsRefresh()) {
      // Trigger refresh in background (non-blocking)
      this.refresh().catch(err => {
        logger.error('[PriceAlertSymbolTracker] Auto refresh failed in getAllSymbols:', err?.message || err);
      });
    }

    // CRITICAL FIX: Return immutable copy to prevent caller from modifying cache
    const result = new Map();
    for (const [exchange, symbols] of this.trackingSymbols.entries()) {
      result.set(exchange, new Set(symbols));
    }
    return result;
  }

  /**
   * Check if a symbol is being tracked for an exchange
   * @param {string} exchange - Exchange name
   * @param {string} symbol - Symbol to check
   * @param {boolean} autoRefresh - Auto refresh if cache is stale (default: true)
   * @returns {boolean} True if symbol is tracked
   */
  isTracked(exchange, symbol, autoRefresh = true) {
    // CRITICAL FIX: Auto refresh if cache is stale (lazy refresh)
    if (autoRefresh && this.needsRefresh()) {
      // Trigger refresh in background (non-blocking)
      this.refresh().catch(err => {
        logger.error('[PriceAlertSymbolTracker] Auto refresh failed in isTracked:', err?.message || err);
      });
    }

    const normalizedExchange = (exchange || 'mexc').toLowerCase();
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const exchangeSymbols = this.trackingSymbols.get(normalizedExchange);
    return exchangeSymbols ? exchangeSymbols.has(normalizedSymbol) : false;
  }

  /**
   * Invalidate cache and force refresh on next call
   */
  invalidateCache() {
    this.lastRefreshTime = 0;
    logger.debug('[PriceAlertSymbolTracker] Cache invalidated');
  }
}

// Export singleton instance
export const priceAlertSymbolTracker = new PriceAlertSymbolTracker();

