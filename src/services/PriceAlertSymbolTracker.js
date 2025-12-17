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
    this.refreshTTL = 30000; // 30 seconds
    this.isRefreshing = false;
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
   * Refresh tracking symbols from price_alert_config and symbol_filters
   * @returns {Promise<Map<string, Set<string>>>} Map of exchange -> Set of symbols
   */
  async refresh() {
    // Prevent concurrent refreshes
    if (this.isRefreshing) {
      logger.debug('[PriceAlertSymbolTracker] Refresh already in progress, skipping');
      return this.trackingSymbols;
    }

    this.isRefreshing = true;
    const startTime = Date.now();

    try {
      // Check cache
      if (this.trackingSymbols.size > 0 && (Date.now() - this.lastRefreshTime) < this.refreshTTL) {
        logger.debug('[PriceAlertSymbolTracker] Using cached tracking symbols');
        return this.trackingSymbols;
      }

      logger.info('[PriceAlertSymbolTracker] Refreshing tracking symbols...');
      const newTrackingSymbols = new Map();

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
        } else {
          // Fallback: Load from symbol_filters table
          logger.debug(`[PriceAlertSymbolTracker] Config ${config.id} (${exchange}): symbols is empty, loading from symbol_filters...`);
          try {
            const useFilters = configService.getBoolean('PRICE_ALERT_USE_SYMBOL_FILTERS', true);
            if (useFilters) {
              const maxSymbols = Number(configService.getNumber('PRICE_ALERT_MAX_SYMBOLS', 5000));
              const dbSymbols = await exchangeInfoService.getSymbolsFromDB(exchange, true, maxSymbols);
              
              logger.info(`[PriceAlertSymbolTracker] Config ${config.id} (${exchange}): Loaded ${dbSymbols.length} symbols from symbol_filters`);
              
              for (const symbol of dbSymbols) {
                const normalized = this.normalizeSymbol(symbol);
                if (normalized) {
                  exchangeSymbols.add(normalized);
                }
              }
            } else {
              logger.debug(`[PriceAlertSymbolTracker] Config ${config.id} (${exchange}): PRICE_ALERT_USE_SYMBOL_FILTERS is disabled, skipping fallback`);
            }
          } catch (e) {
            logger.error(`[PriceAlertSymbolTracker] Config ${config.id} (${exchange}): Failed to load symbols from symbol_filters: ${e?.message || e}`);
          }
        }
      }

      // Update tracking symbols
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
      // Return existing tracking symbols on error
      return this.trackingSymbols;
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Get tracking symbols for a specific exchange
   * @param {string} exchange - Exchange name (mexc, binance)
   * @returns {Set<string>} Set of normalized symbols
   */
  getSymbolsForExchange(exchange) {
    const normalizedExchange = (exchange || 'mexc').toLowerCase();
    return this.trackingSymbols.get(normalizedExchange) || new Set();
  }

  /**
   * Get all tracking symbols
   * @returns {Map<string, Set<string>>} Map of exchange -> Set of symbols
   */
  getAllSymbols() {
    return this.trackingSymbols;
  }

  /**
   * Check if a symbol is being tracked for an exchange
   * @param {string} exchange - Exchange name
   * @param {string} symbol - Symbol to check
   * @returns {boolean} True if symbol is tracked
   */
  isTracked(exchange, symbol) {
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

