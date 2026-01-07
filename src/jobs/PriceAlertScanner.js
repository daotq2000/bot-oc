import { PriceAlertConfig } from '../models/PriceAlertConfig.js';
import { ExchangeService } from '../services/ExchangeService.js';
import { TelegramService } from '../services/TelegramService.js';
import { configService } from '../services/ConfigService.js';
import { priceAlertSymbolTracker } from '../services/PriceAlertSymbolTracker.js';
import { strategyCache } from '../services/StrategyCache.js';
import { webSocketManager } from '../services/WebSocketManager.js';
import { mexcPriceWs } from '../services/MexcWebSocketManager.js';
import logger from '../utils/logger.js';

/**
 * Price Alert Scanner Job - Monitor price alerts for MEXC and other exchanges
 */
export class PriceAlertScanner {
  constructor() {
    this.exchangeServices = new Map(); // exchange -> ExchangeService
    this.orderServices = new Map(); // botId -> OrderService
    this.telegramService = null;
    this.isRunning = false;
    this.scanInterval = null;
    this.isScanning = false; // prevent overlapping scans
    this.alertStates = new Map(); // key: exch|symbol -> { lastPrice, lastAlertTime, armed }
    this.priceCache = new Map(); // Cache prices to avoid excessive API calls
    this.priceCacheTime = new Map(); // Track cache time
    
    // ✅ OPTIMIZED: Cache PriceAlertConfigs lúc init, không có TTL
    this.cachedConfigs = null; // Cached active configs (no TTL, refresh manually)
    
    // ✅ OPTIMIZED: Cache symbols với TTL 15 phút
    this.cachedSymbols = new Map(); // exchange -> Set<symbol>
    this.symbolsCacheTime = new Map(); // exchange -> timestamp
    this.symbolsCacheTTL = 15 * 60 * 1000; // 15 minutes
  }

  /**
   * Initialize scanner
   * @param {TelegramService} telegramService - Telegram service instance
   * @param {Map<number, OrderService>} orderServices - Map of botId -> OrderService (optional)
   */
  async initialize(telegramService, orderServices = new Map()) {
    this.telegramService = telegramService;
    this.orderServices = orderServices;

    try {
      // ✅ OPTIMIZED: Cache PriceAlertConfigs lúc init, không có TTL
      const configs = await PriceAlertConfig.findAll();
      const activeConfigs = configs.filter(cfg => cfg.is_active === true || cfg.is_active === 1 || cfg.is_active === '1');
      this.cachedConfigs = activeConfigs;
      logger.info(`[PriceAlertScanner] Cached ${activeConfigs.length} active PriceAlertConfigs (no TTL)`);
      
      // Extract unique exchanges from configs
      const exchanges = new Set();
      for (const config of activeConfigs) {
        const exchange = (config.exchange || 'mexc').toLowerCase();
        if (exchange) {
          exchanges.add(exchange);
        }
      }

      // Always cover both exchanges to act as a safety net when WebSocket misses.
      // (Public price mode; no keys required.)
      exchanges.add('mexc');
      exchanges.add('binance');

      // Fallback to default exchanges if no configs found
      if (exchanges.size === 0) {
        logger.warn('[PriceAlertScanner] No active configs found, using default exchanges: binance, mexc');
        exchanges.add('binance');
        exchanges.add('mexc');
      }

      logger.info(`[PriceAlertScanner] Initializing for exchanges: ${Array.from(exchanges).join(', ')}`);
      
      // Initialize exchanges sequentially with delay to reduce CPU load
      const exchangeArray = Array.from(exchanges);
      for (let i = 0; i < exchangeArray.length; i++) {
        const exchange = exchangeArray[i];
        try {
          // Create a dummy bot object for exchange initialization
          const dummyBot = {
            id: `scanner_${exchange}`,
            exchange: exchange,
            access_key: process.env[`${exchange.toUpperCase()}_API_KEY`] || '',
            secret_key: process.env[`${exchange.toUpperCase()}_SECRET_KEY`] || '',
            uid: process.env[`${exchange.toUpperCase()}_UID`] || ''
          };

          const exchangeService = new ExchangeService(dummyBot);
          // Always initialize for public price fetching (no keys required)
          await exchangeService.initialize();
          this.exchangeServices.set(exchange, exchangeService);
          logger.info(`[PriceAlertScanner] ✅ Initialized for ${exchange} exchange (public price mode)`);
          
          // Add delay between exchange initializations to reduce CPU load
          if (i < exchangeArray.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay
          }
        } catch (error) {
          logger.warn(`[PriceAlertScanner] Failed to initialize for ${exchange}:`, error.message);
        }
      }
    } catch (error) {
      logger.error('[PriceAlertScanner] Failed to initialize:', error);
    }
  }

