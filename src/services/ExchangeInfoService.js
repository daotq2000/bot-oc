import ccxt from 'ccxt';
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
  constructor({ symbolFilterDAO = SymbolFilter, binanceClientFactory = (apiKey, secretKey, isTestnet = false, exInfoSvc = null) => new BinanceDirectClient(apiKey, secretKey, isTestnet, exInfoSvc), mexcFactory = () => new ccxt.mexc({ enableRateLimit: true, options: { defaultType: 'swap' } }), loggerInst = logger, config = configService } = {}) {
    this.filtersCache = new Map(); // symbol -> { tickSize, stepSize, minNotional, maxLeverage, lastAccess }
    this.isInitialized = false;
    this.symbolFilterDAO = symbolFilterDAO;
    this.binanceClientFactory = binanceClientFactory;
    this.mexcFactory = mexcFactory;
    this.logger = loggerInst;
    this.config = config;
    this.maxCacheSize = 2000; // Maximum number of symbols to cache (reduced from 10000 to save memory)
    this.cacheCleanupInterval = 2 * 60 * 1000; // Cleanup every 2 minutes (reduced from 30 minutes)
    this._cleanupTimer = null;
    this._startCacheCleanup();
  }

  _startCacheCleanup() {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
    this._cleanupTimer = setInterval(() => this._cleanupCache(), this.cacheCleanupInterval);
  }

  _cleanupCache() {
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // Remove entries older than 10 minutes (reduced from 1 hour)
    let removed = 0;

    // Remove old entries
    for (const [symbol, data] of this.filtersCache.entries()) {
      if (data.lastAccess && (now - data.lastAccess > maxAge)) {
        this.filtersCache.delete(symbol);
        removed++;
      }
    }

    // If still over limit, remove least recently used
    if (this.filtersCache.size > this.maxCacheSize) {
      const entries = Array.from(this.filtersCache.entries())
        .filter(([_, data]) => data.lastAccess)
        .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
      const toRemove = entries.slice(0, this.filtersCache.size - this.maxCacheSize);
      for (const [symbol] of toRemove) {
        this.filtersCache.delete(symbol);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger.debug(`[ExchangeInfoService] Cleaned up ${removed} cache entries. Current size: ${this.filtersCache.size}`);
    }
  }

  /**
   * Return list of symbols from DB symbol_filters for a given exchange.
   * Options:
   * - onlyUSDT: keep only symbols ending with USDT (default true)
   * - limit: cap number of results (optional)
   */
  async getSymbolsFromDB(exchange, onlyUSDT = true, limit = null) {
    try {
      const rows = await this.symbolFilterDAO.findAll();
      const ex = String(exchange || '').toLowerCase();
      let syms = rows
        .filter(r => (r.exchange || '').toLowerCase() === ex)
        .map(r => (r.symbol || '').toUpperCase())
        .filter(s => s);
      if (onlyUSDT) syms = syms.filter(s => s.endsWith('USDT'));
      // Unique and sorted by name
      const uniq = Array.from(new Set(syms)).sort();
      if (Number.isFinite(limit) && limit > 0) return uniq.slice(0, limit);
      return uniq;
    } catch (e) {
      this.logger.warn(`[ExchangeInfoService] getSymbolsFromDB failed for ${exchange}: ${e?.message || e}`);
      return [];
    }
  }

  // Utility: convert precision digits to step size string, e.g. 3 -> '0.001'
  precisionToStep(precision) {
    if (precision === undefined || precision === null) return null;
    const p = parseInt(precision);
    if (!Number.isFinite(p) || p < 0) return null;
    return (1 / Math.pow(10, p)).toFixed(p);
  }

  // Utility: choose first non-empty value
  pick(...args) {
    for (const v of args) {
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
  }

  /**
   * Fetch all symbol filters from Binance and update the database.
   * This should be called on bot startup.
   */
  async updateFiltersFromExchange() {
    this.logger.info('Updating symbol filters from Binance...');
    try {
      const binanceClient = this.binanceClientFactory('', '', false, this); // No keys needed for public data
      const exchangeInfo = await binanceClient.getExchangeInfo();

      if (!exchangeInfo || !exchangeInfo.symbols) {
        this.logger.error('Failed to fetch exchange info from Binance.');
        return;
      }

      const filtersToSave = [];
      for (const symbolInfo of exchangeInfo.symbols) {
        if (symbolInfo.status !== 'TRADING') continue;
        // Futures-only USDT-margined perpetual contracts
        const quote = (symbolInfo.quoteAsset || '').toUpperCase();
        const contractType = (symbolInfo.contractType || '').toUpperCase();
        if (quote !== 'USDT' || (contractType && contractType !== 'PERPETUAL')) continue;

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

      // Get current symbols from DB for this exchange
      const currentDbSymbols = await this.symbolFilterDAO.getSymbolsByExchange('binance');
      const exchangeSymbols = filtersToSave.map(f => f.symbol.toUpperCase());

      // Delete symbols that are no longer available on exchange
      const deletedCount = await this.symbolFilterDAO.deleteByExchangeAndSymbols('binance', exchangeSymbols);
      if (deletedCount > 0) {
        this.logger.info(`Deleted ${deletedCount} delisted/unavailable Binance symbols from database.`);
        
        // Also delete strategies for delisted symbols
        try {
          const currentDbSymbols = await this.symbolFilterDAO.getSymbolsByExchange('binance');
          const delistedSymbols = currentDbSymbols.filter(s => !exchangeSymbols.includes(s));
          
          if (delistedSymbols.length > 0) {
            const deletedStrategiesCount = await Strategy.deleteBySymbols('binance', delistedSymbols);
            if (deletedStrategiesCount > 0) {
              this.logger.info(`Deleted ${deletedStrategiesCount} strategies for ${delistedSymbols.length} delisted Binance symbols: ${delistedSymbols.join(', ')}`);
            }
          }
        } catch (e) {
          this.logger.error('Failed to delete strategies for delisted Binance symbols:', e?.message || e);
        }
      }

      // Bulk insert/update into the database
      await this.symbolFilterDAO.bulkUpsert(filtersToSave);
      this.logger.info(`Successfully updated ${filtersToSave.length} Binance symbol filters in the database.`);

      // Clear and reload the in-memory cache
      this.filtersCache.clear();
      await this.loadFiltersFromDB();

    } catch (error) {
      this.logger.error('Error updating symbol filters (Binance):', error);
    }
  }

  /**
   * Fetch all MEXC USDT-M swap markets and update symbol_filters.
   */
  async updateMexcFiltersFromExchange() {
    this.logger.info('Updating symbol filters from MEXC...');
    try {
      const mexc = this.mexcFactory();
      // Force .co domain base and add fetch failsafe
      try {
        const co = 'https://api.mexc.co';
        const coContract = 'https://contract.mexc.co';
        if ('hostname' in mexc) mexc.hostname = 'mexc.co';
        mexc.urls = mexc.urls || {};
        mexc.urls.api = mexc.urls.api || {};
        Object.assign(mexc.urls.api, {
          public: co,
          private: co,
          spot: co,
          spotPublic: co,
          spotPrivate: co,
          contract: coContract,
          contractPublic: coContract,
          contractPrivate: coContract
        });
        mexc.urls.www = 'https://www.mexc.co';
        // Failsafe fetch patch
        const _origFetch = mexc.fetch.bind(mexc);
        mexc.fetch = async (url, method = 'GET', headers, body) => {
          let u = typeof url === 'string' ? url : (url?.toString?.() || '');
          u = u.replace(/mexc\.com/g, 'mexc.co');
          if (/^undefined/.test(u)) u = u.replace(/^undefined/, co);
          if (/^\//.test(u)) u = co + u;
          return _origFetch(u, method, headers, body);
        };
      } catch (_) {}
      // Explicitly fetch swap markets from the correct public endpoint to avoid 404s
      await mexc.fetchMarkets({ 'type': 'swap' });

      const filtersToSave = [];
      const markets = mexc.markets || {};
      for (const marketId in markets) {
        const m = markets[marketId];
        if (!m) continue;
        // Only USDT-margined swap markets that are active
        if ((m.type !== 'swap' && m.contract !== true) || (m.quote && m.quote.toUpperCase() !== 'USDT')) continue;
        if (m.active === false) continue;

        // Normalize symbol to e.g., BTCUSDT
        const symbol = `${(m.base || '').toUpperCase()}${(m.quote || '').toUpperCase()}`;

        // Precision -> tick/step sizes
        let tickSize = null;
        let stepSize = null;
        const pricePrec = this.pick(m.precision?.price, m.info?.priceScale);
        const amountPrec = this.pick(m.precision?.amount, m.info?.volScale, m.info?.quantityScale);
        if (pricePrec !== null && pricePrec !== undefined) {
          const p = parseInt(pricePrec);
          if (Number.isFinite(p) && p >= 0) tickSize = this.precisionToStep(p);
        }
        if (amountPrec !== null && amountPrec !== undefined) {
          const p = parseInt(amountPrec);
          if (Number.isFinite(p) && p >= 0) stepSize = this.precisionToStep(p);
        }

        // Limits -> min notional and leverage
        let minNotional = null;
        if (m.limits?.cost?.min !== undefined) {
          minNotional = Number(m.limits.cost.min);
        } else if (m.info?.minCost !== undefined) {
          minNotional = Number(m.info.minCost);
        } else if (m.info?.minNotional !== undefined) {
          minNotional = Number(m.info.minNotional);
        }

        let maxLeverage = null;
        if (m.limits?.leverage?.max !== undefined) {
          maxLeverage = Number(m.limits.leverage.max);
        } else if (m.info?.maxLeverage !== undefined) {
          maxLeverage = Number(m.info.maxLeverage);
        } else if (m.info?.leverage_max !== undefined) {
          maxLeverage = Number(m.info.leverage_max);
        }

        // Fallback defaults
        if (!tickSize) tickSize = '0.0001';
        if (!stepSize) stepSize = '0.001';
        if (!minNotional || !Number.isFinite(minNotional)) minNotional = 5; // conservative default
        if (!maxLeverage || !Number.isFinite(maxLeverage)) maxLeverage = 50; // typical on MEXC

        filtersToSave.push({
          exchange: 'mexc',
          symbol,
          tick_size: tickSize,
          step_size: stepSize,
          min_notional: minNotional,
          max_leverage: maxLeverage
        });
      }

      if (filtersToSave.length === 0) {
        const futuresOnly = this.config.getBoolean('MEXC_FUTURES_ONLY', true)
        if (futuresOnly) {
          this.logger.warn('No MEXC swap markets via CCXT. Futures-only mode: skipping spot fallback.');
          return;
        }
        this.logger.warn('No MEXC swap markets via CCXT. Falling back to /api/v3/exchangeInfo');
        await this.updateMexcFiltersFromSpotExchangeInfo();
        return;
      }

      // Get current symbols from DB for this exchange
      const currentDbSymbols = await this.symbolFilterDAO.getSymbolsByExchange('mexc');
      const exchangeSymbols = filtersToSave.map(f => f.symbol.toUpperCase());

      // Delete symbols that are no longer available on exchange
      const deletedCount = await this.symbolFilterDAO.deleteByExchangeAndSymbols('mexc', exchangeSymbols);
      if (deletedCount > 0) {
        this.logger.info(`Deleted ${deletedCount} delisted/unavailable MEXC symbols from database.`);
        
        // Also delete strategies for delisted symbols
        try {
          const currentDbSymbols = await this.symbolFilterDAO.getSymbolsByExchange('mexc');
          const delistedSymbols = currentDbSymbols.filter(s => !exchangeSymbols.includes(s));
          
          if (delistedSymbols.length > 0) {
            const deletedStrategiesCount = await Strategy.deleteBySymbols('mexc', delistedSymbols);
            if (deletedStrategiesCount > 0) {
              this.logger.info(`Deleted ${deletedStrategiesCount} strategies for ${delistedSymbols.length} delisted MEXC symbols: ${delistedSymbols.join(', ')}`);
            }
          }
        } catch (e) {
          this.logger.error('Failed to delete strategies for delisted MEXC symbols:', e?.message || e);
        }
      }

      await this.symbolFilterDAO.bulkUpsert(filtersToSave);
      this.logger.info(`Successfully updated ${filtersToSave.length} MEXC symbol filters in the database.`);

      // Refresh cache
      this.filtersCache.clear();
      await this.loadFiltersFromDB();
    } catch (e) {
      this.logger.error('Error updating symbol filters (MEXC) via CCXT:', e);
      const futuresOnly = this.config.getBoolean('MEXC_FUTURES_ONLY', true)
      if (futuresOnly) {
        this.logger.warn('Futures-only mode enabled: skipping MEXC spot exchangeInfo fallback.');
        return;
      }
      this.logger.info('Falling back to MEXC spot exchangeInfo (REST) ...');
      await this.updateMexcFiltersFromSpotExchangeInfo();
    }
  }

  // Fallback: use MEXC spot exchangeInfo endpoint to get symbols
  async updateMexcFiltersFromSpotExchangeInfo() {
    try {
      const url = 'https://api.mexc.co/api/v3/exchangeInfo';
      const res = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      const data = await res.json();
      const symbols = data?.symbols || [];
      const filtersToSave = [];
      for (const s of symbols) {
        const status = (s.status || '').toUpperCase();
        const quote = (s.quoteAsset || '').toUpperCase();
        if (status !== 'TRADING' || quote !== 'USDT') continue;
        const symbol = (s.symbol || `${(s.baseAsset||'').toUpperCase()}USDT`).toUpperCase();

        // Parse filters similar to Binance-compatible schema
        const priceFilter = Array.isArray(s.filters) ? s.filters.find(f => f.filterType === 'PRICE_FILTER') : null;
        const lotSizeFilter = Array.isArray(s.filters) ? s.filters.find(f => f.filterType === 'LOT_SIZE') : null;
        const minNotionalFilter = Array.isArray(s.filters) ? s.filters.find(f => f.filterType === 'MIN_NOTIONAL') : null;

        const tickSize = priceFilter?.tickSize || (Number.isFinite(s.quotePrecision) ? (1/Math.pow(10, s.quotePrecision)).toFixed(s.quotePrecision) : '0.0001');
        const stepSize = lotSizeFilter?.stepSize || (Number.isFinite(s.baseAssetPrecision) ? (1/Math.pow(10, s.baseAssetPrecision)).toFixed(s.baseAssetPrecision) : '0.001');
        const minNotional = Number(minNotionalFilter?.minNotional || minNotionalFilter?.notional || 5);
        const maxLeverage = 50; // Spot API doesn't include leverage; use conservative default

        filtersToSave.push({
          exchange: 'mexc',
          symbol,
          tick_size: tickSize,
          step_size: stepSize,
          min_notional: minNotional,
          max_leverage: maxLeverage
        });
      }

      if (filtersToSave.length === 0) {
        this.logger.warn('MEXC REST fallback returned no symbols. Skipping update.');
        return;
      }

      // Get current symbols from DB for this exchange
      const currentDbSymbols = await this.symbolFilterDAO.getSymbolsByExchange('mexc');
      const exchangeSymbols = filtersToSave.map(f => f.symbol.toUpperCase());

      // Delete symbols that are no longer available on exchange
      const deletedCount = await this.symbolFilterDAO.deleteByExchangeAndSymbols('mexc', exchangeSymbols);
      if (deletedCount > 0) {
        this.logger.info(`Deleted ${deletedCount} delisted/unavailable MEXC symbols from database (REST fallback).`);
        
        // Also delete strategies for delisted symbols
        try {
          const currentDbSymbols = await this.symbolFilterDAO.getSymbolsByExchange('mexc');
          const delistedSymbols = currentDbSymbols.filter(s => !exchangeSymbols.includes(s));
          
          if (delistedSymbols.length > 0) {
            const deletedStrategiesCount = await Strategy.deleteBySymbols('mexc', delistedSymbols);
            if (deletedStrategiesCount > 0) {
              this.logger.info(`Deleted ${deletedStrategiesCount} strategies for ${delistedSymbols.length} delisted MEXC symbols (REST fallback): ${delistedSymbols.join(', ')}`);
            }
          }
        } catch (e) {
          this.logger.error('Failed to delete strategies for delisted MEXC symbols (REST fallback):', e?.message || e);
        }
      }

      await this.symbolFilterDAO.bulkUpsert(filtersToSave);
      this.logger.info(`Successfully updated ${filtersToSave.length} MEXC symbol filters from REST spot exchangeInfo.`);

      // Refresh cache
      this.filtersCache.clear();
      await this.loadFiltersFromDB();
    } catch (err) {
      this.logger.error('MEXC REST fallback failed:', err?.message || err);
    }
  }

  /**
   * Fetch tradable futures symbols from Binance mainnet (USDT-M).
   * @returns {Promise<Set<string>>} Set of normalized tradable symbols (e.g., BTCUSDT)
   */
  async getTradableSymbolsFromBinance() {
    try {
      const client = this.binanceClientFactory('', '', false, this);
      const info = await client.getExchangeInfo();
      const set = new Set();
      if (info?.symbols?.length) {
        for (const s of info.symbols) {
          if (s.status !== 'TRADING') continue;
          // Only USDT-margined perpetual contracts
          const quote = (s.quoteAsset || '').toUpperCase();
          const contractType = (s.contractType || '').toUpperCase();
          if (quote === 'USDT' && (contractType === 'PERPETUAL' || contractType === '')) {
            set.add((s.symbol || '').toUpperCase());
          }
        }
      }
      return set;
    } catch (e) {
      this.logger.error('getTradableSymbolsFromBinance failed:', e?.message || e);
      return new Set();
    }
  }

  /**
   * Fetch tradable USDT-M swap symbols from MEXC
   * @returns {Promise<Set<string>>}
   */
  async getTradableSymbolsFromMexc() {
    try {
      const mexc = this.mexcFactory();
      await mexc.loadMarkets();
      const set = new Set();
      for (const id in mexc.markets) {
        const m = mexc.markets[id];
        if (!m) continue;
        // Only USDT-margined swap and active
        const isSwap = m.type === 'swap' || m.contract === true;
        const isUsdt = (m.quote || '').toUpperCase() === 'USDT';
        if (!isSwap || !isUsdt || m.active === false) continue;
        const sym = `${(m.base || '').toUpperCase()}USDT`;
        set.add(sym);
      }
      return set;
    } catch (e) {
      this.logger.error('getTradableSymbolsFromMexc failed:', e?.message || e);
      return new Set();
    }
  }

  /**
   * Normalize symbol to Binance format (reuse minimal logic)
   */
  normalizeSymbol(symbol) {
    if (!symbol) return symbol;
    let normalized = symbol.toString().toUpperCase().replace(/[/:_]/g, '');
    if (normalized.endsWith('USD') && !normalized.endsWith('USDT')) {
      normalized = normalized.replace(/USD$/, 'USDT');
    }
    return normalized;
  }


  /**
   * Load all symbol filters from the database into the in-memory cache.
   */
  async loadFiltersFromDB() {
    this.logger.info('Loading symbol filters from database into cache...');
    try {
      const filters = await this.symbolFilterDAO.findAll();
      // Prefer Binance filters when duplicate symbols exist.
      // Load Binance first; for other exchanges, only set if not present.
      const sorted = filters.sort((a, b) => {
        const pa = (a.exchange || '').toLowerCase() === 'binance' ? 0 : 1;
        const pb = (b.exchange || '').toLowerCase() === 'binance' ? 0 : 1;
        return pa - pb;
      });
      for (const filter of sorted) {
        const key = (filter.symbol || '').toUpperCase();
        if (!key) continue;
        if (this.filtersCache.has(key) && (filter.exchange || '').toLowerCase() !== 'binance') {
          // Skip non-Binance if symbol already populated (keeps Binance defaults)
          continue;
        }
        // Enforce max cache size (LRU eviction)
        if (this.filtersCache.size >= this.maxCacheSize && !this.filtersCache.has(key)) {
          const oldest = Array.from(this.filtersCache.entries())
            .filter(([_, data]) => data.lastAccess)
            .sort((a, b) => a[1].lastAccess - b[1].lastAccess)[0];
          if (oldest) this.filtersCache.delete(oldest[0]);
        }
        this.filtersCache.set(key, {
          tickSize: filter.tick_size,
          stepSize: filter.step_size,
          minNotional: filter.min_notional,
          maxLeverage: filter.max_leverage || 125,
          lastAccess: Date.now()
        });
      }
      this.isInitialized = true;
      this.logger.info(`Loaded ${this.filtersCache.size} symbol filters into cache.`);
    } catch (error) {
      this.logger.error('Error loading symbol filters from DB:', error);
    }
  }

  /**
   * Get the filters for a specific symbol from the cache.
   * @param {string} symbol - The trading symbol (e.g., BTCUSDT)
   * @returns {Object|null} The filters or null if not found.
   */
  getFilters(symbol) {
    if (!this.isInitialized) {
      this.logger.warn('ExchangeInfoService not initialized. Filters may be stale.');
    }
    const key = symbol.toUpperCase();
    const cached = this.filtersCache.get(key);
    if (cached) {
      cached.lastAccess = Date.now();
    }
    return cached;
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

// Export class for testing and singleton instance for production
export { ExchangeInfoService };
export const exchangeInfoService = new ExchangeInfoService();

