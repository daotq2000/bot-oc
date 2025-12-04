import cron from 'node-cron';
import { Bot } from '../models/Bot.js';
import { Strategy } from '../models/Strategy.js';
import { ExchangeService } from '../services/ExchangeService.js';
import { CandleService } from '../services/CandleService.js';
import { DEFAULT_CRON_PATTERNS } from '../config/constants.js';
import { configService } from '../services/ConfigService.js';
import logger from '../utils/logger.js';

/**
 * Candle Updater Job - Update candle data for all active strategies
 */
export class CandleUpdater {
  constructor() {
    this.exchangeServices = new Map(); // botId -> ExchangeService
    this.candleServices = new Map(); // botId -> CandleService
    this.isRunning = false;
    this.updateInterval = null; // For setInterval
  }

  /**
   * Initialize exchange services for all active bots
   */
  async initialize() {
    try {
      const bots = await Bot.findAll(true); // Active bots only

      for (const bot of bots) {
        try {
          const exchangeService = new ExchangeService(bot);
          await exchangeService.initialize();
          this.exchangeServices.set(bot.id, exchangeService);

          const candleService = new CandleService(exchangeService);
          this.candleServices.set(bot.id, candleService);

          logger.info(`CandleUpdater initialized for bot ${bot.id}`);
        } catch (error) {
          logger.error(`Failed to initialize CandleUpdater for bot ${bot.id}:`, error);
        }
      }
    } catch (error) {
      logger.error('Failed to initialize CandleUpdater:', error);
    }
  }

  /**
   * Update candles for a specific strategy
   * @param {Object} strategy - Strategy object
   */
  async updateCandlesForStrategy(strategy) {
    try {
      const candleService = this.candleServices.get(strategy.bot_id);
      if (!candleService) {
        logger.warn(`CandleService not found for bot ${strategy.bot_id}`);
        return;
      }

      await candleService.updateCandles(strategy.symbol, strategy.interval);
    } catch (error) {
      // Handle invalid symbol status gracefully - don't log as error
      if (error.message?.includes('Invalid symbol status') || 
          error.message?.includes('-1122') ||
          error.message?.includes('symbol status')) {
        logger.debug(`Strategy ${strategy.id} (${strategy.symbol}): Symbol is invalid or delisted, skipping`);
        return;
      }
      
      logger.error(`Failed to update candles for strategy ${strategy.id}:`, error);
    }
  }

  /**
   * Update all candles
   */
  async updateAllCandles() {
    if (this.isRunning) {
      logger.debug('CandleUpdater already running, skipping...');
      return;
    }

    this.isRunning = true;

    try {
      const strategies = await Strategy.findAll(null, true); // All active strategies

      // Group by bot_id and symbol+interval to avoid duplicate updates
      const updateKeys = new Set();
      const strategiesToUpdate = [];

      for (const strategy of strategies) {
        const key = `${strategy.bot_id}_${strategy.symbol}_${strategy.interval}`;
        if (!updateKeys.has(key)) {
          updateKeys.add(key);
          strategiesToUpdate.push(strategy);
        }
      }

      // Update candles sequentially to reduce database lock contention
      for (const strategy of strategiesToUpdate) {
        await this.updateCandlesForStrategy(strategy);
      }

      logger.debug(`Updated candles for ${strategiesToUpdate.length} unique symbol/interval combinations`);
    } catch (error) {
      logger.error('Error in updateAllCandles:', error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Start the cron job (using setInterval for higher frequency)
   */
  start() {
    const intervalMs = configService.getNumber('CANDLE_UPDATE_INTERVAL_MS', 30000);
    
    // Use setInterval for frequencies higher than 1 minute
    // Cron only supports minimum 1 minute intervals
    if (intervalMs < 60000) {
      // Use setInterval for sub-minute intervals
      this.updateInterval = setInterval(async () => {
        await this.updateAllCandles();
      }, intervalMs);

      // Run immediately on start
      this.updateAllCandles();

      logger.info(`CandleUpdater started with interval: ${intervalMs}ms (${intervalMs / 1000}s)`);
    } else {
      // Use cron for intervals >= 1 minute
      const pattern = DEFAULT_CRON_PATTERNS.CANDLE_UPDATE;
      cron.schedule(pattern, async () => {
        await this.updateAllCandles();
      });
      logger.info(`CandleUpdater started with pattern: ${pattern}`);
    }
  }

  /**
   * Stop the update job
   */
  stop() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    logger.info('CandleUpdater stopped');
  }

  /**
   * Add exchange service for a new bot
   * @param {Object} bot - Bot object
   */
  async addBot(bot) {
    try {
      const exchangeService = new ExchangeService(bot);
      await exchangeService.initialize();
      this.exchangeServices.set(bot.id, exchangeService);

      const candleService = new CandleService(exchangeService);
      this.candleServices.set(bot.id, candleService);

      logger.info(`Added bot ${bot.id} to CandleUpdater`);
    } catch (error) {
      logger.error(`Failed to add bot ${bot.id} to CandleUpdater:`, error);
    }
  }

  /**
   * Remove bot from updater
   * @param {number} botId - Bot ID
   */
  removeBot(botId) {
    this.exchangeServices.delete(botId);
    this.candleServices.delete(botId);
    logger.info(`Removed bot ${botId} from CandleUpdater`);
  }
}