  /**
   * Start the scanner
   */
  start() {
    if (this.isRunning) {
      logger.warn('PriceAlertScanner is already running');
      return;
    }

    this.isRunning = true;
    // ✅ ULTRA OPTIMIZED: Giảm scan interval xuống 10ms để phát hiện tín hiệu cực nhanh
    // Với parallel processing và WebSocket cache, có thể scan rất nhanh
    const interval = configService.getNumber('PRICE_ALERT_SCAN_INTERVAL_MS', 10); // Ultra-fast: 10ms
    
    // Use setImmediate for first scan, then setInterval for subsequent scans
    setImmediate(() => {
      this.scan().catch(error => {
        logger.error('PriceAlertScanner scan error:', error);
      });
    });
    
    this.scanInterval = setInterval(() => {
      this.scan().catch(error => {
        logger.error('PriceAlertScanner scan error:', error);
      });
    }, interval);

    logger.info(`PriceAlertScanner started with interval ${interval}ms (ultra-fast parallel processing)`);
  }

  /**
   * Stop the scanner
   */
  stop() {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    this.isRunning = false;
    logger.info('PriceAlertScanner stopped');
  }

  /**
   * Main scan loop
   */
  async scan() {
    // Prevent overlapping scans
    if (this.isScanning) {
      logger.debug('[PriceAlertScanner] Scan already in progress, skipping');
      return;
    }

    this.isScanning = true;
    const scanStartTime = Date.now();
    const maxScanDurationMs = Number(configService.getNumber('PRICE_ALERT_MAX_SCAN_DURATION_MS', 30000));

    try {
      // Check master ENABLE_ALERTS switch first
      const alertsEnabled = configService.getBoolean('ENABLE_ALERTS', true);
      if (!alertsEnabled) {
        logger.debug('[PriceAlertScanner] Alerts disabled by ENABLE_ALERTS config, skipping scan');
        return;
      }

      const enabled = configService.getBoolean('PRICE_ALERT_CHECK_ENABLED', true);
      if (!enabled) {
        logger.debug('[PriceAlertScanner] Price alert checking is disabled');
        return;
      }

      // ✅ OPTIMIZED: Sử dụng cached configs (không query DB mỗi lần scan)
      const activeConfigs = this.cachedConfigs || [];
      if (activeConfigs.length === 0) {
        logger.debug('[PriceAlertScanner] No active price alert configs');
        return;
      }

      // ✅ ULTRA OPTIMIZED: Process ALL configs in parallel (no batching) để tối đa tốc độ
      // Với WebSocket cache, có thể xử lý tất cả cùng lúc mà không lo rate limit
      await Promise.allSettled(
        activeConfigs.map(config => 
          this.checkAlertConfig(config).catch(error => {
            logger.error(`[PriceAlertScanner] Error checking price alert config ${config.id}:`, error?.message || error);
          })
        )
      );

      const scanDuration = Date.now() - scanStartTime;
      logger.debug(`[PriceAlertScanner] Scan completed in ${scanDuration}ms`);
    } catch (error) {
      logger.error('PriceAlertScanner scan failed:', error);
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * Check a single alert config
   */
  async checkAlertConfig(config) {
    const { id, exchange, threshold, telegram_chat_id } = config;
    const normalizedExchange = (exchange || 'mexc').toLowerCase();

    // Get exchange service
    const exchangeService = this.exchangeServices.get(normalizedExchange);
    if (!exchangeService) {
      logger.debug(`[PriceAlertScanner] No exchange service for ${normalizedExchange}, skipping alert config ${id}`);
      return;
    }

    // ✅ OPTIMIZED: Cache symbols với TTL 15 phút
    const symbolsToScan = await this.getCachedSymbols(normalizedExchange);

    if (!symbolsToScan || symbolsToScan.length === 0) {
      logger.debug(`[PriceAlertScanner] No symbols to scan for config ${id} (${normalizedExchange})`);
      return;
    }

    // Determine intervals from config; default to ['1m'] if empty
    const intervals = Array.isArray(config.intervals) && config.intervals.length > 0
      ? config.intervals
      : ['1m'];

    // ✅ ULTRA OPTIMIZED: Synchronous price fetching từ WebSocket cache (no async overhead)
    // Process all symbols in parallel with synchronous price fetching
    const priceResults = symbolsToScan.map(symbol => {
      try {
        const price = this.getPrice(normalizedExchange, symbol);
        return { status: 'fulfilled', value: { symbol, price } };
      } catch (error) {
        return { status: 'rejected', reason: error };
      }
    });
    
    // Process all symbols with their prices in parallel
    await Promise.allSettled(
      priceResults.map((result, idx) => {
        if (result.status === 'rejected') {
          return Promise.resolve();
        }
        
        const { symbol, price } = result.value;
        if (!price) return Promise.resolve();
        
        // Process all intervals for this symbol in parallel
        return Promise.allSettled(
          intervals.map(interval =>
            this.checkSymbolPrice(
              normalizedExchange,
              symbol,
              threshold,
              telegram_chat_id,
              id,
              interval,
              price
            )
          )
        );
      })
    );
  }

  /**
   * Check price for a specific symbol
   */
  async checkSymbolPrice(exchange, symbol, threshold, telegramChatId, configId, interval = '1m', currentPrice = null) {
    try {
      const exchangeService = this.exchangeServices.get(exchange);
      if (!exchangeService) {
        return;
      }

      // ✅ ULTRA OPTIMIZED: Use provided currentPrice (synchronous) or fetch synchronously
      const price = currentPrice !== null ? currentPrice : this.getPrice(exchange, symbol);
      if (!price) return;

      // Resolve interval ms
      const intervalMs = this.getIntervalMs(interval);
      if (!intervalMs) {
        logger.warn(`[PriceAlertScanner] Unsupported interval ${interval} for ${symbol}, skipping`);
        return;
      }

      const now = Date.now();
      const bucket = Math.floor(now / intervalMs);

      // State per exchange-symbol-interval
      const stateKey = `${exchange}_${symbol}_${interval}`;
      if (!this.alertStates.has(stateKey)) {
        this.alertStates.set(stateKey, {
          openPrice: price,
          bucket,
          lastAlertTime: 0,
          alerted: false
        });
        return; // first tick initializes bucket open
      }

      const state = this.alertStates.get(stateKey);

      // New bucket -> reset openPrice and alerted flag
      if (state.bucket !== bucket) {
        state.openPrice = price;
        state.bucket = bucket;
        state.alerted = false;
      }

      const openPrice = state.openPrice;
      if (!openPrice || Number(openPrice) === 0) return;

      const oc = ((price - openPrice) / openPrice) * 100; // signed
      const ocAbs = Math.abs(oc);

      const nowMs = now;
      const minAlertInterval = 60000; // 1 minute between alerts

      if (ocAbs >= threshold) {
        const timeSinceLastAlert = nowMs - state.lastAlertTime;
        if (!state.alerted || timeSinceLastAlert >= minAlertInterval) {
          await this.sendPriceAlert(
            exchange,
            symbol,
            openPrice,
            price,
            oc,
            interval,
            telegramChatId,
            configId
          );
          state.lastAlertTime = nowMs;
          state.alerted = true;
        }
      } else {
        // Reset alerted flag when oc drops below threshold
        state.alerted = false;
      }
    } catch (error) {
      logger.warn(`Error checking symbol price ${symbol} on ${exchange}:`, error.message);
    }
  }

  /**
   * Get price for a symbol (synchronous for WebSocket cache)
   * Priority: WebSocket (realtime) > Cached > null
   * ✅ ULTRA OPTIMIZED: Synchronous function vì chỉ đọc từ WebSocket cache (không cần async)
   */
  getPrice(exchange, symbol) {
    try {
      const cacheKey = `${exchange}_${symbol}`;
      let price = null;

      // ✅ ULTRA OPTIMIZED: Direct synchronous access to WebSocket cache (no async overhead)
      // Priority 1: Try WebSocket first (realtime, no API calls, no delay, synchronous)
      if (exchange === 'binance') {
        const wsPrice = webSocketManager.getPrice(symbol);
        if (Number.isFinite(Number(wsPrice)) && wsPrice > 0) {
          price = Number(wsPrice);
        }
      } else if (exchange === 'mexc') {
        const wsPrice = mexcPriceWs.getPrice(symbol);
        if (Number.isFinite(Number(wsPrice)) && wsPrice > 0) {
          price = Number(wsPrice);
        }
      }

      // ✅ OPTIMIZED: If WebSocket has no price, return cached price (even if expired) as fallback
      // This prevents missing signals when WebSocket temporarily loses connection
      if (!price || !Number.isFinite(price)) {
        const cachedPrice = this.priceCache.get(cacheKey);
        if (Number.isFinite(Number(cachedPrice)) && cachedPrice > 0) {
          return cachedPrice; // Use stale cache rather than null
        }
        return null;
      }

      // ✅ OPTIMIZED: Always update cache with latest WebSocket price (no TTL check)
      // This ensures we always have the latest price available
      this.priceCache.set(cacheKey, price);
      this.priceCacheTime.set(cacheKey, Date.now());
      return price;
    } catch (error) {
      // Return cached price as fallback (silent fail for performance)
      const cacheKey = `${exchange}_${symbol}`;
      const cachedPrice = this.priceCache.get(cacheKey);
      if (Number.isFinite(Number(cachedPrice)) && cachedPrice > 0) {
        return cachedPrice;
      }
      return null;
    }
  }

  /**
   * ✅ OPTIMIZED: Get cached symbols với TTL 15 phút
   * @param {string} exchange - Exchange name
   * @returns {Promise<Array<string>>} Array of symbols
   */
  async getCachedSymbols(exchange) {
    const normalizedExchange = (exchange || 'mexc').toLowerCase();
    const now = Date.now();
    const cacheTime = this.symbolsCacheTime.get(normalizedExchange) || 0;
    
    // Check if cache is still valid
    if (this.cachedSymbols.has(normalizedExchange) && (now - cacheTime) < this.symbolsCacheTTL) {
      return Array.from(this.cachedSymbols.get(normalizedExchange));
    }
    
    // Cache expired or not exists, refresh
    const symbols = Array.from(priceAlertSymbolTracker.getSymbolsForExchange(normalizedExchange));
    this.cachedSymbols.set(normalizedExchange, new Set(symbols));
    this.symbolsCacheTime.set(normalizedExchange, now);
    logger.debug(`[PriceAlertScanner] Refreshed symbols cache for ${normalizedExchange}: ${symbols.length} symbols (TTL: 15 minutes)`);
    
    return symbols;
  }

  /**
   * Refresh cached configs (call manually when needed)
   */
  async refreshConfigs() {
    try {
      const configs = await PriceAlertConfig.findAll();
      const activeConfigs = configs.filter(cfg => cfg.is_active === true || cfg.is_active === 1 || cfg.is_active === '1');
      this.cachedConfigs = activeConfigs;
      logger.info(`[PriceAlertScanner] Refreshed cached configs: ${activeConfigs.length} active configs`);
    } catch (error) {
      logger.error(`[PriceAlertScanner] Failed to refresh configs:`, error?.message || error);
    }
  }

  /**
   * Send price alert via Telegram
   */
  async sendPriceAlert(exchange, symbol, openPrice, currentPrice, ocPercent, interval, telegramChatId, configId) {
    try {
      if (!this.telegramService) {
        logger.warn(`[PriceAlertScanner] Telegram service not available, skipping alert for ${exchange} ${symbol}`);
        return;
      }
      
      // Use config's telegram_chat_id, don't fallback to default
      if (!telegramChatId) {
        logger.warn(`[PriceAlertScanner] No telegram_chat_id for config ${configId} (${exchange}), skipping alert for ${symbol}`);
        return;
      }

      const bullish = Number(currentPrice) >= Number(openPrice);
      const direction = bullish ? 'bullish' : 'bearish';

      // Use compact line format via TelegramService
      const ocAbs = Math.abs(ocPercent);
      logger.info(`[PriceAlertScanner] Sending alert for ${exchange.toUpperCase()} ${symbol} ${interval} (OC: ${ocPercent.toFixed(2)}%) to chat_id=${telegramChatId} (config_id=${configId})`);
      
      try {
        await this.telegramService.sendVolatilityAlert(telegramChatId, {
          symbol,
          interval: interval || '1m',
          oc: ocPercent,
          open: openPrice,
          currentPrice,
          direction
        });
        // Note: Actual send happens asynchronously in queue, check logs for "Successfully sent message"
        logger.info(`[PriceAlertScanner] ✅ Alert queued: ${exchange.toUpperCase()} ${symbol} ${interval} (OC: ${ocPercent.toFixed(2)}%, open=${openPrice}, current=${currentPrice}) to chat_id=${telegramChatId}`);

        // --- Trigger Order Execution Flow ---
        // ✅ OPTIMIZED: Gửi signal đến OrderService để service tự xử lý logic
        try {
          const strategies = strategyCache.getStrategies(exchange, symbol);
          if (strategies.length === 0) {
            logger.debug(`[PriceAlertScanner] No strategies found for ${exchange} ${symbol} after alert.`);
            return;
          }

          for (const strategy of strategies) {
            // Basic validation to ensure strategy is active and matches the interval
            if (!strategy.is_active || strategy.bot?.is_active === false || strategy.interval !== interval) {
              continue;
            }

            const ocThreshold = Number(strategy.oc || 0);
            if (ocAbs < ocThreshold) {
              continue;
            }

            const botId = strategy.bot_id;
            const orderService = this.orderServices.get(botId);
            if (!orderService) {
              const availableBots = Array.from(this.orderServices.keys());
              logger.warn(`[PriceAlertScanner] ⚠️ No OrderService found for bot ${botId}, skipping strategy ${strategy.id}. Available bots: ${availableBots.length > 0 ? availableBots.join(', ') : 'none'}`);
              continue;
            }

            try {
              // ✅ Tạo signal object giống như WebSocketOCConsumer.processMatch()
              const signal = await this.createSignalFromMatch({
                strategy,
                oc: ocPercent,
                direction,
                openPrice,
                currentPrice,
                interval,
                timestamp: Date.now()
              });

              if (!signal) {
                logger.debug(`[PriceAlertScanner] Signal creation skipped for strategy ${strategy.id}`);
                continue;
              }

              logger.info(`[PriceAlertScanner] 🚀 Sending signal to OrderService for strategy ${strategy.id} (bot_id=${botId})`);
              const result = await orderService.executeSignal(signal);
              
              if (result && result.id) {
                logger.info(`[PriceAlertScanner] ✅ Order executed successfully for strategy ${strategy.id}, position ${result.id} opened`);
              } else {
                logger.debug(`[PriceAlertScanner] ✅ Signal sent to OrderService for strategy ${strategy.id}`);
              }
            } catch (execErr) {
              logger.error(
                `[PriceAlertScanner] ❌ Error executing signal for strategy ${strategy.id}:`,
                execErr?.message || execErr
              );
            }
          }
        } catch (execErr) {
          logger.error(`[PriceAlertScanner] ❌ Error during strategy execution after alert:`, execErr?.message || execErr);
        }
      } catch (error) {
        logger.error(`[PriceAlertScanner] ❌ Failed to send alert to chat_id=${telegramChatId}:`, error?.message || error);
      }
    } catch (error) {
      logger.error(`Failed to send price alert for ${symbol}:`, error);
    }
  }

  /**
   * ✅ Create signal object từ match (giống logic trong WebSocketOCConsumer.processMatch())
   * @param {Object} match - Match object
   * @returns {Promise<Object|null>} Signal object or null if skipped
   */
  async createSignalFromMatch(match) {
    try {
      const { strategy, oc, direction, openPrice, currentPrice, interval, timestamp } = match;
      const botId = strategy.bot_id;

      // Import calculator functions for TP/SL calculation
      const { calculateTakeProfit, calculateInitialStopLoss, calculateLongEntryPrice, calculateShortEntryPrice } = await import('../utils/calculator.js');
      const { determineSide } = await import('../utils/sideSelector.js');
      const { configService } = await import('../services/ConfigService.js');

      // Determine side based on direction, trade_type and is_reverse_strategy from bot
      const side = determineSide(direction, strategy.trade_type, strategy.is_reverse_strategy);
      if (!side) {
        logger.info(
          `[PriceAlertScanner] ⏭️ Strategy ${strategy.id} skipped by side mapping ` +
          `(direction=${direction}, trade_type=${strategy.trade_type}, is_reverse_strategy=${strategy.is_reverse_strategy})`
        );
        return null;
      }

      // Use interval open price for entry calculation (per-bucket open)
      const baseOpen = Number.isFinite(Number(openPrice)) && Number(openPrice) > 0
        ? Number(openPrice)
        : currentPrice;

      // Determine entry price and order type based on strategy type
      const isReverseStrategy = Boolean(strategy.is_reverse_strategy);
      let entryPrice;
      let forceMarket = false;

      if (isReverseStrategy) {
        // Counter-trend: Calculate entry price with extend logic
        entryPrice = side === 'long'
          ? calculateLongEntryPrice(currentPrice, baseOpen, strategy.extend || 0)
          : calculateShortEntryPrice(currentPrice, baseOpen, strategy.extend || 0);
      } else {
        // Trend-following: Use current price directly, force MARKET order
        entryPrice = currentPrice;
        forceMarket = true;
      }

      // Pre-calculate extend distance (only for counter-trend)
      const totalExtendDistance = isReverseStrategy ? Math.abs(baseOpen - entryPrice) : 0;

      // Calculate TP and SL (based on side)
      const tpPrice = calculateTakeProfit(entryPrice, strategy.take_profit || 55, side);
      const rawStoploss = strategy.stoploss !== undefined ? Number(strategy.stoploss) : NaN;
      const isStoplossValid = Number.isFinite(rawStoploss) && rawStoploss > 0;
      const slPrice = isStoplossValid ? calculateInitialStopLoss(entryPrice, rawStoploss, side) : null;

      // Create signal object
      const signal = {
        strategy: strategy,
        side,
        entryPrice: entryPrice,
        currentPrice: currentPrice,
        oc: Math.abs(oc),
        interval,
        timestamp: timestamp || Date.now(),
        tpPrice: tpPrice,
        slPrice: slPrice,
        amount: strategy.amount || 1000,
        forceMarket: forceMarket
      };

      // Extend check only applies to counter-trend strategies
      if (!isReverseStrategy) {
        // Trend-following: Skip extend check, MARKET order will be used
        return signal;
      } else {
        // Counter-trend: Check extend condition
        const extendOK = true; // Simplified for PriceAlertScanner
        if (!extendOK) {
          const allowPassive = configService.getBoolean('ENABLE_LIMIT_ON_EXTEND_MISS', true);
          if (allowPassive) {
            const maxDiffRatio = Number(configService.getNumber('EXTEND_LIMIT_MAX_DIFF_RATIO', 0.5)) || 0.5;
            let priceDiffRatio = 0;
            if (totalExtendDistance > 0) {
              priceDiffRatio = Math.abs(currentPrice - entryPrice) / totalExtendDistance;
            }

            if (totalExtendDistance === 0 || priceDiffRatio <= maxDiffRatio) {
              signal.forcePassiveLimit = true;
              return signal;
            } else {
              logger.debug(
                `[PriceAlertScanner] ⏭️ Extend not met for strategy ${strategy.id}, skipping ` +
                `(priceDiffRatio=${priceDiffRatio.toFixed(4)} > maxDiffRatio=${maxDiffRatio})`
              );
              return null;
            }
          } else {
            logger.debug(`[PriceAlertScanner] ⏭️ Extend not met for strategy ${strategy.id}, skipping (passive LIMIT disabled)`);
            return null;
          }
        }
      }

      return signal;
    } catch (error) {
      logger.error(`[PriceAlertScanner] Error creating signal from match:`, error?.message || error);
      return null;
    }
  }

  /**
   * Interval string to milliseconds
   */
  getIntervalMs(interval) {
    const map = {
      '1m': 60_000,
      '3m': 180_000,
      '5m': 300_000,
      '15m': 900_000,
      '30m': 1_800_000,
      '1h': 3_600_000,
      '2h': 7_200_000,
      '4h': 14_400_000,
      '6h': 21_600_000,
      '8h': 28_800_000,
      '12h': 43_200_000,
      '1d': 86_400_000
    };
    return map[interval] || null;
  }
}

