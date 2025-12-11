import { BinanceDirectClient } from './BinanceDirectClient.js';
import { SymbolFilter } from '../models/SymbolFilter.js';
import { Strategy } from '../models/Strategy.js';
import { PriceAlertConfig } from '../models/PriceAlertConfig.js';
import { configService } from './ConfigService.js';
import logger from '../utils/logger.js';

/**
 * Exchange Info Service - Manages fetching and caching of symbol filters
 */
class ExchangeInfoService {
  constructor() {
    this.filtersCache = new Map(); // symbol -> { tickSize, stepSize, minNotional, maxLeverage }
    this.isInitialized = false;
  }

  /**
   * Fetch all symbol filters from Binance and update the database.
   * This should be called on bot startup.
   */
  async updateFiltersFromExchange() {
    logger.info('Updating symbol filters from Binance...');
    try {
      const binanceClient = new BinanceDirectClient('', '', false); // No keys needed for public data
      const exchangeInfo = await binanceClient.getExchangeInfo();

      if (!exchangeInfo || !exchangeInfo.symbols) {
        logger.error('Failed to fetch exchange info from Binance.');
        return;
      }

      const filtersToSave = [];
      for (const symbolInfo of exchangeInfo.symbols) {
        if (symbolInfo.status !== 'TRADING') continue;

        const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
        const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
        const minNotionalFilter = symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');

        if (priceFilter && lotSizeFilter && minNotionalFilter) {
          // Extract max leverage from symbol info
          let maxLeverage = 125; // Default max leverage for Binance Futures
          if (symbolInfo.leverageBrackets && symbolInfo.leverageBrackets.length > 0) {
            // Get the highest initial leverage from brackets
            const maxBracket = symbolInfo.leverageBrackets.reduce((max, bracket) => {
              const leverage = parseInt(bracket.initialLeverage || 0);
              return leverage > parseInt(max.initialLeverage || 0) ? bracket : max;
            });
            maxLeverage = parseInt(maxBracket.initialLeverage || 125);
          }

          filtersToSave.push({
            exchange: 'binance',
            symbol: symbolInfo.symbol,
            tick_size: priceFilter.tickSize,
            step_size: lotSizeFilter.stepSize,
            min_notional: minNotionalFilter.notional,
            max_leverage: maxLeverage
          });
        }
      }

      // Bulk insert/update into the database
      await SymbolFilter.bulkUpsert(filtersToSave);
      logger.info(`Successfully updated ${filtersToSave.length} symbol filters in the database.`);

      // Clear and reload the in-memory cache
      this.filtersCache.clear();
      await this.loadFiltersFromDB();

    } catch (error) {
      logger.error('Error updating symbol filters:', error);
    }
  }

  /**
   * Fetch tradable futures symbols from Binance mainnet (USDT-M).
   * @returns {Promise<Set<string>>} Set of normalized tradable symbols (e.g., BTCUSDT)
   */
  async getTradableSymbolsFromBinance() {
    try {
      const client = new BinanceDirectClient('', '', false);
      const info = await client.getExchangeInfo();
      const set = new Set();
      if (info?.symbols?.length) {
        for (const s of info.symbols) {
          if (s.status === 'TRADING') {
            set.add((s.symbol || '').toUpperCase());
          }
        }
      }
      return set;
    } catch (e) {
      logger.error('getTradableSymbolsFromBinance failed:', e?.message || e);
      return new Set();
    }
  }

  /**
   * Normalize symbol to Binance format (reuse minimal logic)
   */
  normalizeSymbol(symbol) {
    if (!symbol) return symbol;
    let normalized = symbol.toString().toUpperCase().replace(/[/:]/g, '');
    if (normalized.endsWith('USD') && !normalized.endsWith('USDT')) {
      normalized = normalized.replace(/USD$/, 'USDT');
    }
    return normalized;
  }

