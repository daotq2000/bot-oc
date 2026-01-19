import { PriceAlertScanner } from '../jobs/PriceAlertScanner.js';
import { realtimeOCDetector } from '../services/RealtimeOCDetector.js';
import { alertMode } from '../services/AlertMode.js';
import { priceAlertSymbolTracker } from '../services/PriceAlertSymbolTracker.js';
import { mexcPriceWs } from '../services/MexcWebSocketManager.js';
import { webSocketManager } from '../services/WebSocketManager.js';
import { configService } from '../services/ConfigService.js';
import { Bot } from '../models/Bot.js';
import { ExchangeService } from '../services/ExchangeService.js';
import { OrderService } from '../services/OrderService.js';
import logger from '../utils/logger.js';

/**
 * PriceAlertWorker
 * 
 * Worker riêng biệt cho Price Alert system:
 * - Luôn chạy (always-on)
 * - Không phụ thuộc vào Strategies
 * - Có error boundary riêng để đảm bảo không bị crash
 * - Quản lý WebSocket subscriptions cho Price Alert symbols
 */
export class PriceAlertWorker {
  constructor() {
    this.telegramService = null;
    this.priceAlertScanner = null;
    this.orderServices = new Map(); // botId -> OrderService
    this.isRunning = false;
    this.refreshInterval = null;
    this.subscriptionInterval = null;
    this.lastSubscriptionTime = 0;
  }

  /**
   * Initialize OrderServices from active bots
   * @param {TelegramService} telegramService - Telegram service instance
   */
  async initializeOrderServices(telegramService) {
    try {
      const bots = await Bot.findAll(true); // Active bots only

      // Initialize bots sequentially with delay to reduce CPU load
      for (let i = 0; i < bots.length; i++) {
        const bot = bots[i];
        try {
          const exchangeService = new ExchangeService(bot);
          await exchangeService.initialize();

          const orderService = new OrderService(exchangeService, telegramService);
          this.orderServices.set(bot.id, orderService);

          logger.info(`[PriceAlertWorker] ✅ Initialized OrderService for bot ${bot.id} (${bot.exchange}, max_concurrent_trades=${bot.max_concurrent_trades || 5})`);
          
          // Add delay between bot initializations to avoid CPU spike
          if (i < bots.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay between bots
          }
        } catch (error) {
          logger.error(`[PriceAlertWorker] ❌ Failed to initialize OrderService for bot ${bot.id}:`, error?.message || error);
          // Continue with other bots
        }
      }

      logger.info(`[PriceAlertWorker] Initialized ${this.orderServices.size} OrderServices`);
    } catch (error) {
      logger.error('[PriceAlertWorker] Failed to initialize OrderServices:', error?.message || error);
    }
  }

