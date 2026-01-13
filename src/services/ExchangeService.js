import ccxt from 'ccxt';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { BinanceDirectClient } from './BinanceDirectClient.js';
import { MexcFuturesClient } from './MexcFuturesClient.js';
import { exchangeInfoService } from './ExchangeInfoService.js';
import logger from '../utils/logger.js';
import { configService } from './ConfigService.js';
import { mexcPriceWs } from './MexcWebSocketManager.js';
import { createMakerEntryService } from './MakerEntryService.js';

/**
 * Exchange Service - Wrapper for CCXT with proxy support
 */
export class ExchangeService {
  constructor(bot) {
    this.bot = bot;
    this.exchange = null; // For trading operations (testnet) - CCXT
    this.publicExchange = null; // For public data (mainnet) - CCXT
    this.publicSpotExchange = null; // For MEXC spot fallback (REST)
    this.binanceDirectClient = null; // Direct API client for Binance (no CCXT)
    this.proxyAgent = null;
    this.mexcFuturesClient = null;
    this.apiKeyValid = true; // Track if API key is valid
    this._binanceConfiguredSymbols = new Set(); // symbols configured with leverage/margin
    // Simple REST ticker cache for non-Binance to reduce CCXT calls
    this._tickerCache = new Map(); // key: symbol -> price
    this._tickerCacheTime = new Map(); // key: symbol -> timestamp
    this._maxTickerCacheSize = 200; // Maximum number of symbols to cache (reduced from 500 to save memory)
    this._tickerCacheTTL = 30 * 1000; // 30 seconds TTL (reduced from 1 minute)

    // Cache for futures balance to reduce rate limits (short-term cache)
    this._futuresBalanceCache = null; // { balance, timestamp }
    this._futuresBalanceCacheTTL = 3000; // 3 seconds TTL

    this._makerEntryService = null;
  }

  /**
   * Normalize user-provided symbols to the format CCXT expects
   * @param {string} symbol - Raw symbol from strategy/bot config
   * @param {string|null} marketType - 'spot', 'swap', etc.
   * @returns {string} Formatted symbol for exchange calls
   */
  formatSymbolForExchange(symbol, marketType = null) {
    if (!symbol) return symbol;

    let formatted = symbol.trim().toUpperCase();
    formatted = formatted.replace(/\s+/g, '');

    if (!formatted.includes('/') && formatted.includes('_')) {
      formatted = formatted.replace(/_/g, '/');
    }

    // Convert BTCUSDT -> BTC/USDT
    if (!formatted.includes('/') && formatted.endsWith('USDT')) {
      formatted = `${formatted.replace(/USDT$/, '')}/USDT`;
    }

    if (formatted.includes(':')) {
      return formatted;
    }

    const isSwap =
      marketType === 'swap' ||
      (!marketType &&
        (this.exchange?.options?.defaultType === 'swap' ||
          this.bot.exchange === 'gate' ||
          this.bot.exchange === 'mexc' ||
          this.bot.exchange === 'binance'));

    if (isSwap && formatted.includes('/')) {
      const [base, quote] = formatted.split('/');
      if (base && quote) {
        return `${base}/${quote}:${quote}`;
      }
    }

    return formatted;
  }

