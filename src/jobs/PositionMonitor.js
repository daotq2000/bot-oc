import cron from 'node-cron';
import { Position } from '../models/Position.js';
import { Strategy } from '../models/Strategy.js';
import { ExchangeService } from '../services/ExchangeService.js';
import { PositionService } from '../services/PositionService.js';
import { OrderService } from '../services/OrderService.js';
import { TelegramService } from '../services/TelegramService.js';
import { DEFAULT_CRON_PATTERNS } from '../config/constants.js';
import { configService } from '../services/ConfigService.js';
import logger from '../utils/logger.js';

/**
 * Position Monitor Job - Monitor and update open positions
 */
export class PositionMonitor {
  constructor() {
    this.exchangeServices = new Map(); // botId -> ExchangeService
    this.positionServices = new Map(); // botId -> PositionService
    this.orderServices = new Map(); // botId -> OrderService
    this.telegramService = null;
    this.isRunning = false;
  }

  /**
   * Initialize services for all active bots
   */
  async initialize(telegramService) {
    this.telegramService = telegramService;

    try {
      const { Bot } = await import('../models/Bot.js');
      const bots = await Bot.findAll(true); // Active bots only

      for (const bot of bots) {
        await this.addBot(bot);
      }
    } catch (error) {
      logger.error('Failed to initialize PositionMonitor:', error);
    }
  }

  /**
   * Add bot to monitor
   * @param {Object} bot - Bot object
   */
  async addBot(bot) {
    try {
      const exchangeService = new ExchangeService(bot);
      await exchangeService.initialize();
      this.exchangeServices.set(bot.id, exchangeService);

      const positionService = new PositionService(exchangeService, this.telegramService);
      this.positionServices.set(bot.id, positionService);

      const orderService = new OrderService(exchangeService, this.telegramService);
      this.orderServices.set(bot.id, orderService);

      logger.info(`PositionMonitor initialized for bot ${bot.id}`);
    } catch (error) {
      logger.error(`Failed to initialize PositionMonitor for bot ${bot.id}:`, error);
    }
  }

  /**
   * Remove bot from monitor
   * @param {number} botId - Bot ID
   */
  removeBot(botId) {
    this.exchangeServices.delete(botId);
    this.positionServices.delete(botId);
    this.orderServices.delete(botId);
    logger.info(`Removed bot ${botId} from PositionMonitor`);
  }

  /**
   * Monitor a single position
   * @param {Object} position - Position object
   */
  async monitorPosition(position) {
    try {
      const positionService = this.positionServices.get(position.bot_id || position.strategy?.bot_id);
      if (!positionService) {
        logger.warn(`PositionService not found for position ${position.id}`);
        return;
      }

      // Update position (checks TP/SL and updates dynamic SL)
      const updated = await positionService.updatePosition(position);

      // If position was closed, send notification
      if (updated.status === 'closed' && updated.close_reason) {
        const orderService = this.orderServices.get(position.bot_id || position.strategy?.bot_id);
        if (orderService && this.telegramService) {
          await this.telegramService.sendCloseNotification(updated, position);
        }
      }
    } catch (error) {
      logger.error(`Error monitoring position ${position.id}:`, error);
    }
  }

  /**
   * Check for unfilled orders that should be cancelled (candle ended)
   * @param {Object} position - Position object
   */
  async checkUnfilledOrders(position) {
    try {
      // Resolve services
      const strategy = await Strategy.findById(position.strategy_id);
      if (!strategy) return;
      const exchangeService = this.exchangeServices.get(strategy.bot_id);
      const orderService = this.orderServices.get(strategy.bot_id);
      if (!exchangeService || !orderService) return;

      // TTL-based cancellation: if order not filled after N minutes, cancel
      
      const ttlMinutes = Number(configService.getNumber('ENTRY_ORDER_TTL_MINUTES', 10));
      const ttlMs = Math.max(1, ttlMinutes) * 60 * 1000;
      const openedAtMs = new Date(position.opened_at).getTime();
      const now = Date.now();

      if (position.status === 'open' && now - openedAtMs >= ttlMs) {
        // Check actual order status on exchange to avoid cancelling filled orders
        const st = await exchangeService.getOrderStatus(position.symbol, position.order_id);
        if (st.status === 'open' && (st.filled || 0) === 0) {
          await orderService.cancelOrder(position, 'ttl_expired');
          logger.info(`Cancelled unfilled entry (TTL ${ttlMinutes}m) for position ${position.id}`);
          return; // done for this position
        }
      }

      // Optional: candle-based safety cancel for non-filled entries from previous candle
      
      const candleCancelEnabled = configService.getBoolean('ENABLE_CANDLE_END_CANCEL_FOR_ENTRY', false);
      if (candleCancelEnabled) {
        const { CandleService } = await import('../services/CandleService.js');
        const candleService = new CandleService(exchangeService);
        const latestCandle = await candleService.getLatestCandle(strategy.symbol, strategy.interval);
        if (!latestCandle) return;
        const isCandleClosed = candleService.isCandleClosed(latestCandle);

        if (isCandleClosed && position.status === 'open') {
          const positionTime = new Date(position.opened_at).getTime();
          const candleTime = latestCandle.open_time;
          if (positionTime < candleTime) {
            const st = await exchangeService.getOrderStatus(position.symbol, position.order_id);
            if (st.status === 'open' && (st.filled || 0) === 0) {
              await orderService.cancelOrder(position, 'candle_end');
              logger.info(`Cancelled unfilled order at candle end for position ${position.id}`);
            }
          }
        }
      }
    } catch (error) {
      logger.error(`Error checking unfilled orders for position ${position.id}:`, error);
    }
  }

  /**
   * Monitor all open positions
   */
  async monitorAllPositions() {
    if (this.isRunning) {
      logger.debug('PositionMonitor already running, skipping...');
      return;
    }

    this.isRunning = true;

    try {
      const openPositions = await Position.findOpen();

      // Process positions in batches
      const batchSize = 5;
      for (let i = 0; i < openPositions.length; i += batchSize) {
        const batch = openPositions.slice(i, i + batchSize);
        
        await Promise.allSettled(
          batch.map(p => this.monitorPosition(p))
        );

        // Check for unfilled orders
        await Promise.allSettled(
          batch.map(p => this.checkUnfilledOrders(p))
        );

        // Small delay between batches
        if (i + batchSize < openPositions.length) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      logger.debug(`Monitored ${openPositions.length} open positions`);
    } catch (error) {
      logger.error('Error in monitorAllPositions:', error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Start the cron job
   */
  start() {
    const pattern = DEFAULT_CRON_PATTERNS.POSITION_MONITOR;
    
    cron.schedule(pattern, async () => {
      await this.monitorAllPositions();
    });

    logger.info(`PositionMonitor started with pattern: ${pattern}`);
  }
}

