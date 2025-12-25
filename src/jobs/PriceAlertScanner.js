import { PriceAlertConfig } from '../models/PriceAlertConfig.js';
import { ExchangeService } from '../services/ExchangeService.js';
import { TelegramService } from '../services/TelegramService.js';
import { configService } from '../services/ConfigService.js';
import { priceAlertSymbolTracker } from '../services/PriceAlertSymbolTracker.js';
import logger from '../utils/logger.js';

/**
 * Price Alert Scanner Job - Monitor price alerts for MEXC and other exchanges
 */
export class PriceAlertScanner {
  constructor() {
    this.exchangeServices = new Map(); // exchange -> ExchangeService
    this.telegramService = null;
    this.isRunning = false;
    this.scanInterval = null;
    this.isScanning = false; // prevent overlapping scans
    this.alertStates = new Map(); // key: exch|symbol -> { lastPrice, lastAlertTime, armed }
    this.priceCache = new Map(); // Cache prices to avoid excessive API calls
    this.priceCacheTime = new Map(); // Track cache time
  }

  /**
   * Initialize scanner
   */
  async initialize(telegramService) {
    this.telegramService = telegramService;

    try {
      // Get unique exchanges from active price alert configs
      const configs = await PriceAlertConfig.findAll();
      const activeConfigs = configs.filter(cfg => cfg.is_active === true || cfg.is_active === 1 || cfg.is_active === '1');
      
      // Extract unique exchanges from configs
      const exchanges = new Set();
      for (const config of activeConfigs) {
        const exchange = (config.exchange || 'mexc').toLowerCase();
        if (exchange) {
          exchanges.add(exchange);
        }
      }

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
    const interval = configService.getNumber('PRICE_ALERT_SCAN_INTERVAL_MS', 15000); // Increased from 5s to 15s
    
    this.scanInterval = setInterval(() => {
      this.scan().catch(error => {
        logger.error('PriceAlertScanner scan error:', error);
      });
    }, interval);

    logger.info(`PriceAlertScanner started with interval ${interval}ms`);
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

      // Get all active price alert configs
      // Note: PriceAlertConfig.findAll() already filters by is_active = TRUE in SQL
      const configs = await PriceAlertConfig.findAll();
      // Double-check: handle both boolean true and number 1 from MySQL
      const activeConfigs = configs.filter(cfg => cfg.is_active === true || cfg.is_active === 1 || cfg.is_active === '1');
      if (activeConfigs.length === 0) {
        logger.debug('[PriceAlertScanner] No active price alert configs');
        return;
      }

      // Process each active config
      for (const config of activeConfigs) {
        // Check timeout
        if (Date.now() - scanStartTime > maxScanDurationMs) {
          logger.warn(`[PriceAlertScanner] Scan exceeded max duration (${maxScanDurationMs}ms), stopping early`);
          break;
        }

        try {
          await this.checkAlertConfig(config);
        } catch (error) {
          logger.error(`[PriceAlertScanner] Error checking price alert config ${config.id}:`, error?.message || error);
          // Continue with next config even if one fails
        }
      }

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

    // Get symbols from PriceAlertSymbolTracker
    const symbolsToScan = Array.from(priceAlertSymbolTracker.getSymbolsForExchange(normalizedExchange));

    if (!symbolsToScan || symbolsToScan.length === 0) {
      logger.debug(`[PriceAlertScanner] No symbols to scan for config ${id} (${normalizedExchange})`);
      return;
    }

    // Determine intervals from config; default to ['1m'] if empty
    const intervals = Array.isArray(config.intervals) && config.intervals.length > 0
      ? config.intervals
      : ['1m'];

    // Check each symbol (fetch price once, reuse for intervals)
    for (const symbol of symbolsToScan) {
      try {
        const currentPrice = await this.getPrice(normalizedExchange, symbol);
        if (!currentPrice) continue;

        for (const interval of intervals) {
          await this.checkSymbolPrice(
            normalizedExchange,
            symbol,
            threshold,
            telegram_chat_id,
            id,
            interval,
            currentPrice
          );
        }
      } catch (error) {
        logger.warn(`Error checking price for ${symbol} on ${exchange}:`, error.message);
      }
    }
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

      // Use provided currentPrice if given, otherwise fetch
      const price = currentPrice !== null ? currentPrice : await this.getPrice(exchange, symbol);
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
   * Get price for a symbol (with caching)
   * Priority: WebSocket > ExchangeService > null
   */
  async getPrice(exchange, symbol) {
    try {
      const cacheKey = `${exchange}_${symbol}`;
      const now = Date.now();
      const cacheTime = this.priceCacheTime.get(cacheKey) || 0;
      const cacheDuration = 500; // Reduced from 2000ms to 500ms for better realtime tracking

      // Return cached price if still valid
      if (now - cacheTime < cacheDuration) {
        return this.priceCache.get(cacheKey);
      }

      let price = null;

      // Priority 1: Try WebSocket first (realtime, no API calls)
      if (exchange === 'binance') {
        const { webSocketManager } = await import('../services/WebSocketManager.js');
        const wsPrice = webSocketManager.getPrice(symbol);
        if (Number.isFinite(Number(wsPrice)) && wsPrice > 0) {
          price = Number(wsPrice);
        }
      } else if (exchange === 'mexc') {
        const { mexcPriceWs } = await import('../services/MexcWebSocketManager.js');
        const wsPrice = mexcPriceWs.getPrice(symbol);
        if (Number.isFinite(Number(wsPrice)) && wsPrice > 0) {
          price = Number(wsPrice);
        }
      }

      // Priority 2: Fallback to ExchangeService (REST API) if WebSocket has no price
      if (!price || !Number.isFinite(price)) {
      const exchangeService = this.exchangeServices.get(exchange);
        if (exchangeService) {
          try {
            price = await exchangeService.getTickerPrice(symbol);
          } catch (e) {
            logger.debug(`[PriceAlertScanner] ExchangeService.getTickerPrice failed for ${exchange} ${symbol}: ${e?.message || e}`);
          }
        }
      }

      // Cache the price (even if null, to avoid excessive calls)
      if (Number.isFinite(Number(price)) && price > 0) {
      this.priceCache.set(cacheKey, price);
      this.priceCacheTime.set(cacheKey, now);
      return price;
      }

      // Return cached price if available (even if expired, better than null)
      const cachedPrice = this.priceCache.get(cacheKey);
      if (Number.isFinite(Number(cachedPrice)) && cachedPrice > 0) {
        return cachedPrice;
      }

      return null;
    } catch (error) {
      logger.warn(`[PriceAlertScanner] Failed to get price for ${symbol} on ${exchange}:`, error.message);
      // Return cached price as fallback
      const cacheKey = `${exchange}_${symbol}`;
      const cachedPrice = this.priceCache.get(cacheKey);
      if (Number.isFinite(Number(cachedPrice)) && cachedPrice > 0) {
        return cachedPrice;
      }
      return null;
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
      } catch (error) {
        logger.error(`[PriceAlertScanner] ❌ Failed to send alert to chat_id=${telegramChatId}:`, error?.message || error);
      }
    } catch (error) {
      logger.error(`Failed to send price alert for ${symbol}:`, error);
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

