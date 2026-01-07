import { Strategy } from '../models/Strategy.js';
import { Bot } from '../models/Bot.js';
import { PositionMonitor } from '../jobs/PositionMonitor.js';
import { EntryOrderMonitor } from '../jobs/EntryOrderMonitor.js';
import { BalanceManager } from '../jobs/BalanceManager.js';
import { ExchangeService } from '../services/ExchangeService.js';
import { OrderService } from '../services/OrderService.js';
import { webSocketOCConsumer } from '../consumers/WebSocketOCConsumer.js';
import { strategyCache } from '../services/StrategyCache.js';
import { configService } from '../services/ConfigService.js';
// Concurrency management removed
import logger from '../utils/logger.js';

/**
 * StrategiesWorker
 * 
 * Worker riêng biệt cho Strategies system:
 * - Chỉ chạy khi có active strategies
 * - Tách biệt hoàn toàn với Price Alert
 * - Có error boundary riêng để không ảnh hưởng đến Price Alert
 * - Quản lý WebSocket subscriptions cho Strategy symbols
 */
export class StrategiesWorker {
  constructor() {
    this.telegramService = null;
    this.positionMonitor = null;
    this.balanceManager = null;
    this.orderServices = new Map(); // botId -> OrderService
    this.isRunning = false;
    this.checkInterval = null;
    this.lastSubscriptionTime = 0;
    this.strategySymbols = new Map(); // exchange -> Set<symbol>
  }

  /**
   * Initialize Strategies Worker
   * @param {TelegramService} telegramService - Telegram service instance
   */
  async initialize(telegramService) {
    try {
      this.telegramService = telegramService;

      logger.info('[StrategiesWorker] Initializing Strategies system (Realtime WebSocket)...');

      // Initialize OrderServices from active bots
      await this.initializeOrderServices(telegramService);
      
      // Small delay to reduce CPU load
      await new Promise(resolve => setTimeout(resolve, 500));

      // Initialize Position Monitor (confirmed positions)
      this.positionMonitor = new PositionMonitor();
      await this.positionMonitor.initialize(telegramService);
      this.positionMonitor.start();
      
      // Small delay to reduce CPU load
      await new Promise(resolve => setTimeout(resolve, 500));

      // Initialize Entry Order Monitor (pending LIMIT orders, user-data WS + REST fallback)
      this.entryOrderMonitor = new EntryOrderMonitor();
      await this.entryOrderMonitor.initialize(telegramService);
      this.entryOrderMonitor.start();
      
      // Small delay to reduce CPU load
      await new Promise(resolve => setTimeout(resolve, 500));

      // Initialize Balance Manager
      this.balanceManager = new BalanceManager();
      await this.balanceManager.initialize(telegramService);
      this.balanceManager.start();
      
      // Small delay to reduce CPU load
      await new Promise(resolve => setTimeout(resolve, 500));

      // Initialize WebSocket OC Consumer (realtime detection)
      // Note: OrderServices will be populated in initializeOrderServices()
      // We'll update it after initialization
      await webSocketOCConsumer.initialize(this.orderServices);
      
      // Update OrderServices reference after initialization
      webSocketOCConsumer.orderServices = this.orderServices;
      
      // Small delay before checking strategies
      await new Promise(resolve => setTimeout(resolve, 500));

      // Check for active strategies
      await this.checkAndSubscribe();

      // Setup periodic check for active strategies and cache refresh
      const checkInterval = configService.getNumber('STRATEGIES_CHECK_INTERVAL_MS', 30000);
      this.checkInterval = setInterval(() => {
        this.checkAndSubscribe().catch(error => {
          logger.error('[StrategiesWorker] Failed to check strategies:', { message: error?.message, stack: error?.stack });
        });
      }, checkInterval);

      // Update WebSocketOCConsumer with OrderServices after all bots are initialized
      webSocketOCConsumer.orderServices = this.orderServices;
      logger.info(`[StrategiesWorker] Updated WebSocketOCConsumer with ${this.orderServices.size} OrderServices`);

      logger.info('[StrategiesWorker] ✅ Strategies system initialized successfully');
    } catch (error) {
      logger.error('[StrategiesWorker] ❌ Failed to initialize Strategies system:', error?.message || error);
      // Don't throw - Strategies failure should not affect Price Alert
    }
  }

