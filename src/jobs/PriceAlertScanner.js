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
    this.exchangeServicesByBotId = new Map(); // botId -> ExchangeService (from OrderService)
    this.telegramService = null;
    this.isRunning = false;
    this.scanInterval = null;
    this.isScanning = false; // prevent overlapping scans
    this.alertStates = new Map(); // key: exch|symbol|interval -> state

    // ✅ DEDUPE: prevent multiple signals for same (exchange|symbol|interval|strategy) within the same candle bucket
    this.signalStates = new Map(); // key: exch|symbol|interval|strategyId -> { bucket, lastSentAt }
    this.signalMinIntervalMs = 15000; // safety: at most 1 signal per 15s even if bucket calc is jittery
    this.priceCache = new Map(); // Cache prices to avoid excessive API calls
    this.priceCacheTime = new Map(); // Track cache time

    // ✅ PERF: skip processing when price hasn't changed (per exchange|symbol)
    this.lastProcessedPrice = new Map(); // key: exchange|symbol -> price
    this.lastProcessedPriceTime = new Map(); // key: exchange|symbol -> timestamp

    // ✅ OPTIMIZED: Cache PriceAlertConfigs (refresh định kỳ để bắt config mới mà không query mỗi scan)
    this.cachedConfigs = null;
    this.configCacheTime = 0;
    this.configCacheTTL = 60 * 1000; // 60s refresh by default (can be tuned)

    // ✅ OPTIMIZED: Cache symbols với TTL
    this.cachedSymbols = new Map(); // exchange -> Set<symbol>
    this.symbolsCacheTime = new Map(); // exchange -> timestamp
    this.symbolsCacheTTL = 60 * 1000; // 60 seconds (keep it fresh for new subscriptions)

    // ✅ PERFORMANCE: state/price cache cleanup to prevent memory growth over time
    this.stateCleanupEveryMs = 5 * 60 * 1000; // run cleanup every 5 minutes
    this.stateMaxIdleMs = 6 * 60 * 60 * 1000; // drop states not touched for 6 hours
    this.priceCacheMaxIdleMs = 30 * 60 * 1000; // drop price cache not updated for 30 minutes
    this._lastCleanupAt = 0;
  }

  /**
   * Initialize scanner
   * @param {TelegramService} telegramService - Telegram service instance
   * @param {Map<number, OrderService>} orderServices - Map of botId -> OrderService (optional)
   */
  async initialize(telegramService, orderServices = new Map()) {
    this.telegramService = telegramService;
    this.orderServices = orderServices;

    // Build botId -> ExchangeService map from provided OrderServices (reliable for warmup/seed)
    this.exchangeServicesByBotId = new Map();
    try {
      for (const [botId, os] of (orderServices || new Map()).entries()) {
        if (os?.exchangeService) this.exchangeServicesByBotId.set(botId, os.exchangeService);
      }
      logger.info(`[PriceAlertScanner] Mapped ${this.exchangeServicesByBotId.size} ExchangeServices by bot_id for trend warmup`);
    } catch (e) {
      logger.warn(`[PriceAlertScanner] Failed to build exchangeServicesByBotId map: ${e?.message || e}`);
    }

    try {
      // ✅ OPTIMIZED: Cache PriceAlertConfigs lúc init (sẽ refresh định kỳ theo TTL)
      const configs = await PriceAlertConfig.findAll();
      const activeConfigs = configs.filter(cfg => cfg.is_active === true || cfg.is_active === 1 || cfg.is_active === '1');
      this.cachedConfigs = activeConfigs;
      this.configCacheTime = Date.now();
      logger.info(`[PriceAlertScanner] Cached ${activeConfigs.length} active PriceAlertConfigs (TTL ${this.configCacheTTL}ms)`);

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

    // ✅ PERFORMANCE: Polling chỉ là safety-net khi WS miss. Không nên chạy 10ms vì sẽ đốt CPU/GC.
    // Mặc định 500ms là đủ nhanh (realtime chủ yếu đến từ WS tick), vẫn bắt kịp thị trường.
    const interval = configService.getNumber('PRICE_ALERT_SCAN_INTERVAL_MS', 500);

    const runLoop = async () => {
      if (!this.isRunning) return;
      try {
        await this.scan();
      } catch (error) {
        logger.error('PriceAlertScanner scan error:', error);
      } finally {
        // ✅ Avoid timer pile-up: schedule next run only after finishing current scan
        if (this.isRunning) {
          this.scanInterval = setTimeout(runLoop, interval);
        }
      }
    };

    // First run asap
    this.scanInterval = setTimeout(runLoop, 0);

    logger.info(`PriceAlertScanner started with interval ${interval}ms (polling safety-net + WS realtime)`);
  }

  /**
   * Stop the scanner
   */
  stop() {
    if (this.scanInterval) {
      clearTimeout(this.scanInterval);
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

      // ✅ OPTIMIZED: Refresh configs theo TTL (rẻ, không query mỗi scan)
      await this.refreshConfigsIfNeeded();

      const activeConfigs = this.cachedConfigs || [];
      if (activeConfigs.length === 0) {
        logger.debug('[PriceAlertScanner] No active price alert configs');
        return;
      }

      // ✅ PERFORMANCE: Giới hạn concurrency để tránh tạo hàng trăm nghìn Promise cùng lúc
      const concurrency = Number(configService.getNumber('PRICE_ALERT_SCAN_CONCURRENCY', 50));
      await this.runWithConcurrency(activeConfigs, concurrency, async (config) => {
        await this.checkAlertConfig(config);
      });

      // Periodic cleanup to prevent memory growth
      this.cleanupCachesIfNeeded();

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

    // ✅ OPTIMIZED: Cache symbols với TTL (fresh enough to ensure we subscribe all symbols)
    const symbolsToScan = await this.getCachedSymbols(normalizedExchange);

    if (!symbolsToScan || symbolsToScan.length === 0) {
      logger.debug(`[PriceAlertScanner] No symbols to scan for config ${id} (${normalizedExchange})`);
      return;
    }

    // Determine intervals from config; default to ['1m'] if empty
    // Normalize and keep only supported intervals (1m, 5m, 15m, 30m)
    const rawIntervals = Array.isArray(config.intervals) && config.intervals.length > 0
      ? config.intervals
      : ['1m'];

    const intervals = rawIntervals
      .map((x) => this.normalizeInterval(x))
      .filter(Boolean);

    if (intervals.length === 0) {
      logger.warn(`[PriceAlertScanner] Config ${id} has no valid intervals. Expected one of: 1m, 5m, 15m, 30m`);
      return;
    }

    // ✅ PERF: parallelize per-symbol processing with concurrency limiter
    const symbolConcurrency = Number(configService.getNumber('PRICE_ALERT_SYMBOL_SCAN_CONCURRENCY', 200));

    await this.runWithConcurrency(symbolsToScan, symbolConcurrency, async (symbol) => {
      const price = this.getPrice(normalizedExchange, symbol);
      if (!price) return;

      // ✅ PERF: skip if price hasn't changed recently (per exchange|symbol)
      const priceKey = `${normalizedExchange}|${symbol}`;
      const lastPrice = this.lastProcessedPrice.get(priceKey);
      if (Number.isFinite(Number(lastPrice)) && Number(lastPrice) === Number(price)) {
        return;
      }
      this.lastProcessedPrice.set(priceKey, Number(price));
      this.lastProcessedPriceTime.set(priceKey, Date.now());

      for (const interval of intervals) {
        await this.checkSymbolPrice(
          normalizedExchange,
          symbol,
          threshold,
          telegram_chat_id,
          id,
          interval,
          price
        );
      }
    });
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

      // ✅ Use provided currentPrice (synchronous) or fetch synchronously
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
          alerted: false,
          lastSeenAt: now
        });
        return; // first tick initializes bucket open
      }

      const state = this.alertStates.get(stateKey);
      state.lastSeenAt = now;

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

      // 1) ALWAYS execute signal for any OC (no threshold gate)
      // Execute is independent from Telegram success/fail.
      await this.executeStrategiesForOC({
        exchange,
        symbol,
        openPrice,
        currentPrice: price,
        oc,
        interval
      });

      // 2) Telegram volatility alert is optional and rate-limited (still uses config.threshold)
      // Keep existing behaviour to avoid spamming Telegram.
      const nowMs = now;
      const minAlertInterval = 60000; // 1 minute between alerts

      if (ocAbs >= threshold) {
        const timeSinceLastAlert = nowMs - state.lastAlertTime;
        if (!state.alerted || timeSinceLastAlert >= minAlertInterval) {
          // Fire-and-forget: do not block strategy execution
          this.sendPriceAlert(
            exchange,
            symbol,
            openPrice,
            price,
            oc,
            interval,
            telegramChatId,
            configId
          ).catch((e) => {
            logger.warn(`[PriceAlertScanner] Failed to send volatility alert for ${exchange} ${symbol} ${interval}: ${e?.message || e}`);
          });
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
   */
  getPrice(exchange, symbol) {
    try {
      const cacheKey = `${exchange}_${symbol}`;
      let price = null;

      // Priority 1: Try WebSocket first (realtime, no API calls)
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

      // If WebSocket has no price, return cached price (even if stale) as fallback
      if (!price || !Number.isFinite(price)) {
        const cachedPrice = this.priceCache.get(cacheKey);
        if (Number.isFinite(Number(cachedPrice)) && cachedPrice > 0) {
          return cachedPrice; // Use stale cache rather than null
        }
        return null;
      }

      // Always update cache with latest WebSocket price
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
   * ✅ OPTIMIZED: Get cached symbols với TTL
   * @param {string} exchange - Exchange name
   * @returns {Promise<Array<string>>} Array of symbols
   */
  async getCachedSymbols(exchange) {
    const normalizedExchange = (exchange || 'mexc').toLowerCase();
    const now = Date.now();
    const cacheTime = this.symbolsCacheTime.get(normalizedExchange) || 0;

    // Allow TTL override from DB
    const ttl = Number(configService.getNumber('PRICE_ALERT_SYMBOL_CACHE_TTL_MS', this.symbolsCacheTTL));

    // Check if cache is still valid
    if (this.cachedSymbols.has(normalizedExchange) && (now - cacheTime) < ttl) {
      return Array.from(this.cachedSymbols.get(normalizedExchange));
    }

    // Cache expired or not exists, refresh
    const symbols = Array.from(priceAlertSymbolTracker.getSymbolsForExchange(normalizedExchange));
    this.cachedSymbols.set(normalizedExchange, new Set(symbols));
    this.symbolsCacheTime.set(normalizedExchange, now);
    logger.debug(`[PriceAlertScanner] Refreshed symbols cache for ${normalizedExchange}: ${symbols.length} symbols (TTL: ${ttl}ms)`);

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
      this.configCacheTime = Date.now();
      logger.info(`[PriceAlertScanner] Refreshed cached configs: ${activeConfigs.length} active configs`);
    } catch (error) {
      logger.error(`[PriceAlertScanner] Failed to refresh configs:`, error?.message || error);
    }
  }

  async refreshConfigsIfNeeded() {
    const now = Date.now();
    const ttl = Number(configService.getNumber('PRICE_ALERT_CONFIG_CACHE_TTL_MS', this.configCacheTTL));

    if (this.cachedConfigs && (now - (this.configCacheTime || 0)) < ttl) return;
    await this.refreshConfigs();
  }

  cleanupCachesIfNeeded() {
    const now = Date.now();
    if (now - (this._lastCleanupAt || 0) < this.stateCleanupEveryMs) return;
    this._lastCleanupAt = now;

    // Cleanup alertStates
    for (const [key, state] of this.alertStates.entries()) {
      const lastSeenAt = state?.lastSeenAt || 0;
      if (now - lastSeenAt > this.stateMaxIdleMs) {
        this.alertStates.delete(key);
      }
    }

    // Cleanup price cache
    for (const [key, t] of this.priceCacheTime.entries()) {
      if (now - (t || 0) > this.priceCacheMaxIdleMs) {
        this.priceCacheTime.delete(key);
        this.priceCache.delete(key);
      }
    }

    // Cleanup signalStates (dedupe cache)
    // Remove entries older than stateMaxIdleMs to prevent memory growth
    for (const [key, v] of this.signalStates.entries()) {
      const lastSentAt = v?.lastSentAt || 0;
      if (now - lastSentAt > this.stateMaxIdleMs) {
        this.signalStates.delete(key);
      }
    }

    // Cleanup lastProcessedPrice cache (price-unchanged optimization)
    for (const [key, t] of this.lastProcessedPriceTime.entries()) {
      if (now - (t || 0) > this.priceCacheMaxIdleMs) {
        this.lastProcessedPriceTime.delete(key);
        this.lastProcessedPrice.delete(key);
      }
    }
  }

  /**
   * Simple concurrency runner
   */
  async runWithConcurrency(items, concurrency, worker) {
    const limit = Math.max(1, Number(concurrency) || 1);
    let idx = 0;

    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (idx < items.length) {
        const currentIndex = idx++;
        const item = items[currentIndex];
        try {
          await worker(item);
        } catch (err) {
          logger.error(`[PriceAlertScanner] Worker error:`, err?.message || err);
        }
      }
    });

    await Promise.allSettled(runners);
  }

  /**
   * Execute strategies for any OC movement (no threshold)
   * @private
   */
  async executeStrategiesForOC({ exchange, symbol, openPrice, currentPrice, oc, interval }) {
    // Standardize interval format (e.g., '5M' -> '5m')
    const normalizedInterval = this.normalizeInterval(interval);
    if (!normalizedInterval) {
      logger.warn(`[PriceAlertScanner] Invalid interval format: ${interval} for ${exchange} ${symbol}`);
      return;
    }

    // DEDUPE bucket is based on interval
    const intervalMs = this.getIntervalMs(normalizedInterval);
    if (!intervalMs) {
      logger.warn(`[PriceAlertScanner] Unsupported interval ${normalizedInterval} for ${exchange} ${symbol} (dedupe)`);
      return;
    }
    const now = Date.now();
    const bucket = Math.floor(now / intervalMs);

    const strategies = strategyCache.getStrategies(exchange, symbol);
    if (!strategies || strategies.length === 0) {
      return; // No strategies for this symbol
    }

    const ocAbs = Math.abs(oc);
    const direction = oc >= 0 ? 'bullish' : 'bearish';

    for (const strategy of strategies) {
      // Skip if strategy is not active or interval doesn't match exactly
      if (!strategy.is_active ||
          strategy.bot?.is_active === false ||
          this.normalizeInterval(strategy.interval) !== normalizedInterval) {
        continue;
      }

      // Skip if OC doesn't meet strategy threshold (strategy.oc is in %)
      const strategyOcThreshold = Number(strategy.oc || 0);
      if (ocAbs < strategyOcThreshold) {
        continue;
      }

      // ✅ DEDUPE: only one signal per (exchange|symbol|interval|strategy) per bucket
      const dedupeKey = `${exchange}|${symbol}|${normalizedInterval}|${strategy.id}`;
      const prev = this.signalStates.get(dedupeKey);
      if (prev?.bucket === bucket) {
        // same candle bucket => already sent
        continue;
      }
      if (prev?.lastSentAt && (now - prev.lastSentAt) < this.signalMinIntervalMs) {
        // extra safety against jitter/multiple workers
        continue;
      }

      const orderService = this.orderServices.get(strategy.bot_id);
      if (!orderService) {
        logger.warn(`[PriceAlertScanner] No OrderService for bot ${strategy.bot_id}`);
        continue;
      }

      // mark as sent BEFORE execute to prevent concurrent duplicate fires
      this.signalStates.set(dedupeKey, { bucket, lastSentAt: now });

      try {
        const signal = await this.createSignalFromMatch({
          strategy,
          oc,
          direction,
          openPrice,
          currentPrice,
          interval: normalizedInterval,
          timestamp: now
        });

        if (signal) {
          logger.info(`[PriceAlertScanner] 🚀 Sending signal to OrderService for strategy ${strategy.id} (${exchange} ${symbol} ${normalizedInterval} ${oc.toFixed(2)}%)`);
          await orderService.executeSignal(signal);
        }
      } catch (error) {
        // allow re-send on next tick if execute failed
        this.signalStates.delete(dedupeKey);
        logger.error(`[PriceAlertScanner] Error executing strategy ${strategy.id}:`, error);
      }
    }
  }

  /**
   * Normalize interval string to standard format (e.g., '5M' -> '5m')
   * @private
   */
  normalizeInterval(interval) {
    if (!interval) return null;
    // Convert to lowercase and remove any non-alphanumeric characters
    const normalized = String(interval).toLowerCase().replace(/[^a-z0-9]/g, '');
    // Only allow specific intervals
    const validIntervals = ['1m', '5m', '15m', '30m'];
    return validIntervals.includes(normalized) ? normalized : null;
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
      logger.info(`[PriceAlertScanner] Sending alert for ${exchange.toUpperCase()} ${symbol} ${interval} (OC: ${ocPercent.toFixed(2)}%) to chat_id=${telegramChatId} (config_id=${configId})`);

      try {
        await this.telegramService.sendVolatilityAlert(telegramChatId, {
          symbol,
          interval: this.normalizeInterval(interval) || '1m',
          oc: ocPercent,
          open: openPrice,
          currentPrice,
          direction
        });
        logger.info(`[PriceAlertScanner] ✅ Alert queued: ${exchange.toUpperCase()} ${symbol} ${interval} (OC: ${ocPercent.toFixed(2)}%, open=${openPrice}, current=${currentPrice}) to chat_id=${telegramChatId}`);
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

      const { calculateTakeProfit, calculateInitialStopLoss, calculateLongEntryPrice, calculateShortEntryPrice } = await import('../utils/calculator.js');
      const { determineSide } = await import('../utils/sideSelector.js');
      const { configService } = await import('../services/ConfigService.js');

      const side = determineSide(direction, strategy.trade_type, strategy.is_reverse_strategy);
      if (!side) {
        logger.info(
          `[PriceAlertScanner] ⏭️ Strategy ${strategy.id} skipped by side mapping ` +
          `(direction=${direction}, trade_type=${strategy.trade_type}, is_reverse_strategy=${strategy.is_reverse_strategy})`
        );
        return null;
      }

      const baseOpen = Number.isFinite(Number(openPrice)) && Number(openPrice) > 0
        ? Number(openPrice)
        : currentPrice;

      const isReverseStrategy = Boolean(strategy.is_reverse_strategy);

      // ✅ Trend filter (ONLY for trend-following / is_reverse_strategy=false)
      if (!isReverseStrategy) {
        const { trendContext } = await import('../utils/TrendContext.js');

        trendContext.updateFromTick({
          symbol: strategy.symbol,
          currentPrice,
          ocAbs: Math.abs(oc),
          direction,
          timestamp
        });

        const v = trendContext.isValidTrend({
          symbol: strategy.symbol,
          currentPrice,
          openPrice: baseOpen,
          direction,
          ocAbs: Math.abs(oc),
          ocThreshold: Math.abs(Number(strategy.oc || strategy.open_change || oc || 0))
        });

        if (!v.ok) {
          trendContext.logBlock({ reason: v.reason, symbol: strategy.symbol, direction, meta: v.meta });

          // ✅ Trigger warmup polling if block is due to insufficient EMA data
          if (v.reason === 'ema_slope_insufficient_data') {
            // Try to get ExchangeService instance for this bot (binance only warmup)
            const exchangeService = this.exchangeServicesByBotId?.get(strategy.bot_id);
            if (exchangeService) {
              logger.info(`[TREND-WARMUP-TRIGGER] source=PriceAlertScanner botId=${strategy.bot_id} symbol=${strategy.symbol} exchange=${exchangeService?.bot?.exchange || 'unknown'}`);
              trendContext.maybeWarmupOnInsufficientData({
                symbol: strategy.symbol,
                exchangeService,
                direction
              }).catch(e => {
                logger.warn(`[TREND-WARMUP] Failed to trigger warmup for ${strategy.symbol}: ${e?.message || e}`);
              });
            } else {
              logger.warn(`[TREND-WARMUP-TRIGGER] source=PriceAlertScanner botId=${strategy.bot_id} symbol=${strategy.symbol} missing_exchangeService=true`);
            }
          }

          return null; // BLOCK ENTRY (trend-follow only)
        }
      }

      let entryPrice;
      let forceMarket = false;

      if (isReverseStrategy) {
        entryPrice = side === 'long'
          ? calculateLongEntryPrice(currentPrice, baseOpen, strategy.extend || 0)
          : calculateShortEntryPrice(currentPrice, baseOpen, strategy.extend || 0);
      } else {
        entryPrice = currentPrice;
        forceMarket = true;
      }

      const totalExtendDistance = isReverseStrategy ? Math.abs(baseOpen - entryPrice) : 0;

      const tpPrice = calculateTakeProfit(entryPrice, strategy.take_profit || 55, side);
      const rawStoploss = strategy.stoploss !== undefined ? Number(strategy.stoploss) : NaN;
      const isStoplossValid = Number.isFinite(rawStoploss) && rawStoploss > 0;
      const slPrice = isStoplossValid ? calculateInitialStopLoss(entryPrice, rawStoploss, side) : null;

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

      if (!isReverseStrategy) {
        return signal;
      } else {
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
