import cron from 'node-cron';
import { EntryOrder } from '../models/EntryOrder.js';
import { Position } from '../models/Position.js';
import { ExchangeService } from '../services/ExchangeService.js';
import { PositionWebSocketClient } from '../services/PositionWebSocketClient.js';
import { orderStatusCache } from '../services/OrderStatusCache.js';
import { DEFAULT_CRON_PATTERNS } from '../config/constants.js';
import { configService } from '../services/ConfigService.js';
import logger from '../utils/logger.js';

/**
 * EntryOrderMonitor
 * - Tracks pending entry orders (especially LIMIT) stored in entry_orders table
 * - Prefers Binance Futures user-data WebSocket (ORDER_TRADE_UPDATE)
 * - Fallback to REST polling for all exchanges when WS is not available
 */
export class EntryOrderMonitor {
  constructor() {
    this.exchangeServices = new Map(); // botId -> ExchangeService
    this.wsClients = new Map(); // botId -> PositionWebSocketClient (Binance only)
    this.telegramService = null;
    this.isRunning = false;
    this.cronJob = null;
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
        await this._addBot(bot);
      }
    } catch (error) {
      logger.error('[EntryOrderMonitor] Failed to initialize:', error);
    }
  }

  async _addBot(bot) {
    try {
      const exchangeService = new ExchangeService(bot);
      await exchangeService.initialize();
      this.exchangeServices.set(bot.id, exchangeService);

      // Binance-only: start user-data WebSocket for ORDER_TRADE_UPDATE
      if ((bot.exchange || '').toLowerCase() === 'binance' && exchangeService.binanceDirectClient) {
        const restMakeRequest = exchangeService.binanceDirectClient.makeRequest.bind(exchangeService.binanceDirectClient);
        const isTestnet = !!exchangeService.binanceDirectClient.isTestnet;
        const wsClient = new PositionWebSocketClient(restMakeRequest, isTestnet);

        wsClient.on('ORDER_TRADE_UPDATE', (evt) => {
          this._handleBinanceOrderTradeUpdate(bot.id, evt).catch(err => {
            logger.error(`[EntryOrderMonitor] Error in ORDER_TRADE_UPDATE handler for bot ${bot.id}:`, err?.message || err);
          });
        });

        wsClient.on('listenKeyExpired', () => {
          logger.warn(`[EntryOrderMonitor] listenKeyExpired for bot ${bot.id}, WS client will reconnect.`);
        });

        wsClient.on('raw', (evt) => {
          // Optional raw logging / debugging
          const eType = evt?.e || evt?.eventType;
          if (eType === 'ORDER_TRADE_UPDATE') {
            logger.debug(`[EntryOrderMonitor] ORDER_TRADE_UPDATE raw event received for bot ${bot.id}`);
          }
        });

        await wsClient.connect();
        this.wsClients.set(bot.id, wsClient);
        logger.info(`[EntryOrderMonitor] User-data WebSocket connected for bot ${bot.id}`);
      }

      logger.info(`[EntryOrderMonitor] Initialized for bot ${bot.id}`);
    } catch (error) {
      logger.error(`[EntryOrderMonitor] Failed to initialize for bot ${bot.id}:`, error);
    }
  }

  /**
   * Handle Binance ORDER_TRADE_UPDATE user-data event
   * @param {number} botId
   * @param {Object} evt
   */
  async _handleBinanceOrderTradeUpdate(botId, evt) {
    try {
      const e = evt?.e || evt?.eventType;
      if (e !== 'ORDER_TRADE_UPDATE') return;

      const o = evt.o || evt.order || {};
      const orderId = o.i ?? o.orderId; // i: orderId in futures stream
      const symbol = o.s || o.symbol;
      const status = o.X || o.orderStatus; // NEW, PARTIALLY_FILLED, FILLED, CANCELED, EXPIRED
      const avgPriceStr = o.ap ?? o.avgPrice ?? o.p ?? o.price ?? null;
      const avgPrice = avgPriceStr ? Number(avgPriceStr) : NaN;
      const filledQtyStr = o.z ?? o.cumQty ?? o.filledQty ?? null;
      const filledQty = filledQtyStr ? Number(filledQtyStr) : NaN;

      if (!orderId || !symbol) return;

      // Update order status cache for ALL orders (entry, TP, SL)
      orderStatusCache.updateOrderStatus(orderId, {
        status: status,
        filled: filledQty,
        avgPrice: isNaN(avgPrice) || avgPrice <= 0 ? null : avgPrice,
        symbol: symbol
      });

      const normalizedStatus = String(status || '').toUpperCase();
      const isFilled = normalizedStatus === 'FILLED';
      const isCanceled = normalizedStatus === 'CANCELED' || normalizedStatus === 'CANCELLED' || normalizedStatus === 'EXPIRED';

      // Handle entry orders
      const entry = await EntryOrder.findOpenByBotAndOrder(botId, orderId);
      if (entry) {
        if (isFilled) {
          // Confirmed filled → create Position and mark entry_orders as filled
          await this._confirmEntryWithPosition(botId, entry, isNaN(avgPrice) || avgPrice <= 0 ? null : avgPrice);
        } else if (isCanceled && (!Number.isFinite(filledQty) || filledQty <= 0)) {
          // Cancelled/expired without fill → mark as canceled
          await EntryOrder.markCanceled(entry.id, normalizedStatus === 'EXPIRED' ? 'expired' : 'canceled');
          logger.debug(`[EntryOrderMonitor] Entry order ${entry.id} (orderId=${orderId}, ${symbol}) canceled/expired on Binance (user-data WS).`);
        }
        return; // Entry order handled
      }

      // Handle TP/SL orders - check if any position has this order
      if (isFilled) {
        try {
          const positions = await Position.findOpen();
          for (const pos of positions) {
            if (pos.bot_id === botId && (pos.tp_order_id === String(orderId) || pos.sl_order_id === String(orderId))) {
              logger.debug(`[EntryOrderMonitor] TP/SL order ${orderId} for position ${pos.id} filled via WebSocket. Position will be closed on next update.`);
              // PositionService.updatePosition will detect this via cache
            }
          }
        } catch (err) {
          logger.debug(`[EntryOrderMonitor] Error checking positions for TP/SL order ${orderId}: ${err?.message || err}`);
        }
      }
    } catch (error) {
      logger.error('[EntryOrderMonitor] Error in _handleBinanceOrderTradeUpdate:', error?.message || error);
    }
  }

  /**
   * Fallback polling using REST for all exchanges
   */
  async pollOpenEntryOrders() {
    try {
      const openEntries = await EntryOrder.findOpen();
      if (!openEntries.length) return;

      logger.debug(`[EntryOrderMonitor] Polling ${openEntries.length} open entry orders via REST.`);

      for (const entry of openEntries) {
        try {
          const exchangeService = this.exchangeServices.get(entry.bot_id);
          if (!exchangeService) continue;

          const st = await exchangeService.getOrderStatus(entry.symbol, entry.order_id);
          const status = (st?.status || '').toLowerCase();
          const filled = Number(st?.filled || 0);

          if ((status === 'closed' || status === 'filled') && filled > 0) {
            // Confirmed filled via REST
            await this._confirmEntryWithPosition(entry.bot_id, entry, null);
          } else if ((status === 'canceled' || status === 'cancelled' || status === 'expired') && filled === 0) {
            await EntryOrder.markCanceled(entry.id, status === 'expired' ? 'expired' : 'canceled');
            logger.debug(`[EntryOrderMonitor] Entry order ${entry.id} (orderId=${entry.order_id}, ${entry.symbol}) canceled/expired via REST polling.`);
          }
        } catch (inner) {
          logger.warn(`[EntryOrderMonitor] Failed to poll entry order ${entry.id} (${entry.symbol}): ${inner?.message || inner}`);
        }
      }
    } catch (error) {
      logger.error('[EntryOrderMonitor] Error in pollOpenEntryOrders:', error?.message || error);
    }
  }

  /**
   * Confirm entry order by creating Position and marking entry_orders as filled
   * @param {number} botId
   * @param {Object} entry
   * @param {number|null} overrideEntryPrice
   */
  async _confirmEntryWithPosition(botId, entry, overrideEntryPrice = null) {
    try {
      const { Strategy } = await import('../models/Strategy.js');
      const strategy = await Strategy.findById(entry.strategy_id);
      if (!strategy) {
        logger.warn(`[EntryOrderMonitor] Strategy ${entry.strategy_id} not found for entry order ${entry.id}, marking as canceled.`);
        await EntryOrder.markCanceled(entry.id, 'canceled');
        return;
      }

      // CRITICAL: Handle reservation for Position creation
      // Strategy: If entry_order has reservation_token from OrderService, use it (no need to reserve new slot)
      // Otherwise, reserve a new slot atomically
      // Concurrency management removed
      
      let reservationToken = entry.reservation_token || null;
      let useExistingReservation = false;
      
      if (reservationToken) {
        // Entry order was created with reservation - verify it's still valid
        // Check if reservation is still active in database
        try {
          const { pool } = await import('../config/database.js');
          const [rows] = await pool.execute(
            `SELECT status FROM concurrency_reservations WHERE bot_id = ? AND token = ? LIMIT 1`,
            [botId, reservationToken]
          );
          const reservationStatus = rows?.[0]?.status;
          
          if (reservationStatus === 'active') {
            // Reservation is still active - verify limit allows
            // Concurrency check disabled
            // const canAccept = await concurrencyManager.canAcceptNewPosition(botId);
            // if (!canAccept) { return; }
            // Reservation exists and is active - use it
            useExistingReservation = true;
            logger.debug(`[EntryOrderMonitor] Using existing active reservation ${reservationToken} for entry order ${entry.id}`);
          } else {
            // Reservation is not active (expired/released/cancelled) - need to reserve new slot
            logger.debug(`[EntryOrderMonitor] Existing reservation ${reservationToken} is ${reservationStatus || 'not found'}, will reserve new slot for entry order ${entry.id}`);
            reservationToken = null;
          }
        } catch (e) {
          // Error checking reservation - assume it's invalid and reserve new slot
          logger.debug(`[EntryOrderMonitor] Error checking reservation ${reservationToken}: ${e?.message || e}, will reserve new slot`);
          reservationToken = null;
        }
      }
      
      if (!useExistingReservation) {
        // No existing reservation (old entry_order or column doesn't exist) - reserve new slot
        // Retry logic to handle lock timeout
        let retries = 3;
        let lastError = null;
        while (retries > 0) {
          try {
            // reservationToken = await concurrencyManager.reserveSlot(botId);
            reservationToken = 'disabled'; // Concurrency disabled
            if (reservationToken) break;
            
            // If reserveSlot returns null (not timeout), check if limit reached
            // const status = await concurrencyManager.getStatus(botId);
            if (status.currentCount >= status.maxConcurrent) {
              logger.warn(`[EntryOrderMonitor] ⚠️ Failed to reserve slot for entry order ${entry.id}: limit reached (${status.currentCount}/${status.maxConcurrent}). Entry order will remain for retry.`);
              return;
            }
            
            // Otherwise, retry after short delay
            retries--;
            if (retries > 0) {
              await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms before retry
            }
          } catch (error) {
            lastError = error;
            if (error.code === 'CONCURRENCY_LOCK_TIMEOUT') {
              retries--;
              if (retries > 0) {
                logger.debug(`[EntryOrderMonitor] Lock timeout for entry order ${entry.id}, retrying... (${retries} retries left)`);
                await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s before retry
              }
            } else {
              // Other error - don't retry
              throw error;
            }
          }
        }
        
        if (!reservationToken) {
          const status = await concurrencyManager.getStatus(botId);
          logger.error(`[EntryOrderMonitor] ❌ Failed to reserve slot for entry order ${entry.id} after retries: ${lastError?.message || 'unknown error'}. Limit: ${status.currentCount}/${status.maxConcurrent}. Entry order will remain for retry.`);
          return;
        }
      }

      const effectiveEntryPrice = Number.isFinite(overrideEntryPrice) && overrideEntryPrice > 0
        ? overrideEntryPrice
        : Number(entry.entry_price);

      const { calculateTakeProfit, calculateInitialStopLoss } = await import('../utils/calculator.js');
      const side = entry.side;
      const tpPrice = calculateTakeProfit(effectiveEntryPrice, strategy.oc, strategy.take_profit, side);
      // Only set SL if strategy.stoploss > 0. No fallback to reduce/up_reduce
      const rawStoploss = strategy.stoploss !== undefined ? Number(strategy.stoploss) : NaN;
      const isStoplossValid = Number.isFinite(rawStoploss) && rawStoploss > 0;
      const slPrice = isStoplossValid ? calculateInitialStopLoss(effectiveEntryPrice, rawStoploss, side) : null;

      let position = null;
      try {
        position = await Position.create({
        strategy_id: entry.strategy_id,
        bot_id: botId,
        order_id: entry.order_id,
        symbol: entry.symbol,
        side: side,
        entry_price: effectiveEntryPrice,
        amount: entry.amount,
        take_profit_price: tpPrice,
        stop_loss_price: slPrice,
        current_reduce: strategy.reduce
      });

      await EntryOrder.markFilled(entry.id);

      // Finalize reservation as 'released' (Position created successfully)
      // await concurrencyManager.finalizeReservation(botId, reservationToken, 'released');

      logger.debug(`[EntryOrderMonitor] ✅ Confirmed entry order ${entry.id} as Position ${position.id} (${entry.symbol}) at entry=${effectiveEntryPrice}`);

      // Notify via Telegram (same as in OrderService)
      try {
        if (this.telegramService?.sendOrderNotification) {
          await this.telegramService.sendOrderNotification(position, strategy);
        }

        if (!strategy.bot && strategy.bot_id) {
          const { Bot } = await import('../models/Bot.js');
          strategy.bot = await Bot.findById(strategy.bot_id);
        }

        if (this.telegramService?.sendEntryTradeAlert) {
          await this.telegramService.sendEntryTradeAlert(position, strategy, strategy.oc);
        }
      } catch (e) {
        logger.warn(`[EntryOrderMonitor] Failed to send Telegram notifications for Position ${position.id}: ${e?.message || e}`);
      }
      } catch (posError) {
        // If Position creation failed, cancel reservation
        // await concurrencyManager.finalizeReservation(botId, reservationToken, 'cancelled');
        logger.error(`[EntryOrderMonitor] ❌ Failed to create Position for entry order ${entry.id}: ${posError?.message || posError}`);
        logger.error(`[EntryOrderMonitor] Stack trace:`, posError?.stack);
        // Don't re-throw - log error and let EntryOrderMonitor retry later
        // PositionSync will also try to create it from exchange
      }
    } catch (error) {
      logger.error(`[EntryOrderMonitor] Error confirming entry order ${entry.id}:`, error?.message || error);
      logger.error(`[EntryOrderMonitor] Stack trace:`, error?.stack);
    }
  }

  /**
   * Start cron-based REST polling
   */
  start() {
    if (this.isRunning) {
      logger.warn('[EntryOrderMonitor] Already running');
      return;
    }

    this.isRunning = true;

    const defaultPattern = DEFAULT_CRON_PATTERNS.POSITION_MONITOR || '*/1 * * * *';
    const cronPattern = configService.getString('ENTRY_ORDER_MONITOR_CRON', defaultPattern);

    this.cronJob = cron.schedule(cronPattern, async () => {
      await this.pollOpenEntryOrders();
    });

    logger.info(`[EntryOrderMonitor] Started with cron pattern: ${cronPattern}`);
  }

  /**
   * Stop monitor
   */
  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }

    for (const [, ws] of this.wsClients.entries()) {
      try {
        ws.stop();
      } catch (_) {}
    }
    this.wsClients.clear();

    logger.info('[EntryOrderMonitor] Stopped');
  }
}


