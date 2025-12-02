import cron from 'node-cron';
import { Bot } from '../models/Bot.js';
import { Strategy } from '../models/Strategy.js';
import { Position } from '../models/Position.js';
import { PriceAlertConfig } from '../models/PriceAlertConfig.js';
import { webSocketManager } from '../services/WebSocketManager.js';
import { ExchangeService } from '../services/ExchangeService.js';
import { CandleService } from '../services/CandleService.js';
import { StrategyService } from '../services/StrategyService.js';
import { OrderService } from '../services/OrderService.js';
import { TelegramService } from '../services/TelegramService.js';
import { DEFAULT_CRON_PATTERNS, SCAN_INTERVALS } from '../config/constants.js';
import logger from '../utils/logger.js';

/**
 * Signal Scanner Job - Scan strategies for trading signals
 */
export class SignalScanner {
  constructor() {
    this.exchangeServices = new Map(); // botId -> ExchangeService
    this.candleServices = new Map(); // botId -> CandleService
    this.strategyServices = new Map(); // botId -> StrategyService
    this.orderServices = new Map(); // botId -> OrderService
    this.telegramService = null;
    this.isRunning = false;
    this.scanInterval = null; // For setInterval
    this.strategiesCache = null; // Cache strategies list
    this.strategiesCacheTime = 0; // Cache timestamp
    this.alertConfigsCache = null; // Cache alert configs
    this.alertConfigsCacheTime = 0; // Cache timestamp
  }

  /**
   * Initialize services for all active bots
   */
  async initialize(telegramService) {
    this.telegramService = telegramService;

    try {
      const bots = await Bot.findAll(true); // Active bots only

      for (const bot of bots) {
        await this.addBot(bot);
      }
    } catch (error) {
      logger.error('Failed to initialize SignalScanner:', error);
    }
  }

  /**
   * Add bot to scanner
   * @param {Object} bot - Bot object
   */
  async addBot(bot) {
    try {
      const exchangeService = new ExchangeService(bot);
      await exchangeService.initialize();
      this.exchangeServices.set(bot.id, exchangeService);

      const candleService = new CandleService(exchangeService);
      this.candleServices.set(bot.id, candleService);

      const strategyService = new StrategyService(exchangeService, candleService, this.telegramService);
      this.strategyServices.set(bot.id, strategyService);

      const orderService = new OrderService(exchangeService, this.telegramService);
      this.orderServices.set(bot.id, orderService);

      logger.info(`SignalScanner initialized for bot ${bot.id}`);
    } catch (error) {
      logger.error(`Failed to initialize SignalScanner for bot ${bot.id}:`, error);
    }
  }

  /**
   * Remove bot from scanner
   * @param {number} botId - Bot ID
   */
  removeBot(botId) {
    this.exchangeServices.delete(botId);
    this.candleServices.delete(botId);
    this.strategyServices.delete(botId);
    this.orderServices.delete(botId);
    logger.info(`Removed bot ${botId} from SignalScanner`);
  }

  /**
   * Scan strategy for signal
   * @param {Object} strategy - Strategy object
   */
  async scanStrategy(strategy, alertConfig = null) {
    try {
      // Check if strategy already has open position
      const openPositions = await Position.findOpen(strategy.id);
      if (openPositions.length > 0) {
        logger.debug(`Strategy ${strategy.id} already has open position, skipping`);
        return;
      }

      // Get services for this bot
      const strategyService = this.strategyServices.get(strategy.bot_id);
      if (!strategyService) {
        logger.warn(`StrategyService not found for bot ${strategy.bot_id}`);
        return;
      }

      // Check for signal and/or alert
      const signal = await strategyService.checkSignal(strategy, alertConfig);

      if (signal) {
        logger.info(`Signal detected for strategy ${strategy.id}:`, {
          symbol: strategy.symbol,
          side: signal.side,
          entryPrice: signal.entryPrice
        });

        // Execute signal
        const orderService = this.orderServices.get(strategy.bot_id);
        if (orderService) {
          await orderService.executeSignal(signal);
        }
      }
    } catch (error) {
      logger.error(`Error scanning strategy ${strategy.id}:`, error);
    }
  }

