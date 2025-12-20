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

      // Notification is now handled within PositionService.closePosition to ensure correct PNL
      if (updated.status === 'closed' && updated.close_reason) {
        logger.info(`Position ${position.id} was closed with reason: ${updated.close_reason}. Notification handled by PositionService.`);
      }
    } catch (error) {
      logger.error(`Error monitoring position ${position.id}:`, error);
    }
  }

  /**
   * Place TP/SL orders for new positions that don't have them yet.
   * @param {Object} position - Position object
   */
  async placeTpSlOrders(position) {
    // Skip if position already has TP/SL orders or is not open
    if (position.status !== 'open' || (position.tp_order_id && position.sl_order_id)) {
      return;
    }

    try {
      const exchangeService = this.exchangeServices.get(position.bot_id);
      if (!exchangeService) {
        logger.warn(`[Place TP/SL] ExchangeService not found for bot ${position.bot_id}`);
        return;
      }

      // Get the actual fill price from the exchange
      const fillPrice = await exchangeService.getOrderAverageFillPrice(position.symbol, position.order_id);
      if (!fillPrice || !Number.isFinite(fillPrice) || fillPrice <= 0) {
        logger.debug(`[Place TP/SL] Could not get fill price for position ${position.id}, will retry.`);
        return;
      }

      // Update position with the real entry price
      await Position.update(position.id, { entry_price: fillPrice });
      position.entry_price = fillPrice;
      logger.info(`[Place TP/SL] Updated position ${position.id} with actual fill price: ${fillPrice}`);

      // Recalculate TP/SL based on the real entry price
      const { calculateTakeProfit, calculateInitialStopLoss } = await import('../utils/calculator.js');
      const tpPrice = calculateTakeProfit(fillPrice, position.oc, position.take_profit, position.side);
      // Only set SL if strategy.stoploss > 0. No fallback to reduce/up_reduce
      const rawStoploss = position.stoploss !== undefined ? Number(position.stoploss) : NaN;
      const isStoplossValid = Number.isFinite(rawStoploss) && rawStoploss > 0;
      const slPrice = isStoplossValid ? calculateInitialStopLoss(fillPrice, rawStoploss, position.side) : null;

      // Get the exact quantity of the position
      const quantity = await exchangeService.getClosableQuantity(position.symbol, position.side);
      if (!quantity || quantity <= 0) {
        logger.warn(`[Place TP/SL] No closable quantity found for position ${position.id}, cannot place TP/SL.`);
        return;
      }

      // Place TP order
      if (!position.tp_order_id) {
        try {
          const tpRes = await exchangeService.createTakeProfitLimit(position.symbol, position.side, tpPrice, quantity);
          const tpOrderId = tpRes?.orderId ? String(tpRes.orderId) : null;
          if (tpOrderId) {
            // Store initial TP price for trailing calculation
            // We'll use a comment field or calculate from strategy each time
            // For now, initial TP = current TP (first time)
            await Position.update(position.id, { tp_order_id: tpOrderId, take_profit_price: tpPrice });
            logger.info(`[Place TP/SL] ✅ Placed TP order ${tpOrderId} for position ${position.id} @ ${tpPrice} (initial TP)`);
          }
        } catch (e) {
          logger.error(`[Place TP/SL] ❌ Failed to create TP order for position ${position.id}:`, e?.message || e);
        }
      }

      // Delay before placing SL order to avoid rate limits
      const delayMs = configService.getNumber('TP_SL_PLACEMENT_DELAY_MS', 10000);
      if (delayMs > 0) {
        logger.info(`[Place TP/SL] Waiting ${delayMs}ms before placing SL order for position ${position.id}...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      // Place SL order (only if slPrice is valid, i.e., stoploss > 0)
      if (!position.sl_order_id && slPrice !== null && Number.isFinite(slPrice) && slPrice > 0) {
        // Safety check: If SL is invalid (SL <= entry for SHORT or SL >= entry for LONG), force close position immediately
        const entryPrice = Number(fillPrice);
        const slPriceNum = Number(slPrice);
        if (Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(slPriceNum) && slPriceNum > 0) {
          const isInvalidSL = (position.side === 'short' && slPriceNum <= entryPrice) || 
                             (position.side === 'long' && slPriceNum >= entryPrice);
          
          if (isInvalidSL) {
            logger.warn(`[Place TP/SL] Invalid SL detected for position ${position.id}: SL=${slPriceNum}, Entry=${entryPrice}, Side=${position.side}. Force closing position immediately to minimize risk.`);
            
            // Cancel TP order if any
            if (position.tp_order_id) {
              try {
                await exchangeService.cancelOrder(position.tp_order_id, position.symbol);
                logger.info(`[Place TP/SL] Cancelled TP order ${position.tp_order_id} for position ${position.id}`);
              } catch (e) {
                logger.warn(`[Place TP/SL] Failed to cancel TP order ${position.tp_order_id}: ${e?.message || e}`);
              }
            }
            
            // Force close position immediately with market order
            const { PositionService } = await import('../services/PositionService.js');
            const positionService = new PositionService(exchangeService);
            const currentPrice = await exchangeService.getTickerPrice(position.symbol);
            const pnl = positionService.calculatePnL(position, currentPrice);
            await positionService.closePosition(position, currentPrice, pnl, 'sl_invalid');
            return; // Exit early, position is closed
          }
        }
        
        try {
          const slRes = await exchangeService.createStopLossLimit(position.symbol, position.side, slPrice, quantity);
          const slOrderId = slRes?.orderId ? String(slRes.orderId) : null;
          if (slOrderId) {
            await Position.update(position.id, { sl_order_id: slOrderId, stop_loss_price: slPrice });
            logger.info(`[Place TP/SL] ✅ Placed SL order ${slOrderId} for position ${position.id} @ ${slPrice}`);
          }
        } catch (e) {
          logger.error(`[Place TP/SL] ❌ Failed to create SL order for position ${position.id}:`, e?.message || e);
        }
      } else if (slPrice === null || slPrice <= 0) {
        logger.info(`[Place TP/SL] Skipping SL order placement for position ${position.id} (stoploss <= 0 or not set)`);
      }
    } catch (error) {
      logger.error(`[Place TP/SL] Error processing TP/SL for position ${position.id}:`, error?.message || error, error?.stack);
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

      // DEPRECATED: Candle-based safety cancel feature removed (no longer using database candles)
      // This feature is disabled as we no longer store candles in database
      // Orders are now managed by TTL (ENTRY_ORDER_TTL_MINUTES) instead

      // Re-create entry order after manual cancel (binance-mainet) if 2 minutes passed
      if (position.status === 'open' && position.order_id) {
        try {
          const st = await exchangeService.getOrderStatus(position.symbol, position.order_id);
          const reMinutes = Number(configService.getNumber('RECREATE_CANCELED_ENTRY_MINUTES', 2));
          const twoMinutes = Math.max(1, reMinutes) * 60 * 1000;
          if ((st.status === 'canceled' || st.status === 'cancelled') && (st.filled || 0) === 0 && (now - openedAtMs) >= twoMinutes) {
            // Scope to the requested bot name, if available in this query
            if (!position.bot_name || position.bot_name === 'binance-mainet') {
              // Re-create as passive LIMIT at original entry price
              const side = position.side === 'long' ? 'buy' : 'sell';
              const params = {
                symbol: position.symbol,
                side,
                positionSide: position.side === 'long' ? 'LONG' : 'SHORT',
                amount: Number(position.amount), // USDT amount
                type: 'limit',
                price: Number(position.entry_price)
              };
              try {
                const newOrder = await exchangeService.createOrder(params);
                if (newOrder && newOrder.id) {
                  await Position.update(position.id, { order_id: newOrder.id });
                  logger.info(`Recreated entry order for position ${position.id} (${position.symbol}) after manual cancel. New order_id=${newOrder.id}`);
                }
              } catch (e) {
                logger.warn(`Failed to recreate entry order for position ${position.id}: ${e?.message || e}`);
              }
            }
          }
        } catch (e) {
          logger.debug(`getOrderStatus failed for position ${position.id} during recreate check: ${e?.message || e}`);
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

      // Process positions in batches (configurable)
      const batchSize = Number(configService.getNumber('POSITION_MONITOR_BATCH_SIZE', 5));
      for (let i = 0; i < openPositions.length; i += batchSize) {
        const batch = openPositions.slice(i, i + batchSize);
        
        // First, try to place TP/SL for new positions that might be missing them
        await Promise.allSettled(
          batch.map(p => this.placeTpSlOrders(p))
        );

        // Then, monitor positions (update dynamic SL, check for TP/SL hit)
        await Promise.allSettled(
          batch.map(p => this.monitorPosition(p))
        );

        // Check for other order management tasks
        await Promise.allSettled(
          batch.map(p => this.checkUnfilledOrders(p))
        );

        // Small delay between batches
        if (i + batchSize < openPositions.length) {
          const delayMs = Number(configService.getNumber('POSITION_MONITOR_BATCH_DELAY_MS', 500));
          await new Promise(resolve => setTimeout(resolve, delayMs));
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

