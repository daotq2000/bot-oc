import { PriceAlertScanner } from '../jobs/PriceAlertScanner.js';
import { OcAlertScanner } from '../jobs/OcAlertScanner.js';
import { priceAlertSymbolTracker } from '../services/PriceAlertSymbolTracker.js';
import { mexcPriceWs } from '../services/MexcWebSocketManager.js';
import { webSocketManager } from '../services/WebSocketManager.js';
import { configService } from '../services/ConfigService.js';
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
    this.ocAlertScanner = null;
    this.isRunning = false;
    this.refreshInterval = null;
    this.subscriptionInterval = null;
    this.lastSubscriptionTime = 0;
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

      // Initialize Price Alert Scanner
      this.priceAlertScanner = new PriceAlertScanner();
      await this.priceAlertScanner.initialize(telegramService);

      // Initialize OC Alert Scanner
      this.ocAlertScanner = new OcAlertScanner();
      await this.ocAlertScanner.initialize(telegramService);

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
  start() {
    if (this.isRunning) {
      logger.warn('[PriceAlertWorker] Already running');
      return;
    }

    // Check master ENABLE_ALERTS switch
    const alertsEnabled = configService.getBoolean('ENABLE_ALERTS', true);
    if (!alertsEnabled) {
      logger.info('[PriceAlertWorker] ENABLE_ALERTS=false, Price Alert Worker will not start');
      return;
    }

    try {
      this.isRunning = true;

      // Start Price Alert Scanner
      if (this.priceAlertScanner) {
        this.priceAlertScanner.start();
      }

      // Start OC Alert Scanner
      if (this.ocAlertScanner) {
        this.ocAlertScanner.start();
      }

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

      // Stop scanners
      if (this.priceAlertScanner) {
        this.priceAlertScanner.stop();
      }
      if (this.ocAlertScanner) {
        this.ocAlertScanner.stop();
      }

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
          mexcPriceWs.subscribe(mexcSymbols);
          // Ensure WebSocket is connected (subscribe() calls ensureConnected(), but verify after a delay)
          setTimeout(() => {
            if (mexcPriceWs.ws?.readyState !== 1) {
              logger.warn(`[PriceAlertWorker] MEXC WebSocket not connected after subscribe, ensuring connection...`);
              mexcPriceWs.ensureConnected();
            } else {
              logger.debug(`[PriceAlertWorker] MEXC WebSocket connected successfully`);
            }
          }, 1000);
        } catch (error) {
          logger.error(`[PriceAlertWorker] Failed to subscribe MEXC symbols:`, error?.message || error);
        }
      } else {
        logger.debug(`[PriceAlertWorker] No MEXC symbols to subscribe`);
      }

      // Subscribe Binance symbols
      const binanceSymbols = Array.from(trackingSymbols.get('binance') || []);
      if (binanceSymbols.length > 0) {
        logger.info(`[PriceAlertWorker] Subscribing Binance WS to ${binanceSymbols.length} Price Alert symbols`);
        try {
          webSocketManager.subscribe(binanceSymbols);
          // Binance WebSocket should auto-connect via connect() call in app.js
          // But ensure it's connected
          const status = webSocketManager.getStatus();
          if (status.connectedCount === 0) {
            logger.warn(`[PriceAlertWorker] Binance WebSocket not connected, calling connect()...`);
            webSocketManager.connect();
          }
        } catch (error) {
          logger.error(`[PriceAlertWorker] Failed to subscribe Binance symbols:`, error?.message || error);
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
        isScanning: this.priceAlertScanner.isScanning
      } : null,
      ocAlertScanner: this.ocAlertScanner ? {
        isRunning: this.ocAlertScanner.isRunning
      } : null,
      trackingSymbols: {
        mexc: priceAlertSymbolTracker.getSymbolsForExchange('mexc').size,
        binance: priceAlertSymbolTracker.getSymbolsForExchange('binance').size
      }
    };
  }
}