  /**
   * Initialize Price Alert Worker
   * @param {TelegramService} telegramService - Telegram service instance
   */
  async initialize(telegramService) {
    try {
      this.telegramService = telegramService;

      logger.info('[PriceAlertWorker] Initializing Price Alert system...');

      // Initialize symbol tracker
      await priceAlertSymbolTracker.refresh();
      
      // Small delay to reduce CPU load
      await new Promise(resolve => setTimeout(resolve, 300));

      logger.info(`[PriceAlertWorker] Alert mode: scanner=${alertMode.useScanner()} websocket=${alertMode.useWebSocket()}`);

      // Initialize OrderServices for PriceAlertScanner (nếu cần order execution)
      if (alertMode.useScanner()) {
        await this.initializeOrderServices(telegramService);
        logger.info(`[PriceAlertWorker] ✅ Initialized ${this.orderServices.size} OrderServices for PriceAlertScanner`);
      }

      // Initialize PriceAlertScanner (polling) if enabled
      if (alertMode.useScanner()) {
        this.priceAlertScanner = new PriceAlertScanner();
        // ✅ Pass orderServices để enable order execution
        await this.priceAlertScanner.initialize(telegramService, this.orderServices);
        logger.info('[PriceAlertWorker] ✅ PriceAlertScanner enabled with order execution');
      } else {
        this.priceAlertScanner = null;
        logger.info('[PriceAlertWorker] PriceAlertScanner disabled');
      }

      // ✅ Chỉ initialize RealtimeOCDetector nếu useWebSocket() = true
      if (alertMode.useWebSocket()) {
        await realtimeOCDetector.initializeAlerts(telegramService);
        await realtimeOCDetector.refreshAlertWatchlist();
        logger.info('[PriceAlertWorker] ✅ RealtimeOCDetector initialized and watchlist refreshed.');
      } else {
        logger.info('[PriceAlertWorker] RealtimeOCDetector disabled (useWebSocket=false)');
      }

      // Small delay before WebSocket subscriptions
      await new Promise(resolve => setTimeout(resolve, 500));

      // Subscribe WebSocket for tracked symbols
      await this.subscribeWebSockets();

      // Setup periodic refresh of tracking symbols
      const refreshInterval = configService.getNumber('PRICE_ALERT_SYMBOL_REFRESH_INTERVAL_MS', 30000);
      this.refreshInterval = setInterval(() => {
        this.refreshSymbols().catch(error => {
          logger.error('[PriceAlertWorker] Failed to refresh symbols:', error?.message || error);
        });
      }, refreshInterval);

      // Setup periodic WebSocket subscription update
      const subscriptionInterval = configService.getNumber('PRICE_ALERT_WS_SUBSCRIBE_INTERVAL_MS', 60000);
      this.subscriptionInterval = setInterval(() => {
        this.subscribeWebSockets().catch(error => {
          logger.error('[PriceAlertWorker] Failed to subscribe WebSockets:', error?.message || error);
        });
      }, subscriptionInterval);

      logger.info('[PriceAlertWorker] ✅ Price Alert system initialized successfully');
    } catch (error) {
      logger.error('[PriceAlertWorker] ❌ Failed to initialize Price Alert system:', error?.message || error);
      // Don't throw - Price Alert should continue even if initialization has issues
    }
  }

  /**
   * Start Price Alert Worker
   */
  async start() {
    if (this.isRunning) {
      logger.warn('[PriceAlertWorker] Already running');
      return;
    }

    // Check master ENABLE_ALERTS switch
    const alertsEnabled = configService.getBoolean('ENABLE_ALERTS', true);
    logger.info(`[PriceAlertWorker] ENABLE_ALERTS=${alertsEnabled}`);
    if (!alertsEnabled) {
      logger.info('[PriceAlertWorker] ENABLE_ALERTS=false, Price Alert Worker will not start');
      return;
    }

    try {
      this.isRunning = true;

      const scannerEnabled = alertMode.useScanner();
      const websocketEnabled = alertMode.useWebSocket();
      logger.info(`[PriceAlertWorker] Starting... mode: scanner=${scannerEnabled} websocket=${websocketEnabled}`);

      // Start PriceAlertScanner (polling) if enabled
      if (scannerEnabled) {
        if (!this.priceAlertScanner) {
          // Defensive: initialize scanner lazily if not present
          logger.warn('[PriceAlertWorker] Scanner mode enabled but priceAlertScanner is null. Creating a new instance...');
          this.priceAlertScanner = new PriceAlertScanner();
          // NOTE: initialize() should normally run before start(). If it didn't, scanner will run with limited functionality.
          // We still start it to ensure alerts are not silently dead.
          try {
            if (this.telegramService) {
              await this.priceAlertScanner.initialize(this.telegramService, this.orderServices);
              logger.info('[PriceAlertWorker] ✅ Lazily initialized PriceAlertScanner in start()');
            } else {
              logger.warn('[PriceAlertWorker] telegramService is null; starting scanner without initialization');
            }
          } catch (e) {
            logger.error('[PriceAlertWorker] ❌ Failed to lazily initialize PriceAlertScanner:', e?.message || e);
          }
        }

        try {
          logger.info('[PriceAlertWorker] Starting PriceAlertScanner...');
          this.priceAlertScanner.start();
          logger.info(`[PriceAlertWorker] ✅ PriceAlertScanner.start() called (scanner.isRunning=${this.priceAlertScanner.isRunning})`);
          
          // ✅ NEW: Verify scanner is actually running
          if (!this.priceAlertScanner.isRunning) {
            logger.error('[PriceAlertWorker] ❌ PriceAlertScanner.start() was called but scanner.isRunning is still false!');
          } else {
            logger.info('[PriceAlertWorker] ✅ PriceAlertScanner is confirmed running');
          }
        } catch (e) {
          logger.error('[PriceAlertWorker] ❌ PriceAlertScanner.start() failed:', e?.message || e, e?.stack);
        }
      } else {
        logger.info('[PriceAlertWorker] Scanner mode disabled; not starting PriceAlertScanner');
      }

      // WebSocket alerts are event-driven; no scan loop needed.
      logger.info('[PriceAlertWorker] ✅ Price Alert system started');
    } catch (error) {
      logger.error('[PriceAlertWorker] ❌ Failed to start Price Alert system:', error?.message || error);
      // Don't throw - try to continue
    }
  }

