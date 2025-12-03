import { BinanceDirectClient } from './BinanceDirectClient.js';
import { SymbolFilter } from '../models/SymbolFilter.js';
import logger from '../utils/logger.js';

/**
 * Exchange Info Service - Manages fetching and caching of symbol filters
 */
class ExchangeInfoService {
  constructor() {
    this.filtersCache = new Map(); // symbol -> { tickSize, stepSize, minNotional }
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
          filtersToSave.push({
            exchange: 'binance',
            symbol: symbolInfo.symbol,
            tick_size: priceFilter.tickSize,
            step_size: lotSizeFilter.stepSize,
            min_notional: minNotionalFilter.notional
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
          minNotional: filter.min_notional
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
}

// Export a singleton instance
export const exchangeInfoService = new ExchangeInfoService();