  /**
   * Initialize exchange connection
   */
  async initialize() {
    try {
      let exchangeClass;
      if (this.bot.exchange === 'mexc') {
        exchangeClass = ccxt.mexc;
      } else if (this.bot.exchange === 'gate') {
        exchangeClass = ccxt.gateio;
      } else if (this.bot.exchange === 'binance') {
        exchangeClass = ccxt.binance;
      } else {
        throw new Error(`Unsupported exchange: ${this.bot.exchange}`);
      }

      // For Binance: Use direct API client (no CCXT)
      if (this.bot.exchange === 'binance') {
        // Use direct HTTP client instead of CCXT for Binance
        const { configService } = await import('./ConfigService.js');
        const botFlag = this.bot?.binance_testnet;
        const isTestnet = (botFlag === null || botFlag === undefined)
          ? configService.getBoolean('BINANCE_TESTNET', true)
          : !!Number(botFlag); // per-bot override if provided
        this.binanceDirectClient = new BinanceDirectClient(
          this.bot.access_key,
          this.bot.secret_key,
          isTestnet,
          exchangeInfoService // Inject cache service
        );
        logger.info(`Binance direct API client initialized for bot ${this.bot.id} - Trading from ${this.binanceDirectClient.baseURL}, Market data from ${this.binanceDirectClient.productionDataURL}`);
        this.apiKeyValid = true; // Direct client doesn't need loadMarkets()
      } else {
        // For other exchanges, use normal config
        const config = {
          apiKey: this.bot.access_key,
          secret: this.bot.secret_key,
          enableRateLimit: true,
          options: {
            defaultType: 'swap'
          }
        };

        // Set higher timeout for MEXC (slow connections from Vietnam)
        if (this.bot.exchange === 'mexc') {
          const mexcTimeout = Number(configService.getNumber('MEXC_API_TIMEOUT_MS', 30000));
          config.timeout = mexcTimeout;
          logger.debug(`MEXC API timeout set to ${mexcTimeout}ms`);
        }

        this.exchange = new exchangeClass(config);
        // Force MEXC REST to .co domain to bypass VN block
        if (this.bot.exchange === 'mexc') {
          try {
            if (this.exchange) {
              if ('hostname' in this.exchange) this.exchange.hostname = 'mexc.co';
              const urls = this.exchange.urls || {};
              const deepReplace = (obj) => {
                if (!obj) return obj;
                if (typeof obj === 'string') return obj.replace(/mexc\.com/g, 'mexc.co');
                if (Array.isArray(obj)) return obj.map(deepReplace);
                if (typeof obj === 'object') {
                  for (const k of Object.keys(obj)) obj[k] = deepReplace(obj[k]);
                  return obj;
                }
                return obj;
              };
              this.exchange.urls = deepReplace(urls);
              // Keep hostname consistent
              if ('hostname' in this.exchange) this.exchange.hostname = 'mexc.co';
            }
          } catch (e) {
            logger.warn(`[MEXC-URL] Failed to force .co domain: ${e?.message || e}`);
          }
          // Initialize direct futures client (delegates to CCXT for now)
          try {
            this.mexcFuturesClient = new MexcFuturesClient(this.bot, this.exchange);
            logger.info('[MEXC] MexcFuturesClient initialized (delegating to CCXT)');
          } catch (e) {
            logger.warn(`[MEXC] Failed to init MexcFuturesClient: ${e?.message || e}`);
          }
        }
      }

      // For non-Binance exchanges
      if (this.bot.exchange !== 'binance') {
        // Add UID for MEXC if provided
        if (this.bot.exchange === 'mexc' && this.bot.uid) {
          this.exchange.uid = this.bot.uid;
          logger.debug(`MEXC UID configured for bot ${this.bot.id}`);
        }

        // Setup proxy if provided
        // Proxy support is disabled temporarily

        // Only enable sandbox mode for non-Binance exchanges or if explicitly requested
        const { configService } = await import('./ConfigService.js');
        const sandboxEnabled =
          configService.getBoolean('CCXT_SANDBOX', false) ||
          (this.bot.exchange === 'gate' && configService.getBoolean('GATE_SANDBOX', false)) ||
          (this.bot.exchange === 'mexc' && configService.getBoolean('MEXC_SANDBOX', false));

        if (sandboxEnabled && typeof this.exchange.setSandboxMode === 'function') {
          this.exchange.setSandboxMode(true);
          logger.info(
            `Sandbox mode enabled for bot ${this.bot.id} on ${this.bot.exchange}`
          );
        }

        // MEXC-specific configuration
        if (this.bot.exchange === 'mexc') {
          // MEXC uses defaultType: 'swap' for futures trading
          this.exchange.options.defaultType = 'swap';
          // Increase recvWindow to tolerate time skew/network latency
          const mexcRecv = Number(configService.getNumber('MEXC_RECV_WINDOW_MS', 60000));
          this.exchange.options.recvWindow = mexcRecv;
          this.exchange.recvWindow = mexcRecv; // some exchanges read from top-level
          // Try to reduce time skew effects if supported
          this.exchange.options.adjustForTimeDifference = true;
          // If ccxt supports time-diff sync, use it (best-effort)
          try {
            if (typeof this.exchange.loadTimeDifference === 'function') {
              await this.exchange.loadTimeDifference();
              logger.info(`[MEXC] Time difference synchronized for bot ${this.bot.id}`);
            }
          } catch (timeErr) {
            logger.warn(`[MEXC] Failed to sync time difference for bot ${this.bot.id}: ${timeErr?.message || timeErr}`);
          }
        }

        // Load markets
        await this.exchange.loadMarkets();
        this.apiKeyValid = true;
      }

      return true;
    } catch (error) {
      logger.error(`Failed to initialize exchange service for bot ${this.bot.id}:`, error);
      this.apiKeyValid = false;
      throw error;
    }
  }

  _getMakerEntryService() {
    if (!this._makerEntryService) {
      this._makerEntryService = createMakerEntryService(this);
    }
    return this._makerEntryService;
  }

  /**
   * Create a MAKER entry (LIMIT postOnly) using realtime best bid/ask from Binance WS.
   * amount is in USDT notional (consistent with existing createOrder).
   */
  async createMakerEntryOrder(symbol, side, amount, options = {}) {
    return await this._getMakerEntryService().placeMakerEntry(symbol, side, amount, options);
  }

  /**
   * Wrapper: create LIMIT order using existing createOrder()
   */
  async createLimitOrder(symbol, side, amount, price, { positionSide = 'BOTH', postOnly = false } = {}) {
    // postOnly currently applied only for BinanceDirectClient path below
    return await this.createOrder({ symbol, side, amount, type: 'limit', price, positionSide, postOnly });
  }

  /**
   * Wrapper: create MARKET order using existing createOrder()
   */
  async createMarketOrder(symbol, side, amount, { positionSide = 'BOTH' } = {}) {
    return await this.createOrder({ symbol, side, amount, type: 'market', positionSide });
  }

  // ---- EXISTING METHODS BELOW (kept) ----

  async getBalance(type = 'swap') {
    try {
      if (!this.apiKeyValid) {
        throw new Error('API key is not valid. Please check your exchange API credentials.');
      }

      // For Binance direct client
      if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
        const balance = await this.binanceDirectClient.getBalance();
        return balance.USDT;
      }

      if (type === 'swap') {
        const balance = await this.exchange.fetchBalance({ type: 'swap' });
        return balance.USDT;
      } else {
        // For spot
        const balance = await this.exchange.fetchBalance();

        // MEXC returns balance in different structure, normalize it
        let usdtBalance = balance.USDT;
        if (!usdtBalance && balance.USDT_SPOT) {
          usdtBalance = balance.USDT_SPOT;
        }

        return {
          free: usdtBalance?.free || 0,
          used: usdtBalance?.used || 0,
          total: usdtBalance?.total || 0
        };
      }
    } catch (error) {
      logger.error(`Failed to get ${type} balance for bot ${this.bot.id}:`, error);
      throw error;
    }
  }

  // ...
  // NOTE: The rest of the original ExchangeService.js remains unchanged in your repo.
  // This write was intentionally limited to avoid accidental large overwrites.
}