  /**
   * Stop Price Alert Worker
   */
  stop() {
    if (!this.isRunning) return;

    try {
      this.isRunning = false;

      // Clear intervals
      if (this.refreshInterval) {
        clearInterval(this.refreshInterval);
        this.refreshInterval = null;
      }
      if (this.subscriptionInterval) {
        clearInterval(this.subscriptionInterval);
        this.subscriptionInterval = null;
      }

      // Stop PriceAlertScanner (polling) if running
      if (this.priceAlertScanner) {
        this.priceAlertScanner.stop();
      }

      // WebSocket alerts are event-driven; nothing to stop here.


      logger.info('[PriceAlertWorker] ✅ Price Alert system stopped');
    } catch (error) {
      logger.error('[PriceAlertWorker] ❌ Error stopping Price Alert system:', error?.message || error);
    }
  }

  /**
   * Refresh tracking symbols
   */
  async refreshSymbols() {
    try {
      await priceAlertSymbolTracker.refresh();
      // Update WebSocket subscriptions after refresh
      await this.subscribeWebSockets();
    } catch (error) {
      logger.error('[PriceAlertWorker] Error refreshing symbols:', error?.message || error);
    }
  }

  /**
   * Subscribe WebSocket for tracked symbols
   */
  async subscribeWebSockets() {
    try {
      const now = Date.now();
      // Throttle: only subscribe every 10 seconds
      if (now - this.lastSubscriptionTime < 10000) {
        return;
      }
      this.lastSubscriptionTime = now;

      const trackingSymbols = await priceAlertSymbolTracker.refresh();
      
      // Subscribe MEXC symbols
      const mexcSymbols = Array.from(trackingSymbols.get('mexc') || []);
      if (mexcSymbols.length > 0) {
        logger.info(`[PriceAlertWorker] Subscribing MEXC WS to ${mexcSymbols.length} Price Alert symbols`);
        try {
          // CRITICAL FIX: Ensure WebSocket is connected before subscribing
          // Retry connection up to 3 times with exponential backoff
          let mexcStatus = mexcPriceWs.getStatus();
          if (!mexcStatus?.connected) {
            logger.warn(`[PriceAlertWorker] ⚠️ MEXC WebSocket not connected (state: ${mexcStatus?.readyState}), attempting to connect...`);
            mexcPriceWs.ensureConnected();
            
            // Wait for connection with retry (max 3 attempts, 2s each)
            let connected = false;
            for (let attempt = 0; attempt < 3; attempt++) {
              await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1))); // 2s, 4s, 6s
              mexcStatus = mexcPriceWs.getStatus();
              if (mexcStatus?.connected) {
                connected = true;
                logger.info(`[PriceAlertWorker] ✅ MEXC WebSocket connected after ${attempt + 1} attempt(s)`);
                break;
              }
            }
            
            if (!connected) {
              logger.error(`[PriceAlertWorker] ❌ MEXC WebSocket failed to connect after 3 attempts. Status: ${JSON.stringify(mexcStatus)}`);
              // Continue anyway - subscription will be retried on next cycle
            }
          } else {
            logger.debug(`[PriceAlertWorker] ✅ MEXC WebSocket already connected`);
          }
          
          // Subscribe symbols (only if connected)
          mexcStatus = mexcPriceWs.getStatus();
          if (mexcStatus?.connected) {
            mexcPriceWs.subscribe(mexcSymbols);
            logger.info(`[PriceAlertWorker] ✅ MEXC WebSocket subscribed to ${mexcSymbols.length} symbols`);
          } else {
            logger.warn(`[PriceAlertWorker] ⚠️ Cannot subscribe MEXC symbols: WebSocket not connected (state: ${mexcStatus?.readyState})`);
          }
        } catch (error) {
          logger.error(`[PriceAlertWorker] ❌ Failed to subscribe MEXC symbols:`, error?.message || error, error?.stack);
        }
      } else {
        logger.debug(`[PriceAlertWorker] No MEXC symbols to subscribe`);
      }

      // Subscribe Binance symbols
      const binanceSymbols = Array.from(trackingSymbols.get('binance') || []);
      if (binanceSymbols.length > 0) {
        logger.info(`[PriceAlertWorker] Subscribing Binance WS to ${binanceSymbols.length} Price Alert symbols`);
        try {
          // CRITICAL FIX: Ensure WebSocket is connected before subscribing
          // Retry connection up to 3 times with exponential backoff
          let binanceStatus = webSocketManager.getStatus();
          if (binanceStatus.connectedCount === 0) {
            logger.warn(`[PriceAlertWorker] ⚠️ Binance WebSocket not connected (connectedCount: ${binanceStatus.connectedCount}), attempting to connect...`);
            webSocketManager.connect();
            
            // Wait for connection with retry (max 3 attempts, 2s each)
            let connected = false;
            for (let attempt = 0; attempt < 3; attempt++) {
              await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1))); // 2s, 4s, 6s
              binanceStatus = webSocketManager.getStatus();
              if (binanceStatus.connectedCount > 0) {
                connected = true;
                logger.info(`[PriceAlertWorker] ✅ Binance WebSocket connected after ${attempt + 1} attempt(s) (${binanceStatus.connectedCount} streams)`);
                break;
              }
            }
            
            if (!connected) {
              logger.error(`[PriceAlertWorker] ❌ Binance WebSocket failed to connect after 3 attempts. Status: ${JSON.stringify(binanceStatus)}`);
              // Continue anyway - subscription will be retried on next cycle
            }
          } else {
            logger.debug(`[PriceAlertWorker] ✅ Binance WebSocket already connected (${binanceStatus.connectedCount} streams)`);
          }
          
          // Subscribe symbols (only if connected)
          binanceStatus = webSocketManager.getStatus();
          if (binanceStatus.connectedCount > 0) {
            webSocketManager.subscribe(binanceSymbols);
            logger.info(`[PriceAlertWorker] ✅ Binance WebSocket subscribed to ${binanceSymbols.length} symbols`);
          } else {
            logger.warn(`[PriceAlertWorker] ⚠️ Cannot subscribe Binance symbols: WebSocket not connected (connectedCount: ${binanceStatus.connectedCount})`);
          }
        } catch (error) {
          logger.error(`[PriceAlertWorker] ❌ Failed to subscribe Binance symbols:`, error?.message || error, error?.stack);
        }
      } else {
        logger.debug(`[PriceAlertWorker] No Binance symbols to subscribe`);
      }

      logger.info(`[PriceAlertWorker] WebSocket subscriptions updated: MEXC=${mexcSymbols.length}, Binance=${binanceSymbols.length}`);
    } catch (error) {
      logger.error('[PriceAlertWorker] Error subscribing WebSockets:', error?.message || error);
    }
  }

  /**
   * Get status of Price Alert Worker
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      priceAlertScanner: this.priceAlertScanner ? {
        isRunning: this.priceAlertScanner.isRunning,
        isScanning: this.priceAlertScanner.isScanning,
        orderServicesCount: this.orderServices.size
      } : null,
      ocAlertEnabled: alertMode.useWebSocket() ? realtimeOCDetector.alertEnabled : false,
      ocAlertScanRunning: false,
      orderServicesCount: this.orderServices.size,
      trackingSymbols: {
        mexc: priceAlertSymbolTracker.getSymbolsForExchange('mexc').size,
        binance: priceAlertSymbolTracker.getSymbolsForExchange('binance').size
      }
    };
  }
}