  /**
   * Check for active strategies and start/stop accordingly
   */
  async checkAndSubscribe() {
    try {
      const strategies = await Strategy.findAll(null, true);
      const hasActiveStrategies = Array.isArray(strategies) && strategies.length > 0;

      if (hasActiveStrategies) {
        // Refresh strategy cache
        await strategyCache.refresh();

        // Ensure all bots with active strategies have OrderServices
        await this.ensureOrderServicesForStrategies(strategies);

        // Collect symbols from strategies
        this.collectStrategySymbols(strategies);

        // Start if not running
        if (!this.isRunning) {
          this.start();
        }

        // WebSocket subscriptions are handled by WebSocketOCConsumer
        await webSocketOCConsumer.subscribeWebSockets();
      } else {
        // Stop if no active strategies
        if (this.isRunning) {
          logger.info('[StrategiesWorker] No active strategies, stopping...');
          this.stop();
        }
      }
    } catch (error) {
      logger.error('[StrategiesWorker] Error checking strategies:', { message: error?.message, stack: error?.stack });
    }
  }

  /**
   * Ensure all bots with active strategies have OrderServices initialized
   * @param {Array} strategies - Array of active strategies
   */
  async ensureOrderServicesForStrategies(strategies) {
    try {
      // Get unique bot IDs from strategies
      const botIdsFromStrategies = new Set();
      for (const strategy of strategies) {
        if (strategy.bot_id) {
          botIdsFromStrategies.add(Number(strategy.bot_id));
        }
      }

      // Check which bots are missing OrderServices
      const missingBotIds = [];
      for (const botId of botIdsFromStrategies) {
        if (!this.orderServices.has(botId)) {
          missingBotIds.push(botId);
        }
      }

      if (missingBotIds.length === 0) {
        return; // All bots already have OrderServices
      }

      logger.info(`[StrategiesWorker] Found ${missingBotIds.length} bot(s) with strategies but no OrderService: ${missingBotIds.join(', ')}`);

      // Initialize OrderServices for missing bots
      for (const botId of missingBotIds) {
        try {
          const bot = await Bot.findById(botId);
          if (!bot) {
            logger.warn(`[StrategiesWorker] Bot ${botId} not found in database, skipping`);
            continue;
          }

          // Check if bot is active (if not, we might still want to initialize if it has strategies)
          // But for safety, only initialize if bot is active
          if (!bot.is_active && bot.is_active !== 1) {
            logger.warn(`[StrategiesWorker] Bot ${botId} is not active, skipping OrderService initialization`);
            continue;
          }

          const exchangeService = new ExchangeService(bot);
          await exchangeService.initialize();

          const orderService = new OrderService(exchangeService, this.telegramService);
          this.orderServices.set(bot.id, orderService);

          // Initialize concurrency manager for this bot
          const maxConcurrentTrades = bot.max_concurrent_trades || 5;
          // concurrencyManager.initializeBot(bot.id, maxConcurrentTrades); // Disabled

          logger.info(`[StrategiesWorker] ✅ Initialized OrderService for bot ${bot.id} (${bot.exchange}, max_concurrent_trades=${maxConcurrentTrades})`);
        } catch (error) {
          logger.error(`[StrategiesWorker] ❌ Failed to initialize OrderService for bot ${botId}:`, error?.message || error);
          // Continue with other bots
        }
      }

      // Update WebSocketOCConsumer with all OrderServices
      if (missingBotIds.length > 0) {
        webSocketOCConsumer.orderServices = this.orderServices;
        logger.info(`[StrategiesWorker] Updated WebSocketOCConsumer with ${this.orderServices.size} OrderServices (added ${missingBotIds.length} new ones)`);
      }
    } catch (error) {
      logger.error('[StrategiesWorker] Error ensuring OrderServices:', error?.message || error);
    }
  }

