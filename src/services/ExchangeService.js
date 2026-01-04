import ccxt from 'ccxt';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { BinanceDirectClient } from './BinanceDirectClient.js';
import { MexcFuturesClient } from './MexcFuturesClient.js';
import { exchangeInfoService } from './ExchangeInfoService.js';
import logger from '../utils/logger.js';
import { configService } from './ConfigService.js';
import { mexcPriceWs } from './MexcWebSocketManager.js';

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
              logger.debug(`MEXC time-diff synced: ${this.exchange.timeDifference || 0} ms`);
            }
          } catch (_) {}
          logger.debug(`MEXC configured for swap trading (futures) for bot ${this.bot.id}, recvWindow=${mexcRecv}ms`);
        }

        // Test connection for non-Binance (with retry for MEXC)
        // Add small delay before loadMarkets to reduce CPU spike during startup
        await new Promise(resolve => setTimeout(resolve, 200)); // 200ms delay
        
        let loadMarketsSuccess = false;
        let lastError = null;
        const maxRetries = this.bot.exchange === 'mexc' ? 3 : 1;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
        await this.exchange.loadMarkets();
            loadMarketsSuccess = true;
        logger.info(`Exchange ${this.bot.exchange} initialized for bot ${this.bot.id}`);
        this.apiKeyValid = true;
            break;
          } catch (error) {
            lastError = error;
            if (attempt < maxRetries) {
              const delayMs = 2000 * attempt; // 2s, 4s, 6s
              logger.warn(`[${this.bot.exchange}] loadMarkets attempt ${attempt}/${maxRetries} failed, retrying in ${delayMs}ms: ${error?.message || error}`);
              await new Promise(resolve => setTimeout(resolve, delayMs));
            } else {
              logger.error(`[${this.bot.exchange}] loadMarkets failed after ${maxRetries} attempts for bot ${this.bot.id}:`, error);
              // For MEXC, continue anyway (markets will be loaded on-demand)
              if (this.bot.exchange === 'mexc') {
                logger.warn(`[MEXC] Continuing without loadMarkets - will load markets on-demand`);
                this.apiKeyValid = true; // Assume valid, will fail on actual trades if not
                loadMarketsSuccess = true;
              } else {
                throw error;
              }
            }
          }
        }
        
        if (!loadMarketsSuccess && this.bot.exchange !== 'mexc') {
          throw lastError;
        }
      }
      // Binance uses direct client, no need to loadMarkets()

      return true;
    } catch (error) {
      logger.error(`Failed to initialize exchange for bot ${this.bot.id}:`, error);
      throw error;
    }
  }

  /**
   * Parse proxy string to URL
   * Format: IP:PORT:USER:PASS
   * @param {string} proxy - Proxy string
   * @returns {string} Proxy URL
   */
  parseProxy(proxy) {
    if (!proxy) return null;
    const [host, port, username, password] = proxy.split(':');
    return `http://${username}:${password}@${host}:${port}`;
  }

  /**
   * Get balance for spot or futures wallet
   * @param {string} type - 'spot' or 'future'
   * @returns {Promise<Object>} { free, used, total }
   */
  async getBalance(type = 'spot') {
    try {
      // For Binance: use direct client
      if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
        if (type === 'future') {
          return await this.binanceDirectClient.getBalance();
        } else {
          // Spot balance not implemented in direct client yet
          throw new Error('Spot balance not supported for Binance direct client');
        }
      }

      // For other exchanges: use CCXT
      if (!this.exchange) {
        throw new Error(`Exchange not initialized for bot ${this.bot.id}`);
      }

      if (type === 'future') {
        // For futures, use swap balance
        const balance = await this.exchange.fetchBalance({ type: 'swap' });
        
        // MEXC returns balance in different structure, normalize it
        let usdtBalance = balance.USDT;
        if (!usdtBalance && balance.USDT_SWAP) {
          usdtBalance = balance.USDT_SWAP;
        }
        
        return {
          free: usdtBalance?.free || 0,
          used: usdtBalance?.used || 0,
          total: usdtBalance?.total || 0
        };
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

  /**
   * Create order
   * @param {Object} params - Order parameters
   * @param {string} params.symbol - Trading symbol
   * @param {string} params.side - 'buy' or 'sell'
   * @param {number} params.amount - Order amount
   * @param {string} params.type - 'market' or 'limit'
   * @param {number} params.price - Price (for limit orders)
   * @returns {Promise<Object>} Order object
   */
  async createOrder(params) {
    try {
      const { symbol, side, amount, type = 'limit', price, positionSide } = params;

      // For Binance: use direct client
      if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
        const normalizedSymbol = this.binanceDirectClient.normalizeSymbol(symbol);

        // Validate symbol is tradable on Binance Futures (testnet/prod accordingly)
        const symbolInfo = await this.binanceDirectClient.getTradingExchangeSymbol(normalizedSymbol);
        if (!symbolInfo || symbolInfo.status !== 'TRADING') {
          throw new Error(`Symbol ${normalizedSymbol} is not available for trading on Binance Futures.`);
        }
        
        // Calculate quantity and notional (USDT)
        const currentPrice = price || await this.getTickerPrice(symbol);
        if (!Number.isFinite(Number(currentPrice)) || Number(currentPrice) <= 0) {
          throw new Error(`Invalid current/entry price for ${normalizedSymbol}: ${currentPrice}`);
        }
        if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
          throw new Error(`Invalid amount (USDT) for ${normalizedSymbol}: ${amount}`);
        }
        const quantity = Number(amount) / Number(currentPrice);
        if (!Number.isFinite(quantity) || quantity <= 0) {
          throw new Error(`Computed quantity invalid for ${normalizedSymbol}: amount=${amount}, price=${currentPrice}`);
        }
        const notional = Number(amount); // USDT-margined futures: price * qty = amount

        // CRITICAL FIX: Validate maxQty BEFORE formatting to prevent "Quantity greater than max quantity" error
        const maxQty = await this.binanceDirectClient.getMaxQty(normalizedSymbol);
        if (maxQty !== null && Number.isFinite(maxQty) && quantity > maxQty) {
          // Calculate maximum allowed amount based on maxQty
          const maxAllowedAmount = maxQty * Number(currentPrice);
          const errorMsg = `Quantity ${quantity.toFixed(8)} exceeds maximum ${maxQty} for ${normalizedSymbol}. ` +
            `Amount ${amount} USDT would require ${quantity.toFixed(8)} contracts, but max is ${maxQty}. ` +
            `Maximum allowed amount: ${maxAllowedAmount.toFixed(2)} USDT.`;
          logger.error(`[OrderService] ${errorMsg}`);
          throw new Error(errorMsg);
        }

        // Configure margin type and leverage per symbol (cached to avoid redundant API calls)
        try {
          const { configService } = await import('./ConfigService.js');
          const { exchangeInfoService } = await import('./ExchangeInfoService.js');

          // Only set margin type once per symbol (cache in _binanceConfiguredSymbols)
          // CRITICAL: Handle -4046 error (margin type already configured) gracefully
          if (!this._binanceConfiguredSymbols.has(normalizedSymbol)) {
            const marginType = (configService.getString('BINANCE_DEFAULT_MARGIN_TYPE', 'CROSSED') || 'CROSSED').toUpperCase();
            try {
            await this.binanceDirectClient.setMarginType(normalizedSymbol, marginType);
            this._binanceConfiguredSymbols.add(normalizedSymbol);
            logger.debug(`[Cache] Set margin type for ${normalizedSymbol} to ${marginType} (cached)`);
            } catch (marginErr) {
              // Handle -4046: margin type already configured (can happen on restart or multi-instance)
              const errMsg = marginErr?.message || '';
              const errCode = marginErr?.code || '';
              if (errMsg.includes('-4046') || errCode === '-4046' || errMsg.includes('No need to change margin type')) {
                // Margin type already set - treat as success and cache it
                this._binanceConfiguredSymbols.add(normalizedSymbol);
                logger.debug(`[Cache] Margin type for ${normalizedSymbol} already configured (code -4046), cached`);
              } else {
                // Other error - log but don't fail order creation
                logger.warn(`[Binance] Failed to set margin type for ${normalizedSymbol}: ${errMsg || marginErr}`);
              }
            }
          }

          // Use bot's default_leverage if set, otherwise use max leverage from symbol_filters cache
          // If cache miss, try API call before falling back to default config
          let desiredLev;
          if (this.bot.default_leverage != null && Number.isFinite(Number(this.bot.default_leverage))) {
            // Use bot's configured default leverage
            desiredLev = parseInt(this.bot.default_leverage);
          } else {
            // Try cache first
            let maxLeverageFromCache = exchangeInfoService.getMaxLeverage(normalizedSymbol);
            
            // If cache miss, try API call (for Binance)
            if (maxLeverageFromCache == null && this.binanceDirectClient) {
              try {
                maxLeverageFromCache = await this.binanceDirectClient.getMaxLeverage(normalizedSymbol);
                logger.debug(`[Binance] Fetched max leverage from API for ${normalizedSymbol}: ${maxLeverageFromCache}`);
              } catch (apiErr) {
                logger.warn(`[Binance] Failed to fetch max leverage from API for ${normalizedSymbol}: ${apiErr?.message || apiErr}`);
              }
            }
            
            // Only fallback to default config if both cache and API failed
            if (maxLeverageFromCache != null && Number.isFinite(Number(maxLeverageFromCache))) {
              desiredLev = parseInt(maxLeverageFromCache);
            } else {
              const defaultLeverage = parseInt(configService.getNumber('BINANCE_DEFAULT_LEVERAGE', 5));
              desiredLev = defaultLeverage;
              logger.warn(`[Binance] Using default leverage ${defaultLeverage} for ${normalizedSymbol} (cache and API both failed)`);
            }
          }

          // Cache last applied leverage to avoid redundant calls
          this._binanceLeverageMap = this._binanceLeverageMap || new Map();
          if (this._binanceLeverageMap.get(normalizedSymbol) !== desiredLev) {
            await this.binanceDirectClient.setLeverage(normalizedSymbol, desiredLev);
            this._binanceLeverageMap.set(normalizedSymbol, desiredLev);
            const leverageSource = this.bot.default_leverage != null ? `bot default_leverage=${this.bot.default_leverage}` : 'max leverage from cache/default';
            logger.info(`Set leverage for ${normalizedSymbol} to ${desiredLev} (${leverageSource}) for bot ${this.bot.id}`);
          } else {
            logger.debug(`[Cache] Leverage for ${normalizedSymbol} already set to ${desiredLev}, skipping`);
          }
        } catch (cfgErr) {
          logger.warn(`Binance leverage/margin setup warning for ${normalizedSymbol}: ${cfgErr?.message || cfgErr}`);
        }

        // Respect strategy amount: do NOT auto-increase to meet min notional.
        // Validate against MIN_NOTIONAL using EFFECTIVE notional after quantity formatting.
        const minNotional = await this.binanceDirectClient.getMinNotional(normalizedSymbol);
        if (minNotional) {
          try {
            const stepSize = await this.binanceDirectClient.getStepSize(normalizedSymbol);
            const formattedQtyStr = this.binanceDirectClient.formatQuantity(quantity, stepSize);
            const formattedQty = parseFloat(formattedQtyStr);
            const effectiveNotional = (formattedQty || 0) * currentPrice;
            logger.debug(`[MinNotionalCheck] ${normalizedSymbol}: amount=${amount}, price=${currentPrice}, rawQty=${quantity}, stepSize=${stepSize}, fmtQty=${formattedQty}, effectiveNotional=${effectiveNotional}, minNotional=${minNotional}`);
            if (!Number.isFinite(effectiveNotional) || effectiveNotional + 1e-8 < Number(minNotional)) {
              throw new Error(`Effective notional ${effectiveNotional.toFixed(8)} USDT is below minimum notional ${minNotional} USDT for ${normalizedSymbol} (amount=${amount}).`);
            }
          } catch (e) {
            // If any issue computing step size, fall back to simple check on amount (still safer than skipping validation)
            if (amount < Number(minNotional)) {
              throw new Error(`Amount ${amount} USDT is below minimum notional ${minNotional} USDT for ${normalizedSymbol}.`);
            }
          }
        }

        // CRITICAL FIX: Format quantity according to stepSize BEFORE placing order
        // Retry 3 times with slightly different quantities (in step units) to ensure validation passes
        // and reduce floating/rounding edge cases.
        const stepSize = await this.binanceDirectClient.getStepSize(normalizedSymbol);
        const step = parseFloat(stepSize || '0');
        if (!Number.isFinite(step) || step <= 0) {
          throw new Error(`Invalid stepSize for ${normalizedSymbol}: ${stepSize}`);
        }

        const baseQty = parseFloat(this.binanceDirectClient.formatQuantity(quantity, stepSize));
        if (!Number.isFinite(baseQty) || baseQty <= 0) {
          throw new Error(`Invalid formatted quantity for ${normalizedSymbol}: ${baseQty} (original: ${quantity}, stepSize: ${stepSize})`);
        }

        // Try: baseQty, baseQty - 1 step, baseQty - 2 steps (never increase notional)
        // Decreasing helps pass strict step validations and avoids min-notional inflation.
        const candidates = [
          baseQty,
          parseFloat(this.binanceDirectClient.formatQuantity(Math.max(0, baseQty - step), stepSize)),
          parseFloat(this.binanceDirectClient.formatQuantity(Math.max(0, baseQty - 2 * step), stepSize))
        ].filter(q => Number.isFinite(q) && q > 0);

        // Deduplicate (string compare to keep precision stable)
        const uniq = [];
        const seen = new Set();
        for (const q of candidates) {
          const key = String(q);
          if (!seen.has(key)) {
            seen.add(key);
            uniq.push(q);
          }
        }

        logger.debug(
          `[OrderRetry] ${normalizedSymbol} candidates=${uniq.join(',')} rawQty=${quantity} stepSize=${stepSize} ` +
          `amountUSDT=${amount} price=${currentPrice} bot=${this.bot.id}`
        );

        let order;
        let avgFillPrice = null;
        let lastErr = null;

        for (let attempt = 0; attempt < Math.min(3, uniq.length); attempt++) {
          const finalQuantity = uniq[attempt];

          // Re-check min notional using effective notional for this candidate
          if (minNotional) {
            const effectiveNotional = finalQuantity * Number(currentPrice);
            if (!Number.isFinite(effectiveNotional) || effectiveNotional + 1e-8 < Number(minNotional)) {
              logger.warn(
                `[OrderRetry] Skip candidate qty=${finalQuantity} for ${normalizedSymbol}: ` +
                `effectiveNotional=${effectiveNotional} < minNotional=${minNotional}`
              );
              continue;
            }
          }

          logger.info(
            `[OrderRetry] Attempt ${attempt + 1}/3 placing ${type.toUpperCase()} order for ${normalizedSymbol} ` +
            `side=${side} qty=${finalQuantity} stepSize=${stepSize} rawQty=${quantity}`
          );

          try {
            if (type === 'market') {
              order = await this.binanceDirectClient.placeMarketOrder(
                normalizedSymbol,
                side,
                finalQuantity,
                positionSide
              );
              try {
                avgFillPrice = await this.binanceDirectClient.getOrderAverageFillPrice(normalizedSymbol, order.orderId);
              } catch (_) {}
            } else {
              order = await this.binanceDirectClient.placeLimitOrder(
                normalizedSymbol,
                side,
                finalQuantity,
                price,
                positionSide
              );
            }
            // Success
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            const msg = e?.message || String(e);
            // Retry only for quantity/precision validation problems
            const isQtyValidation = msg.includes('Order validation failed') || msg.includes('Invalid quantity') || msg.includes('-4131') || msg.includes('-1111');
            logger.warn(
              `[OrderRetry] Attempt ${attempt + 1}/3 failed for ${normalizedSymbol} qty=${finalQuantity}: ${msg}`
            );
            if (!isQtyValidation) {
              throw e; // not a quantity validation issue => don't retry
            }
          }
        }

        if (!order) {
          throw lastErr || new Error(`Failed to create ${type} order for ${normalizedSymbol} after 3 attempts`);
        }

        // For LIMIT orders: status check and avgFillPrice will be handled below
        if (type === 'limit' && order) {
          // CRITICAL FIX: Check actual order status after placing LIMIT order
          // Binance LIMIT orders can fill immediately, partially, or be IOC
          // Don't assume status='open' - check exchange response
          try {
            const orderInfo = await this.binanceDirectClient.getOrder(normalizedSymbol, order.orderId);
            const orderStatus = (orderInfo?.status || '').toUpperCase();
            const executedQty = parseFloat(orderInfo?.executedQty || '0') || 0;
            
            // If order is already filled or partially filled, update status
            if (orderStatus === 'FILLED' || executedQty > 0) {
              // Try to get average fill price
              try {
                avgFillPrice = await this.binanceDirectClient.getOrderAverageFillPrice(normalizedSymbol, order.orderId);
              } catch (_) {
                // Fallback to order price if avgFillPrice not available
                avgFillPrice = parseFloat(orderInfo?.price || price || currentPrice);
              }
              
              logger.debug(
                `[Binance LIMIT] Order ${order.orderId} for ${normalizedSymbol} status=${orderStatus}, ` +
                `executedQty=${executedQty}, avgFillPrice=${avgFillPrice}`
              );
            }
          } catch (statusErr) {
            // If status check fails, log but continue with default assumption
            logger.warn(
              `[Binance LIMIT] Failed to check order status for ${order.orderId}: ${statusErr?.message || statusErr}. ` +
              `Assuming order is open (will be verified by EntryOrderMonitor).`
            );
          }
        }
        
        // Convert to CCXT-like format
        const isLimit = type === 'limit';
        const isFilled = avgFillPrice !== null && avgFillPrice > 0;
        const finalStatus = isLimit && !isFilled ? 'open' : 'closed';
        const finalFilled = isFilled ? quantity : (isLimit ? 0 : quantity);
        const finalRemaining = isLimit && !isFilled ? quantity : 0;
        
        return {
          id: order.orderId.toString(),
          symbol: normalizedSymbol,
          type: type,
          side: side,
          amount: quantity,
          price: avgFillPrice || price || currentPrice,
          avgFillPrice: avgFillPrice || undefined,
          status: finalStatus,
          filled: finalFilled,
          remaining: finalRemaining,
          timestamp: Date.now(),
          datetime: new Date().toISOString()
        };
      }

      // For other exchanges: use CCXT (MEXC/Gate)
      const marketSymbol = this.formatSymbolForExchange(symbol, 'swap');

      // For MEXC and other swaps, convert USDT amount -> contracts quantity
      let usePrice = price || await this.getTickerPrice(symbol);
      if (!Number.isFinite(Number(usePrice)) || Number(usePrice) <= 0) {
        throw new Error(`Invalid current/entry price for ${marketSymbol}: ${usePrice}`);
      }

      // Ensure leverage is set for MEXC using bot's default_leverage if set, otherwise max leverage from symbol_filters
      try {
        if ((this.bot.exchange || '').toLowerCase() === 'mexc') {
          let maxLev;
          if (this.bot.default_leverage != null && Number.isFinite(Number(this.bot.default_leverage))) {
            // Use bot's configured default leverage
            maxLev = Number(this.bot.default_leverage);
          } else {
            // Try cache first
            const maxLeverageFromCache = exchangeInfoService.getMaxLeverage(symbol);
            
            // Only fallback to default config if cache is null/undefined
            if (maxLeverageFromCache != null && Number.isFinite(Number(maxLeverageFromCache))) {
              maxLev = Number(maxLeverageFromCache);
            } else {
              maxLev = Number(configService.getNumber('MEXC_DEFAULT_LEVERAGE', 5));
              logger.warn(`[MEXC] Using default leverage ${maxLev} for ${symbol} (cache miss)`);
            }
          }
          if (Number.isFinite(maxLev) && maxLev > 0) {
            try {
              if (this.mexcFuturesClient) {
                await this.mexcFuturesClient.setLeverage(symbol, maxLev);
              } else if (typeof this.exchange.setLeverage === 'function') {
                await this.exchange.setLeverage(maxLev, marketSymbol);
              }
              logger.info(`[MEXC] Set leverage=${maxLev} for ${symbol}`);
            } catch (levErr) {
              logger.warn(`[MEXC] setLeverage failed for ${symbol}: ${levErr?.message || levErr}`);
            }
          }
        }
      } catch (_) {}

      // Load market metadata for precision and limits
      const market = this.exchange.market(marketSymbol);

      // Calculate raw quantity in contracts from USDT notional
      let rawQty = Number(amount) / Number(usePrice);
      if (!Number.isFinite(rawQty) || rawQty <= 0) {
        throw new Error(`Computed quantity invalid for ${marketSymbol}: amount=${amount}, price=${usePrice}`);
      }

      // Apply amount precision (contracts) and price precision (for limit)
      const qtyStr = this.exchange.amountToPrecision(marketSymbol, rawQty);
      const qty = parseFloat(qtyStr);
      let priceOut = undefined;
      if (type === 'limit') {
        const priceStr = this.exchange.priceToPrecision(marketSymbol, usePrice);
        priceOut = parseFloat(priceStr);
      }

      // Validate against exchange limits
      const minQty = market?.limits?.amount?.min;
      const maxQty = market?.limits?.amount?.max;
      const minCost = market?.limits?.cost?.min;
      const notional = qty * Number(usePrice);

      if (Number.isFinite(minQty) && qty + 1e-12 < Number(minQty)) {
        throw new Error(`Order quantity ${qty} < minQty ${minQty} for ${marketSymbol}`);
      }
      if (Number.isFinite(maxQty) && qty - 1e-12 > Number(maxQty)) {
        throw new Error(`Order quantity ${qty} > maxQty ${maxQty} for ${marketSymbol}`);
      }
      if (Number.isFinite(minCost) && notional + 1e-12 < Number(minCost)) {
        throw new Error(`Order notional ${notional.toFixed(8)} < minCost ${minCost} for ${marketSymbol}`);
      }

      // Margin check for MEXC: amount = margin * leverage; use bot's default_leverage if set, otherwise max leverage per coin from symbol_filters
      // CRITICAL FIX: Cache futures balance to reduce rate limits when placing multiple orders
      if ((this.bot.exchange || '').toLowerCase() === 'mexc') {
        try {
          let maxLev;
          if (this.bot.default_leverage != null && Number.isFinite(Number(this.bot.default_leverage))) {
            // Use bot's configured default leverage
            maxLev = Number(this.bot.default_leverage);
          } else {
            // Try cache first
            const maxLeverageFromCache = exchangeInfoService.getMaxLeverage(symbol);
            
            // Only fallback to default config if cache is null/undefined
            if (maxLeverageFromCache != null && Number.isFinite(Number(maxLeverageFromCache))) {
              maxLev = Number(maxLeverageFromCache);
            } else {
              maxLev = Number(configService.getNumber('MEXC_DEFAULT_LEVERAGE', 5));
              logger.warn(`[MEXC] Using default leverage ${maxLev} for ${symbol} (cache miss) in margin calculation`);
            }
          }
          const feeBuffer = Number(configService.getNumber('MEXC_MARGIN_FEE_BUFFER', 0.002)); // 0.2% buffer
          const marginNeeded = (notional / Math.max(maxLev, 1)) * (1 + Math.max(0, feeBuffer));
          
          // Use cached balance if available and fresh (within TTL)
          let futFree = 0;
          const now = Date.now();
          if (this._futuresBalanceCache && (now - this._futuresBalanceCache.timestamp) < this._futuresBalanceCacheTTL) {
            futFree = Number(this._futuresBalanceCache.balance?.free || 0);
            logger.debug(`[MEXC Margin] Using cached futures balance: ${futFree.toFixed(6)} USDT (age: ${now - this._futuresBalanceCache.timestamp}ms)`);
          } else {
            // Fetch fresh balance and cache it
          const futBal = await this.getBalance('future').catch(() => ({ free: 0 }));
            futFree = Number(futBal?.free || 0);
            this._futuresBalanceCache = {
              balance: futBal,
              timestamp: now
            };
            logger.debug(`[MEXC Margin] Fetched fresh futures balance: ${futFree.toFixed(6)} USDT`);
          }
          
          if (futFree + 1e-8 < marginNeeded) {
            throw new Error(`Insufficient futures margin: need ~${marginNeeded.toFixed(6)} USDT (amount=${notional.toFixed(6)} / lev=${maxLev}), free=${futFree.toFixed(6)} USDT`);
          }
        } catch (merr) {
          // escalate with clear message rather than letting exchange return 10101
          throw merr;
        }
      }

      const extraParams = {};

      // Optionally route through direct MexcFuturesClient (delegates to CCXT for now)
      let order;
      const useDirectMexc = (this.bot.exchange === 'mexc' && this.mexcFuturesClient && configService.getBoolean('MEXC_FUTURES_DIRECT', false));
      if (useDirectMexc) {
        order = await this.mexcFuturesClient.createOrder({
          symbol,
          side,
          type,
          amount,
          price: usePrice,
          extra: extraParams
        });
      } else {
        order = await this.exchange.createOrder(
          marketSymbol,
          type,
          side,
          qty,
          priceOut,
          extraParams
        );
      }

      logger.info(`Order created for bot ${this.bot.id}:`, {
        orderId: order.id,
        symbol,
        side,
        amount,
        qty,
        price: priceOut || usePrice
      });

      return order;
    } catch (error) {
      const msg = error?.message || '';
      
      // MEXC-specific error codes and messages
      const mexcErrors = [
        'Invalid symbol', // MEXC: Invalid trading pair
        'Insufficient balance', // MEXC: Not enough balance
        'Order quantity is too small', // MEXC: Below minimum notional
        'Price precision error', // MEXC: Price precision issue
        'Quantity precision error', // MEXC: Quantity precision issue
        'Order price is too high', // MEXC: Price out of range
        'Order price is too low', // MEXC: Price out of range
      ];
      
      const soft = (
        msg.includes('not available for trading on Binance Futures') ||
        msg.includes('below minimum notional') ||
        msg.includes('Invalid price after rounding') ||
        msg.includes('Precision is over the maximum') ||
        msg.includes('-1121') || msg.includes('-1111') || msg.includes('-4061') ||
        mexcErrors.some(err => msg.includes(err))
      );
      if (soft) {
        logger.warn(`Create order validation for bot ${this.bot.id}: ${msg}`);
      } else {
        logger.error(`Failed to create order for bot ${this.bot.id}:`, error);
      }
      throw error;
    }
  }

  /**
   * Close position
   * @param {string} symbol - Trading symbol
   * @param {string} side - 'long' or 'short'
   * @param {number} amount - Position amount
   * @returns {Promise<Object>} Order object
   */
  async closePosition(symbol, side, amount) {
    try {
      // For Binance: use direct client and reduce-only with exact position size
      if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
        const normalizedSymbol = this.binanceDirectClient.normalizeSymbol(symbol);
        // Get open positions to determine exact reducible amount
        const positions = await this.binanceDirectClient.getOpenPositions(normalizedSymbol);
        const desiredSide = side === 'long' ? 'BUY' : 'SELL'; // order side to close is opposite, but we decide below
        const positionSide = side === 'long' ? 'LONG' : 'SHORT';

        // Find matching position
        let pos = null;
        if (Array.isArray(positions)) {
          // PositionRisk returns both LONG/SHORT entries in dual-side, or one entry in one-way
          pos = positions.find(p => p.symbol === normalizedSymbol && (p.positionSide ? p.positionSide === positionSide : true));
          // If not found by side (one-way), take any non-zero
          if (!pos) pos = positions.find(p => p.symbol === normalizedSymbol && parseFloat(p.positionAmt) !== 0);
        }

        const posAmt = pos ? Math.abs(parseFloat(pos.positionAmt || 0)) : 0;
        if (!pos || posAmt === 0) {
          logger.warn(`No open position to close for ${normalizedSymbol}, skip close.`);
          return { skipped: true };
        }

        // Use stepSize to floor quantity <= posAmt
        const stepSize = await this.binanceDirectClient.getStepSize(normalizedSymbol);
        const qtyStr = this.binanceDirectClient.formatQuantity(posAmt, stepSize);
        const qty = parseFloat(qtyStr);
        if (qty <= 0) {
          logger.warn(`Computed close quantity <= 0 for ${normalizedSymbol}, skip.`);
          return { skipped: true };
        }

        const closeSide = side === 'long' ? 'SELL' : 'BUY';
        const order = await this.binanceDirectClient.placeMarketOrder(
          normalizedSymbol,
          closeSide,
          qty,
          positionSide,
          true // reduceOnly
        );
        // Try to compute average fill price for the close
        let avgFillPrice = null;
        try {
          avgFillPrice = await this.binanceDirectClient.getOrderAverageFillPrice(normalizedSymbol, order.orderId);
        } catch (_) {}
        logger.info(`Position closed for bot ${this.bot.id}:`, {
          orderId: order.orderId,
          symbol,
          side,
          amount: qty,
          avgFillPrice
        });
        return { ...order, avgFillPrice };
      }

      // For closing on other exchanges, compute actual position size and use reduceOnly
      const marketSymbol = this.formatSymbolForExchange(symbol, 'swap');
      const positions = await this.exchange.fetchPositions();
      const pos = Array.isArray(positions)
        ? positions.find(p => (p.symbol === marketSymbol || p.symbol === symbol || p.info?.symbol === marketSymbol || p.info?.symbol === symbol) && ((p.contracts ?? Math.abs(parseFloat(p.positionAmt || 0))) > 0))
        : null;

      const contracts = pos ? (pos.contracts ?? Math.abs(parseFloat(pos.positionAmt || 0))) : 0;
      if (!contracts || contracts <= 0) {
        logger.warn(`No open position to close for ${marketSymbol}, skip close.`);
        return { skipped: true };
      }

      // Respect precision
      const qtyStr = this.exchange.amountToPrecision(marketSymbol, contracts);
      const qty = parseFloat(qtyStr);
      if (!qty || qty <= 0) {
        logger.warn(`Computed close quantity <= 0 for ${marketSymbol}, skip.`);
        return { skipped: true };
      }

      const orderSide = side === 'long' ? 'sell' : 'buy';
      const params = { reduceOnly: true };
      const order = await this.exchange.createOrder(marketSymbol, 'market', orderSide, qty, undefined, params);

      logger.info(`Position closed for bot ${this.bot.id}:`, {
        orderId: order.id,
        symbol,
        side,
        qty
      });

      return order;
    } catch (error) {
      const msg = error?.message || '';
      
      // Handle MEXC and other exchange errors
      const isReduceOnlyError = msg.includes('-2022') || 
                                msg.toLowerCase().includes('reduceonly') ||
                                msg.includes('Position does not exist') ||
                                msg.includes('Insufficient position');
      
      if (isReduceOnlyError) {
        // Race condition: position already reduced/closed by TP/SL or other order
        logger.warn(`ReduceOnly close skipped for bot ${this.bot.id} (${symbol}): ${msg}`);
        return { skipped: true };
      }
      logger.error(`Failed to close position for bot ${this.bot.id}:`, error);
      throw error;
    }
  }

  /**
   * Transfer from spot to futures wallet
   * @param {number} amount - Amount to transfer
   * @returns {Promise<Object>} Transfer result
   */
  async transferSpotToFuture(amount) {
    try {
      if (this.bot.exchange === 'mexc') {
        // MEXC transfer: spot -> swap (futures)
        const result = await this.exchange.transfer('USDT', amount, 'spot', 'swap');
        logger.info(`Spot to future transfer for bot ${this.bot.id}: ${amount} USDT (MEXC)`);
        return result;
      } else if (this.bot.exchange === 'binance') {
        // Binance transfer: spot -> future
        const result = await this.exchange.transfer('USDT', amount, 'spot', 'future');
        logger.info(`Spot to future transfer for bot ${this.bot.id}: ${amount} USDT (Binance)`);
        return result;
      } else {
        // Gate.io transfer: spot -> future
        const result = await this.exchange.transfer('USDT', amount, 'spot', 'future');
        logger.info(`Spot to future transfer for bot ${this.bot.id}: ${amount} USDT (Gate.io)`);
        return result;
      }
    } catch (error) {
      logger.error(`Failed to transfer spot to future for bot ${this.bot.id}:`, error);
      throw error;
    }
  }

  /**
   * Transfer from futures to spot wallet
   * @param {number} amount - Amount to transfer
   * @returns {Promise<Object>} Transfer result
   */
  async transferFutureToSpot(amount) {
    try {
      if (this.bot.exchange === 'mexc') {
        // MEXC transfer: swap (futures) -> spot
        const result = await this.exchange.transfer('USDT', amount, 'swap', 'spot');
        logger.info(`Future to spot transfer for bot ${this.bot.id}: ${amount} USDT (MEXC)`);
        return result;
      } else if (this.bot.exchange === 'binance') {
        // Binance transfer: future -> spot
        const result = await this.exchange.transfer('USDT', amount, 'future', 'spot');
        logger.info(`Future to spot transfer for bot ${this.bot.id}: ${amount} USDT (Binance)`);
        return result;
      } else {
        // Gate.io transfer: future -> spot
        const result = await this.exchange.transfer('USDT', amount, 'future', 'spot');
        logger.info(`Future to spot transfer for bot ${this.bot.id}: ${amount} USDT (Gate.io)`);
        return result;
      }
    } catch (error) {
      logger.error(`Failed to transfer future to spot for bot ${this.bot.id}:`, error);
      throw error;
    }
  }

  /**
   * Create Take Profit Limit order (reduce-only)
   * Only implemented for Binance (direct client) for now
   * @param {string} symbol
   * @param {'long'|'short'} side - original position side
   * @param {number} tpPrice
   * @param {number} quantity
   */
  async createTakeProfitLimit(symbol, side, tpPrice, quantity) {
    if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
      const normalizedSymbol = this.binanceDirectClient.normalizeSymbol(symbol);
      const data = await this.binanceDirectClient.createTpLimitOrder(normalizedSymbol, side, tpPrice, quantity);
      return data;
    }
    throw new Error('createTakeProfitLimit not supported on this exchange');
  }

  async createCloseStopMarket(symbol, side, stopPrice) {
    if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
      const normalizedSymbol = this.binanceDirectClient.normalizeSymbol(symbol);
      return await this.binanceDirectClient.createCloseStopMarket(normalizedSymbol, side, stopPrice);
    }
    throw new Error('createCloseStopMarket not supported on this exchange');
  }

  async createCloseTakeProfitMarket(symbol, side, stopPrice) {
    if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
      const normalizedSymbol = this.binanceDirectClient.normalizeSymbol(symbol);
      return await this.binanceDirectClient.createCloseTakeProfitMarket(normalizedSymbol, side, stopPrice);
    }
    throw new Error('createCloseTakeProfitMarket not supported on this exchange');
  }

  async createStopLossLimit(symbol, side, slPrice, quantity) {
    if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
      const normalizedSymbol = this.binanceDirectClient.normalizeSymbol(symbol);
      const data = await this.binanceDirectClient.createSlLimitOrder(normalizedSymbol, side, slPrice, quantity);
      return data;
    }
    throw new Error('createStopLossLimit not supported on this exchange');
  }

  async getTickSize(symbol) {
    if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
      // Try cache first
      const normalizedSymbol = this.binanceDirectClient.normalizeSymbol(symbol);
      const cached = exchangeInfoService.getTickSize(normalizedSymbol);
      if (cached) {
        logger.debug(`[Cache Hit] ExchangeService.getTickSize for ${normalizedSymbol}: ${cached}`);
        return cached;
      }
      // Fallback to REST API
      return await this.binanceDirectClient.getTickSize(symbol);
    }
    return '0.01';
  }

  async createEntryTriggerOrder(symbol, side, entryPrice, quantity) {
    if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
      const normalizedSymbol = this.binanceDirectClient.normalizeSymbol(symbol);
      return await this.binanceDirectClient.createEntryTriggerOrder(normalizedSymbol, side, entryPrice, quantity);
    }
    throw new Error('createEntryTriggerOrder not supported on this exchange');
  }

  async getClosableQuantity(symbol, side) {
    if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
      const normalizedSymbol = this.binanceDirectClient.normalizeSymbol(symbol);
      const positions = await this.binanceDirectClient.getOpenPositions(normalizedSymbol);
      const positionSide = side === 'long' ? 'LONG' : 'SHORT';
      let pos = null;
      if (Array.isArray(positions)) {
        logger.debug(`[getClosableQuantity] Found ${positions.length} positions on exchange for ${normalizedSymbol}:`, positions);
        pos = positions.find(p => p.symbol === normalizedSymbol && (p.positionSide ? p.positionSide === positionSide : true));
        if (!pos) pos = positions.find(p => p.symbol === normalizedSymbol && parseFloat(p.positionAmt) !== 0);
        logger.debug(`[getClosableQuantity] Selected position:`, pos);
      }
      const posAmt = pos ? Math.abs(parseFloat(pos.positionAmt || 0)) : 0;
      if (posAmt <= 0) return 0;
      const stepSize = await this.binanceDirectClient.getStepSize(normalizedSymbol);
      return parseFloat(this.binanceDirectClient.formatQuantity(posAmt, stepSize));
    }
    return 0;
  }

  /**
   * Withdraw to external wallet
   * @param {number} amount - Amount to withdraw
   * @param {string} address - Withdrawal address
   * @param {string} network - Network (BEP20, ERC20, TRC20)
   * @returns {Promise<Object>} Withdrawal result
   */
  async withdraw(amount, address, network = 'BEP20') {
    try {
      const code = 'USDT';
      const params = {
        network: network.toLowerCase()
      };

      const result = await this.exchange.withdraw(code, amount, address, undefined, undefined, params);
      
      logger.info(`Withdrawal initiated for bot ${this.bot.id}:`, {
        amount,
        address,
        network,
        txid: result.id
      });

      return result;
    } catch (error) {
      logger.error(`Failed to withdraw for bot ${this.bot.id}:`, error);
      throw error;
    }
  }

  /**
   * Get open positions
   * @param {string} symbol - Optional symbol filter
   * @returns {Promise<Array>} Array of positions
   */
  async getOpenPositions(symbol = null) {
    try {
      // For Binance: use direct client
      if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
        return await this.binanceDirectClient.getOpenPositions(symbol);
      }

      // For other exchanges: use CCXT
      const positions = await this.exchange.fetchPositions(symbol);
      
      // MEXC returns positions with different field names, normalize them
      if (this.bot.exchange === 'mexc') {
        return positions.filter(p => {
          // MEXC: contracts or positionAmt field
          const contracts = p.contracts || Math.abs(parseFloat(p.positionAmt || 0));
          return contracts > 0;
        }).map(p => {
          // Normalize MEXC position format to match Binance format
          return {
            ...p,
            contracts: p.contracts || Math.abs(parseFloat(p.positionAmt || 0)),
            positionAmt: p.positionAmt || p.contracts
          };
        });
      }
      
      return positions.filter(p => p.contracts > 0);
    } catch (error) {
      logger.error(`Failed to get open positions for bot ${this.bot.id}:`, error);
      throw error;
    }
  }

  /**
   * Fetch OHLCV (candlestick) data
   * @param {string} symbol - Trading symbol
   * @param {string} timeframe - Timeframe (1m, 5m, 1h, etc.)
   * @param {number} limit - Number of candles
   * @returns {Promise<Array>} Array of candles
   */
  async fetchOHLCV(symbol, timeframe, limit = 100, marketType = null) {
    try {
      const marketSymbol = this.formatSymbolForExchange(symbol, marketType);
      const params = {};

      if (marketType) {
        params.type = marketType;
      }

      // For Binance: use direct client (production data)
      if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
        const klines = await this.binanceDirectClient.getKlines(symbol, timeframe, limit);
        // Convert to CCXT format
        return klines.map(candle => [
          candle.openTime,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume
        ]);
      }
      
      // For other exchanges: use CCXT
      const exchange = (this.bot.exchange === 'binance' && this.publicExchange) 
        ? this.publicExchange 
        : this.exchange;
      
      const candles = await exchange.fetchOHLCV(
        marketSymbol,
        timeframe,
        undefined,
        limit,
        params
      );
      
      // Convert to our format
      return candles.map(candle => ({
        symbol,
        interval: timeframe,
        open_time: candle[0],
        open: candle[1],
        high: candle[2],
        low: candle[3],
        close: candle[4],
        volume: candle[5],
        close_time: candle[0] + this.getTimeframeMs(timeframe) - 1
      }));
    } catch (error) {
      // Handle invalid symbol status gracefully - don't log as error
      if (error.message?.includes('Invalid symbol status') || 
          error.message?.includes('-1122') ||
          error.message?.includes('symbol status')) {
        // Let it propagate but don't log as error
        throw error;
      }
      
      logger.error(`Failed to fetch OHLCV for bot ${this.bot.id}:`, error);
      throw error;
    }
  }

  /**
   * Get current ticker price
   * @param {string} symbol - Trading symbol
   * @returns {Promise<number>} Current price
   */
  async getTickerPrice(symbol) {
    try {
      // For Binance: use direct client (production data)
      if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
        return await this.binanceDirectClient.getPrice(symbol);
      }
      
      // WebSocket-first for MEXC
      if (this.bot.exchange === 'mexc') {
        const wsPrice = mexcPriceWs.getPrice(symbol);
        if (Number.isFinite(Number(wsPrice))) return wsPrice;
        // Ensure subscribed; if REST fallback enabled, proceed to REST; otherwise skip
        try { mexcPriceWs.subscribe([symbol]); } catch (_) {}
        const enableRestFallback = configService.getBoolean('MEXC_TICKER_REST_FALLBACK', false);
        if (!enableRestFallback) {
          return null; // skip scan until WS price available
        }
        // else: continue below to CCXT REST swap fetchTicker
      }

      // For other exchanges (MEXC/Gate via CCXT): lightweight cache to avoid rate limits
      const cacheMs = Number(configService.getNumber('NON_BINANCE_TICKER_CACHE_MS', 2000));
      const now = Date.now();

      // Try swap first (default)
      const swapKey = this.formatSymbolForExchange(symbol, 'swap');
      const lastTsSwap = this._tickerCacheTime.get(swapKey) || 0;
      if (cacheMs > 0 && (now - lastTsSwap) < cacheMs) {
        const cached = this._tickerCache.get(swapKey);
        if (cached !== undefined) return cached;
      }

      try {
        const exchange = this.exchange; // swap client for non-binance
        const ticker = await exchange.fetchTicker(swapKey);
        const price = ticker?.last;
        if (Number.isFinite(Number(price))) {
          // Enforce max cache size and cleanup old entries
          this._cleanupTickerCache();
          if (this._tickerCache.size >= this._maxTickerCacheSize && !this._tickerCache.has(swapKey)) {
            const oldest = Array.from(this._tickerCacheTime.entries())
              .sort((a, b) => a[1] - b[1])[0];
            if (oldest) {
              this._tickerCache.delete(oldest[0]);
              this._tickerCacheTime.delete(oldest[0]);
            }
          }
          this._tickerCache.set(swapKey, Number(price));
          this._tickerCacheTime.set(swapKey, now);
          return price;
        }
      } catch (e) {
        // If BadSymbol on MEXC, try spot fallback
        const msg = e?.message || '';
        const isBadSymbol = /BadSymbol|does not have market symbol/i.test(msg);
        if (!(this.bot.exchange === 'mexc' && isBadSymbol)) {
          throw e;
        }
      }

      // MEXC spot fallback (some symbols may be spot-only from REST fallback)
      if (this.bot.exchange === 'mexc') {
        // Lazy init publicSpotExchange
        if (!this.publicSpotExchange) {
          const spot = new ccxt.mexc({ enableRateLimit: true });
          // Force .co domain
          try {
            if ('hostname' in spot) spot.hostname = 'mexc.co';
            const deepReplace = (obj) => {
              if (!obj) return obj;
              if (typeof obj === 'string') return obj.replace(/mexc\.com/g, 'mexc.co');
              if (Array.isArray(obj)) return obj.map(deepReplace);
              if (typeof obj === 'object') { for (const k of Object.keys(obj)) obj[k] = deepReplace(obj[k]); return obj; }
              return obj;
            };
            spot.urls = deepReplace(spot.urls || {});
          } catch (_) {}
          // Load spot markets once
          try { await spot.loadMarkets(); } catch (_) {}
          this.publicSpotExchange = spot;
        }

        const spotKey = (() => {
          let s = symbol.toUpperCase();
          if (!s.includes('/') && s.endsWith('USDT')) s = `${s.replace(/USDT$/, '')}/USDT`;
          return s;
        })();

        const lastTsSpot = this._tickerCacheTime.get(spotKey) || 0;
        if (cacheMs > 0 && (now - lastTsSpot) < cacheMs) {
          const cached = this._tickerCache.get(spotKey);
          if (cached !== undefined) return cached;
        }

        const tickerSpot = await this.publicSpotExchange.fetchTicker(spotKey);
        const priceSpot = tickerSpot?.last;
        if (Number.isFinite(Number(priceSpot))) {
          // Enforce max cache size and cleanup old entries
          this._cleanupTickerCache();
          if (this._tickerCache.size >= this._maxTickerCacheSize && !this._tickerCache.has(spotKey)) {
            const oldest = Array.from(this._tickerCacheTime.entries())
              .sort((a, b) => a[1] - b[1])[0];
            if (oldest) {
              this._tickerCache.delete(oldest[0]);
              this._tickerCacheTime.delete(oldest[0]);
            }
          }
          this._tickerCache.set(spotKey, Number(priceSpot));
          this._tickerCacheTime.set(spotKey, now);
          return priceSpot;
        }
      }

      // No price available from any source - return null (not an error)
      logger.debug(`[ExchangeService] No price available for ${symbol} (bot ${this.bot.id}) from any source`);
      return null;
    } catch (error) {
      // CRITICAL FIX: Distinguish between "price unavailable" (soft) vs "price fetch error" (hard)
      const errorMsg = error?.message || '';
      
      // Soft errors: price temporarily unavailable (WS not ready, symbol not found, etc.)
      const softErrors = [
        'Invalid symbol',
        'symbol not found',
        'BadSymbol',
        'does not have market symbol',
        '-1121', // Binance: Invalid symbol
        '-1122'  // Binance: Invalid symbol status
      ];
      
      const isSoftError = softErrors.some(softErr => errorMsg.includes(softErr));
      
      if (isSoftError) {
        // Soft error: price unavailable, return null (caller should handle gracefully)
        logger.debug(`[ExchangeService] Price unavailable for ${symbol} (soft error): ${errorMsg}`);
        return null;
      } else {
        // Hard error: actual failure (network, API, etc.) - throw to caller
        logger.error(`Failed to get ticker price for bot ${this.bot.id} (${symbol}):`, error);
      throw error;
      }
    }
  }

  /**
   * Get timeframe in milliseconds
   * @param {string} timeframe - Timeframe string
   * @returns {number} Milliseconds
   */
  getTimeframeMs(timeframe) {
    const units = {
      'm': 60 * 1000,
      'h': 60 * 60 * 1000,
      'd': 24 * 60 * 60 * 1000
    };

    const match = timeframe.match(/(\d+)([mhd])/);
    if (!match) return 60000; // Default 1 minute

    const value = parseInt(match[1]);
    const unit = match[2];
    return value * units[unit];
  }

  /**
   * Cancel order
   * @param {string} orderId - Order ID
   * @param {string} symbol - Trading symbol
   * @returns {Promise<Object>} Cancellation result
   */
  async cancelAllOpenOrders(symbol) {
    if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
      return await this.binanceDirectClient.cancelAllOpenOrders(symbol);
    }
    // CCXT does not have a unified method for this, so we'll skip for other exchanges for now.
    logger.warn(`[ExchangeService] cancelAllOpenOrders not implemented for ${this.bot.exchange}`);
    return { success: true };
  }

  async getOpenOrders(symbol) {
    if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
      return await this.binanceDirectClient.getOpenOrders(symbol);
    }
    logger.warn(`[ExchangeService] getOpenOrders not implemented for ${this.bot.exchange}`);
    return [];
  }

  async cancelOrder(orderId, symbol) {
    try {
      // Binance: use direct client
      if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
        const normalizedSymbol = this.binanceDirectClient.normalizeSymbol(symbol);
        const result = await this.binanceDirectClient.cancelOrder(normalizedSymbol, orderId);
        logger.info(`Order cancelled for bot ${this.bot.id}:`, { orderId, symbol: normalizedSymbol });
        return result;
      }

      // Other exchanges: use CCXT
      const marketSymbol = this.formatSymbolForExchange(symbol, 'swap');
      const result = await this.exchange.cancelOrder(orderId, marketSymbol);
      logger.info(`Order cancelled for bot ${this.bot.id}:`, { orderId, symbol: marketSymbol });
      return result;
    } catch (error) {
      // Handle "Unknown order sent" error gracefully - order may have already been filled/cancelled
      if (error.message && error.message.includes('-2011')) {
        logger.warn(`Order ${orderId} not found on exchange (may have been filled or already cancelled): ${error.message}`);
        return null; // Return null to indicate order doesn't exist
      }
      logger.error(`Failed to cancel order for bot ${this.bot.id}:`, error);
      throw error;
    }
  }

  /**
   * Get order status (normalized)
   * @returns {Promise<{status:string, filled:number, raw:any}>}
   */
  async getOrderStatus(symbol, orderId) {
    try {
      if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
        const normalizedSymbol = this.binanceDirectClient.normalizeSymbol(symbol);
        const data = await this.binanceDirectClient.getOrder(normalizedSymbol, orderId);
        const statusMap = {
          NEW: 'open',
          PARTIALLY_FILLED: 'open',
          FILLED: 'closed',
          CANCELED: 'canceled',
          CANCELLED: 'canceled',
          EXPIRED: 'canceled'
        };
        const status = statusMap[data.status] || 'open';
        const filled = parseFloat(data.executedQty || '0') || 0;
        return { status, filled, raw: data };
      }

      // CCXT path
      const marketSymbol = this.formatSymbolForExchange(symbol, 'swap');
      const order = await this.exchange.fetchOrder(orderId, marketSymbol);
      return { status: order.status, filled: order.filled || 0, raw: order };
    } catch (e) {
      logger.warn(`getOrderStatus failed for bot ${this.bot.id} (${symbol}/${orderId}): ${e?.message || e}`);
      return { status: 'unknown', filled: 0, raw: null };
    }
  }

  /**
   * Get average fill price for an order
   * Abstract method that works for all exchanges (not just Binance)
   * @param {string} symbol - Symbol
   * @param {string|number} orderId - Order ID
   * @returns {Promise<number|null>} Average fill price or null if not available
   */
  async getOrderAverageFillPrice(symbol, orderId) {
    try {
      if (this.bot.exchange === 'binance' && this.binanceDirectClient) {
        return await this.binanceDirectClient.getOrderAverageFillPrice(symbol, orderId);
      }
      
      // For other exchanges, try to get from order status
      const orderStatus = await this.getOrderStatus(symbol, orderId);
      if (orderStatus?.raw) {
        // Try to extract average price from order data
        const raw = orderStatus.raw;
        if (raw.avgPrice && Number.isFinite(Number(raw.avgPrice))) {
          return Number(raw.avgPrice);
        }
        if (raw.average && Number.isFinite(Number(raw.average))) {
          return Number(raw.average);
        }
        if (raw.price && Number.isFinite(Number(raw.price))) {
          return Number(raw.price);
        }
      }
      
      return null;
    } catch (e) {
      logger.warn(`getOrderAverageFillPrice failed for ${symbol}/${orderId}: ${e?.message || e}`);
      return null;
    }
  }

  /**
   * Cleanup expired ticker cache entries
   */
  _cleanupTickerCache() {
    const now = Date.now();
    let removed = 0;
    for (const [symbol, timestamp] of this._tickerCacheTime.entries()) {
      if (now - timestamp > this._tickerCacheTTL) {
        this._tickerCache.delete(symbol);
        this._tickerCacheTime.delete(symbol);
        removed++;
      }
    }
    if (removed > 0) {
      logger.debug(`[ExchangeService] Cleaned up ${removed} expired ticker cache entries for bot ${this.bot.id}`);
    }
  }
}