  /**
   * Get cached strategies or fetch from database
   * @returns {Promise<Array>} Strategies array
   */
  async getStrategies() {
    const now = Date.now();
    const cacheTTL = SCAN_INTERVALS.STRATEGY_CACHE_TTL;

    // Return cached strategies if still valid
    if (this.strategiesCache && (now - this.strategiesCacheTime) < cacheTTL) {
      return this.strategiesCache;
    }

    // Fetch fresh strategies from database
    const strategies = await Strategy.findAll(null, true);
    this.strategiesCache = strategies;
    this.strategiesCacheTime = now;

    return strategies;
  }

  /**
   * Invalidate strategies cache (call when strategies are added/updated/deleted)
   */
  invalidateCache() {
    this.strategiesCache = null;
    this.strategiesCacheTime = 0;
    this.alertConfigsCache = null;
    this.alertConfigsCacheTime = 0;
  }

  /**
   * Get cached alert configs or fetch from database
   * @returns {Promise<Array>} Alert configs array
   */
  async getAlertConfigs() {
    const now = Date.now();
    const cacheTTL = SCAN_INTERVALS.STRATEGY_CACHE_TTL; // Reuse same TTL

    if (this.alertConfigsCache && (now - this.alertConfigsCacheTime) < cacheTTL) {
      return this.alertConfigsCache;
    }

    const configs = await PriceAlertConfig.findAll();
    this.alertConfigsCache = configs;
    this.alertConfigsCacheTime = now;

    return configs;
  }

  /**
   * Scan all active strategies
   */
  async scanAllStrategies() {
    if (this.isRunning) {
      logger.debug('SignalScanner already running, skipping...');
      return;
    }

    this.isRunning = true;

    try {
      // Fetch strategies and alert configs from cache/db
      const [strategies, alertConfigs] = await Promise.all([
        this.getStrategies(),
        this.getAlertConfigs()
      ]);

      // Create a lookup map for alert configs for efficient access
      const alertConfigMap = new Map();
      const allSymbols = new Set();

      for (const strategy of strategies) {
        allSymbols.add(strategy.symbol.toUpperCase());
      }

      for (const config of alertConfigs) {
        for (const symbol of config.symbols) {
          allSymbols.add(symbol.toUpperCase());
          for (const interval of config.intervals) {
            const key = `${symbol.toUpperCase()}:${interval}`;
            alertConfigMap.set(key, config);
          }
        }
      }

      // Update WebSocket subscriptions with all required symbols
      webSocketManager.subscribe(Array.from(allSymbols));

      logger.info(`[SignalScanner] Starting scan of ${strategies.length} active strategies and ${alertConfigs.length} alert configs.`);

      // Process strategies in batches
      const batchSize = 5;
      for (let i = 0; i < strategies.length; i += batchSize) {
        const batch = strategies.slice(i, i + batchSize);
        await Promise.allSettled(
          batch.map(strategy => {
            // Find a matching alert config for this strategy
            const alertKey = `${strategy.symbol.toUpperCase()}:${strategy.interval}`;
            const alertConfig = alertConfigMap.get(alertKey);
            return this.scanStrategy(strategy, alertConfig);
          })
        );

        if (i + batchSize < strategies.length) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      logger.info(`[SignalScanner] Completed scan.`);
    } catch (error) {
      logger.error('Error in scanAllStrategies:', error);
      this.invalidateCache();
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Start the scan job (using setInterval for higher frequency)
   */
  start() {
    const intervalMs = SCAN_INTERVALS.SIGNAL_SCAN;
    
    // Use setInterval for frequencies higher than 1 minute
    // Cron only supports minimum 1 minute intervals
    if (intervalMs < 60000) {
      // Use setInterval for sub-minute intervals
      this.scanInterval = setInterval(async () => {
        await this.scanAllStrategies();
      }, intervalMs);

      // Run immediately on start
      this.scanAllStrategies();

      logger.info(`SignalScanner started with interval: ${intervalMs}ms (${intervalMs / 1000}s)`);
    } else {
      // Use cron for intervals >= 1 minute
      const pattern = DEFAULT_CRON_PATTERNS.SIGNAL_SCAN;
      cron.schedule(pattern, async () => {
        await this.scanAllStrategies();
      });
      logger.info(`SignalScanner started with pattern: ${pattern}`);
    }
  }

  /**
   * Stop the scan job
   */
  stop() {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    logger.info('SignalScanner stopped');
  }
}

