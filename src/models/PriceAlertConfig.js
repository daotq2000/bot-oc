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
      
      for (const exchange of exchanges) {
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

    // Check each symbol
    for (const symbol of symbolsToScan) {
      try {
        await this.checkSymbolPrice(
          exchange,
          symbol,
          threshold,
          telegram_chat_id,
          id
        );
      } catch (error) {
        logger.warn(`Error checking price for ${symbol} on ${exchange}:`, error.message);
      }
    }
  }

  /**
   * Check price for a specific symbol
   */
  async checkSymbolPrice(exchange, symbol, threshold, telegramChatId, configId) {
    try {
      const exchangeService = this.exchangeServices.get(exchange);
      if (!exchangeService) {
        return;
      }

      // Get current price
      const currentPrice = await this.getPrice(exchange, symbol);
      if (!currentPrice) {
        return;
      }

      // Initialize alert state if not exists
      const stateKey = `${exchange}_${symbol}`;
      if (!this.alertStates.has(stateKey)) {
        this.alertStates.set(stateKey, {
          lastPrice: currentPrice,
          lastAlertTime: 0,
          triggered: false
        });
        return; // Skip first check
      }

      const state = this.alertStates.get(stateKey);
      const lastPrice = state.lastPrice;
      const priceChange = Math.abs((currentPrice - lastPrice) / lastPrice * 100);

      // Check if price change exceeds threshold
      if (priceChange >= threshold) {
        const now = Date.now();
        const timeSinceLastAlert = now - state.lastAlertTime;
        const minAlertInterval = 60000; // Minimum 1 minute between alerts

        if (timeSinceLastAlert >= minAlertInterval) {
          // Send alert
          await this.sendPriceAlert(
            exchange,
            symbol,
            lastPrice,
            currentPrice,
            priceChange,
            telegramChatId,
            configId
          );

          state.lastAlertTime = now;
          state.triggered = true;
        }
      }

      // Update state
      state.lastPrice = currentPrice;
    } catch (error) {
      logger.warn(`Error checking symbol price ${symbol} on ${exchange}:`, error.message);
    }
  }

  /**
   * Get price for a symbol (with caching)
   */
  async getPrice(exchange, symbol) {
    try {
      const cacheKey = `${exchange}_${symbol}`;
      const now = Date.now();
      const cacheTime = this.priceCacheTime.get(cacheKey) || 0;
      const cacheDuration = 2000; // 2 seconds cache

      // Return cached price if still valid
      if (now - cacheTime < cacheDuration) {
        return this.priceCache.get(cacheKey);
      }

      // Fetch fresh price
      const exchangeService = this.exchangeServices.get(exchange);
      if (!exchangeService) {
        return null;
      }

      const price = await exchangeService.getTickerPrice(symbol);
      
      // Cache the price
      this.priceCache.set(cacheKey, price);
      this.priceCacheTime.set(cacheKey, now);

      return price;
    } catch (error) {
      logger.warn(`Failed to get price for ${symbol} on ${exchange}:`, error.message);
      return null;
    }
  }

  /**
   * Send price alert via Telegram
   */
  async sendPriceAlert(exchange, symbol, oldPrice, newPrice, changePercent, telegramChatId, configId) {
    try {
      if (!this.telegramService || !telegramChatId) return;

      const bullish = Number(newPrice) >= Number(oldPrice);
      const direction = bullish ? 'bullish' : 'bearish';

      // Use compact line format via TelegramService
      logger.info(`[PriceAlertScanner] Sending alert for ${exchange.toUpperCase()} ${symbol} (change: ${changePercent.toFixed(2)}%) to chat_id=${telegramChatId} (config_id=${configId})`);
      await this.telegramService.sendVolatilityAlert(telegramChatId, {
        symbol,
        interval: '1m', // default interval for standalone alerts
        oc: changePercent * (bullish ? 1 : -1), // signed percent
        open: oldPrice,
        currentPrice: newPrice,
        direction
      }).catch((error) => {
        logger.error(`[PriceAlertScanner] Failed to send alert to chat_id=${telegramChatId}:`, error?.message || error);
      });

      logger.info(`[PriceAlertScanner] ✅ Alert sent: ${exchange.toUpperCase()} ${symbol} (change: ${changePercent.toFixed(2)}%) to chat_id=${telegramChatId}`);
    } catch (error) {
      logger.error(`Failed to send price alert for ${symbol}:`, error);
    }
  }
}