  /**
   * Collect symbols from strategies
   * @param {Array} strategies - Array of strategy objects
   */
  collectStrategySymbols(strategies) {
    const mexcSymbols = new Set();
    const binanceSymbols = new Set();

    for (const strategy of strategies) {
      const exchange = (strategy.exchange || '').toLowerCase();
      const symbol = this.normalizeSymbol(strategy.symbol);

      if (!symbol) continue;

      if (exchange === 'mexc') {
        mexcSymbols.add(symbol);
      } else if (exchange === 'binance') {
        binanceSymbols.add(symbol);
      }
    }

    this.strategySymbols.set('mexc', mexcSymbols);
    this.strategySymbols.set('binance', binanceSymbols);

    logger.debug(`[StrategiesWorker] Collected symbols: MEXC=${mexcSymbols.size}, Binance=${binanceSymbols.size}`);
  }

  /**
   * Normalize symbol format
   * @param {string} symbol - Symbol to normalize
   * @returns {string} Normalized symbol
   */
  normalizeSymbol(symbol) {
    if (!symbol) return null;
    return String(symbol).toUpperCase().replace(/[\/:_]/g, '');
  }

  /**
   * Initialize OrderServices from active bots
   * @param {TelegramService} telegramService - Telegram service
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

          // Initialize concurrency manager for this bot
          const maxConcurrentTrades = bot.max_concurrent_trades || 5;
          // concurrencyManager.initializeBot(bot.id, maxConcurrentTrades); // Disabled

          logger.info(`[StrategiesWorker] ✅ Initialized OrderService for bot ${bot.id} (${bot.exchange}, max_concurrent_trades=${maxConcurrentTrades})`);
          
          // Add delay between bot initializations to avoid CPU spike
          if (i < bots.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 800)); // 800ms delay between bots
          }
        } catch (error) {
          logger.error(`[StrategiesWorker] ❌ Failed to initialize OrderService for bot ${bot.id}:`, error?.message || error);
          // Continue with other bots
        }
      }

      logger.info(`[StrategiesWorker] Initialized ${this.orderServices.size} OrderServices`);
    } catch (error) {
      logger.error('[StrategiesWorker] Failed to initialize OrderServices:', error?.message || error);
    }
  }

  /**
   * Add OrderService for a bot
   * @param {number} botId - Bot ID
   * @param {OrderService} orderService - OrderService instance
   */
  addOrderService(botId, orderService) {
    this.orderServices.set(botId, orderService);
    // Update WebSocketOCConsumer with new OrderService
    webSocketOCConsumer.orderServices = this.orderServices;
    logger.debug(`[StrategiesWorker] Added OrderService for bot ${botId}`);
  }

  /**
   * Start Strategies Worker
   */
  start() {
    if (this.isRunning) {
      logger.warn('[StrategiesWorker] Already running');
      return;
    }

    try {
      this.isRunning = true;

      // Start WebSocket OC Consumer (realtime detection)
      webSocketOCConsumer.start();

      logger.info('[StrategiesWorker] ✅ Strategies system started (Realtime WebSocket)');
    } catch (error) {
      logger.error('[StrategiesWorker] ❌ Failed to start Strategies system:', error?.message || error);
      // Don't throw - try to continue
    }
  }

  /**
   * Stop Strategies Worker
   */
  stop() {
    if (!this.isRunning) return;

    try {
      this.isRunning = false;

      // Stop WebSocket OC Consumer
      webSocketOCConsumer.stop();

      logger.info('[StrategiesWorker] ✅ Strategies system stopped');
    } catch (error) {
      logger.error('[StrategiesWorker] ❌ Error stopping Strategies system:', error?.message || error);
    }
  }

  /**
   * Get status of Strategies Worker
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      hasActiveStrategies: this.strategySymbols.size > 0,
      strategySymbols: {
        mexc: this.strategySymbols.get('mexc')?.size || 0,
        binance: this.strategySymbols.get('binance')?.size || 0
      },
      webSocketOCConsumer: webSocketOCConsumer.getStats()
    };
  }
}