  /**
   * Prune delisted symbols from strategies and price alert configs for Binance.
   * - Deletes strategies whose symbol is not tradable on Binance futures mainnet
   * - Removes symbols from price alert configs; deactivates config if empty
   */
  async pruneDelistedSymbols() {
    try {
      logger.info('[Prune] Starting delisted symbols cleanup for Binance');
      const tradable = await this.getTradableSymbolsFromBinance();
      if (tradable.size === 0) {
        logger.warn('[Prune] Tradable symbols set is empty; skip pruning to avoid accidental mass deletion');
        return;
      }

      // 1) Prune strategies
      const strategies = await Strategy.findAll(null, true);
      let deletedCount = 0;
      for (const s of strategies) {
        if ((s.exchange || '').toLowerCase() !== 'binance') continue;
        const sym = this.normalizeSymbol(s.symbol);
        if (!tradable.has(sym)) {
          await Strategy.delete(s.id);
          deletedCount++;
          logger.info(`[Prune] Deleted strategy ${s.id} (${s.symbol}) - not tradable on Binance mainnet`);
        }
      }

      // 2) Prune price alert configs (binance only)
      const alertConfigs = await PriceAlertConfig.findAll('binance');
      let updatedAlertConfigs = 0;
      let deactivatedAlertConfigs = 0;
      for (const cfg of alertConfigs) {
        const original = Array.isArray(cfg.symbols) ? cfg.symbols : [];
        const filtered = original
          .map(sym => this.normalizeSymbol(sym))
          .filter(sym => tradable.has(sym));
        if (filtered.length !== original.length) {
          if (filtered.length === 0) {
            await PriceAlertConfig.update(cfg.id, { symbols: [], is_active: false });
            deactivatedAlertConfigs++;
            logger.info(`[Prune] Deactivated alert config ${cfg.id} (no valid symbols remain)`);
          } else {
            await PriceAlertConfig.update(cfg.id, { symbols: filtered });
            updatedAlertConfigs++;
            logger.info(`[Prune] Updated alert config ${cfg.id}: ${original.length} -> ${filtered.length} symbols`);
          }
        }
      }

      logger.info(`[Prune] Completed. Strategies deleted: ${deletedCount}, Alert configs updated: ${updatedAlertConfigs}, deactivated: ${deactivatedAlertConfigs}`);
    } catch (e) {
      logger.error('[Prune] Failed pruning delisted symbols:', e?.message || e);
    }
  }

  /**
   * Load all symbol filters from the database into the in-memory cache.
   */
  async loadFiltersFromDB() {
    logger.info('Loading symbol filters from database into cache...');
    try {
      const filters = await SymbolFilter.findAll();
      for (const filter of filters) {
        this.filtersCache.set(filter.symbol, {
          tickSize: filter.tick_size,
          stepSize: filter.step_size,
          minNotional: filter.min_notional,
          maxLeverage: filter.max_leverage || 125
        });
      }
      this.isInitialized = true;
      logger.info(`Loaded ${this.filtersCache.size} symbol filters into cache.`);
    } catch (error) {
      logger.error('Error loading symbol filters from DB:', error);
    }
  }

  /**
   * Get the filters for a specific symbol from the cache.
   * @param {string} symbol - The trading symbol (e.g., BTCUSDT)
   * @returns {Object|null} The filters or null if not found.
   */
  getFilters(symbol) {
    if (!this.isInitialized) {
      logger.warn('ExchangeInfoService not initialized. Filters may be stale.');
    }
    return this.filtersCache.get(symbol.toUpperCase());
  }

  /**
   * Get tick size for a specific symbol from cache
   * @param {string} symbol - The trading symbol (e.g., BTCUSDT)
   * @returns {string|null} The tick size or null if not found
   */
  getTickSize(symbol) {
    const filters = this.getFilters(symbol);
    return filters ? filters.tickSize : null;
  }

  /**
   * Get step size for a specific symbol from cache
   * @param {string} symbol - The trading symbol (e.g., BTCUSDT)
   * @returns {string|null} The step size or null if not found
   */
  getStepSize(symbol) {
    const filters = this.getFilters(symbol);
    return filters ? filters.stepSize : null;
  }

  /**
   * Get minimum notional for a specific symbol from cache
   * @param {string} symbol - The trading symbol (e.g., BTCUSDT)
   * @returns {number|null} The minimum notional or null if not found
   */
  getMinNotional(symbol) {
    const filters = this.getFilters(symbol);
    return filters ? filters.minNotional : null;
  }

  /**
   * Get maximum leverage for a specific symbol from cache
   * @param {string} symbol - The trading symbol (e.g., BTCUSDT)
   * @returns {number|null} The maximum leverage or null if not found
   */
  getMaxLeverage(symbol) {
    const filters = this.getFilters(symbol);
    return filters ? filters.maxLeverage : null;
  }
}

// Export a singleton instance
export const exchangeInfoService = new ExchangeInfoService();

