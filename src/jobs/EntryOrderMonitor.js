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
    this.bots = new Map(); // botId -> Bot (for exchange lookup)
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

      // Initialize bots sequentially with delay to reduce CPU load
      for (let i = 0; i < bots.length; i++) {
        await this._addBot(bots[i]);
        // Add delay between bot initializations to avoid CPU spike
        if (i < bots.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 600)); // 600ms delay
        }
      }
    } catch (error) {
      logger.error('[EntryOrderMonitor] Failed to initialize:', error);
    }
  }

  async _addBot(bot) {
    try {
      // Store bot for exchange lookup
      this.bots.set(bot.id, bot);
      
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
   * CRITICAL: Updates orderStatusCache for ALL orders (entry, TP, SL) to enable fast order status checks
   * @param {number} botId
   * @param {Object} evt
   */
  async _handleBinanceOrderTradeUpdate(botId, evt) {
    try {
      const e = evt?.e || evt?.eventType;
      if (e !== 'ORDER_TRADE_UPDATE') {
        logger.debug(`[EntryOrderMonitor] Ignoring non-ORDER_TRADE_UPDATE event: ${e}`);
        return;
      }

      const o = evt.o || evt.order || {};
      const orderId = o.i ?? o.orderId; // i: orderId in futures stream
      const symbol = o.s || o.symbol;
      // Normalize status early for consistent handling
      const status = String(o.X || o.orderStatus || '').toUpperCase(); // NEW, PARTIALLY_FILLED, FILLED, CANCELED, EXPIRED
      const avgPriceStr = o.ap ?? o.avgPrice ?? o.p ?? o.price ?? null;
      const avgPrice = avgPriceStr ? Number(avgPriceStr) : NaN;
      const filledQtyStr = o.z ?? o.cumQty ?? o.filledQty ?? null;
      const filledQty = filledQtyStr ? Number(filledQtyStr) : NaN;

      if (!orderId || !symbol) {
        logger.debug(`[EntryOrderMonitor] Missing orderId or symbol in ORDER_TRADE_UPDATE event: orderId=${orderId}, symbol=${symbol}`);
        return;
      }

      // CRITICAL: Update order status cache for ALL orders (entry, TP, SL)
      // This enables PositionService to detect TP/SL fills without REST API calls
      // Get exchange from bot (this is Binance handler, but use bot.exchange for consistency)
      const bot = this.bots.get(botId);
      if (!bot) {
        logger.warn(`[EntryOrderMonitor] Bot ${botId} not found in bots map, using default exchange 'binance'`);
      }
      const exchange = (bot?.exchange || 'binance').toLowerCase();
      
      // Update cache with normalized data
      orderStatusCache.updateOrderStatus(orderId, {
        status: status,
        filled: filledQty,
        avgPrice: isNaN(avgPrice) || avgPrice <= 0 ? null : avgPrice,
        symbol: symbol
      }, exchange);

      const isFilled = status === 'FILLED';
      const isCanceled = status === 'CANCELED' || status === 'CANCELLED' || status === 'EXPIRED';

      // Handle entry orders first (highest priority)
      const entry = await EntryOrder.findOpenByBotAndOrder(botId, orderId);
      if (entry) {
        if (isFilled) {
          // Confirmed filled → create Position and mark entry_orders as filled
          logger.info(`[EntryOrderMonitor] Entry order ${entry.id} (orderId=${orderId}, ${symbol}) FILLED via WebSocket. Creating Position...`);
          await this._confirmEntryWithPosition(botId, entry, isNaN(avgPrice) || avgPrice <= 0 ? null : avgPrice);
        } else if (isCanceled && (!Number.isFinite(filledQty) || filledQty <= 0)) {
          // Cancelled/expired without fill → mark as canceled
          await EntryOrder.markCanceled(entry.id, status === 'EXPIRED' ? 'expired' : 'canceled');
          logger.info(`[EntryOrderMonitor] Entry order ${entry.id} (orderId=${orderId}, ${symbol}) ${status} via WebSocket.`);
        } else if (status === 'PARTIALLY_FILLED') {
          logger.debug(`[EntryOrderMonitor] Entry order ${entry.id} (orderId=${orderId}, ${symbol}) PARTIALLY_FILLED: ${filledQty}`);
        }
        return; // Entry order handled
      }

      // TP/SL orders: Cache already updated above
      // PositionService.updatePosition will detect TP/SL fills via cache on next monitor cycle
      // This avoids O(N) DB scan on every TP/SL fill event (performance optimization)
      if (isFilled) {
        logger.info(
          `[EntryOrderMonitor] TP/SL order ${orderId} (${symbol}) FILLED via WebSocket. ` +
          `Cache updated. PositionService will detect on next cycle.`
        );
      } else if (isCanceled) {
        logger.debug(`[EntryOrderMonitor] TP/SL order ${orderId} (${symbol}) ${status} via WebSocket. Cache updated.`);
      } else if (status === 'PARTIALLY_FILLED') {
        logger.debug(`[EntryOrderMonitor] TP/SL order ${orderId} (${symbol}) PARTIALLY_FILLED: ${filledQty}`);
      }
    } catch (error) {
      logger.error(
        `[EntryOrderMonitor] Error in _handleBinanceOrderTradeUpdate for bot ${botId}:`,
        error?.message || error,
        error?.stack
      );
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

      // RATE-LIMIT GUARD: Process entries in batches with delay to avoid overwhelming exchange API
      const batchSize = Number(configService.getNumber('ENTRY_ORDER_POLL_BATCH_SIZE', 10));
      const batchDelayMs = Number(configService.getNumber('ENTRY_ORDER_POLL_BATCH_DELAY_MS', 1000));
      
      for (let i = 0; i < openEntries.length; i += batchSize) {
        const batch = openEntries.slice(i, i + batchSize);
        
        // Process batch with Promise.allSettled to handle errors gracefully
        await Promise.allSettled(
          batch.map(entry => this._pollSingleEntryOrder(entry))
        );
        
        // Delay between batches to avoid rate limits
        if (i + batchSize < openEntries.length && batchDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, batchDelayMs));
        }
      }
    } catch (error) {
      logger.error('[EntryOrderMonitor] Error in pollOpenEntryOrders:', error?.message || error);
    }
  }

  /**
   * Poll a single entry order (extracted for batch processing)
   * @param {Object} entry - Entry order object
   */
  async _pollSingleEntryOrder(entry) {
        try {
          const exchangeService = this.exchangeServices.get(entry.bot_id);
      if (!exchangeService) return;

          const st = await exchangeService.getOrderStatus(entry.symbol, entry.order_id);
          const status = (st?.status || '').toLowerCase();
          const filled = Number(st?.filled || 0);

          if ((status === 'closed' || status === 'filled') && filled > 0) {
            // Confirmed filled via REST
            await this._confirmEntryWithPosition(entry.bot_id, entry, null);
          } else if ((status === 'canceled' || status === 'cancelled' || status === 'expired') && filled === 0) {
            await EntryOrder.markCanceled(entry.id, status === 'expired' ? 'expired' : 'canceled');
            logger.debug(`[EntryOrderMonitor] Entry order ${entry.id} (orderId=${entry.order_id}, ${entry.symbol}) canceled/expired via REST polling.`);
          } else {
        // TTL-based auto-cancel for stale LIMIT entry orders
        const ttlMinutes = Number(configService.getNumber('ENTRY_ORDER_TTL_MINUTES', 30));
            const ttlMs = Math.max(1, ttlMinutes) * 60 * 1000;
            const createdAtMs = new Date(entry.created_at || entry.createdAt || entry.created || Date.now()).getTime();
            const now = Date.now();

            if (!Number.isNaN(createdAtMs) && now - createdAtMs >= ttlMs) {
          // RACE CONDITION FIX: Re-check order status before canceling
          // Order might have been FILLED between last check and TTL expiration
          try {
            const recheckStatus = await exchangeService.getOrderStatus(entry.symbol, entry.order_id);
            const recheckStatusLower = (recheckStatus?.status || '').toLowerCase();
            const recheckFilled = Number(recheckStatus?.filled || 0);
            
            // If order is now FILLED, don't cancel - create Position instead
            if ((recheckStatusLower === 'closed' || recheckStatusLower === 'filled') && recheckFilled > 0) {
              logger.info(
                `[EntryOrderMonitor] Entry order ${entry.id} was FILLED during TTL check (orderId=${entry.order_id}, ${entry.symbol}). ` +
                `Creating Position instead of canceling.`
              );
              await this._confirmEntryWithPosition(entry.bot_id, entry, null);
              return; // Skip cancellation
            }
            
            // Order is still open - proceed with cancellation
              try {
                // Cancel on exchange first
                await exchangeService.cancelOrder(entry.order_id, entry.symbol);
              } catch (cancelErr) {
                logger.warn(
                  `[EntryOrderMonitor] Failed to cancel stale entry order ${entry.id} on exchange (orderId=${entry.order_id}, ${entry.symbol}): ${cancelErr?.message || cancelErr}`
                );
              }

              // Mark as canceled in DB regardless of remote cancel result
              await EntryOrder.markCanceled(entry.id, 'expired_ttl');
              logger.info(
                `[EntryOrderMonitor] ⏱️ Auto-canceled stale entry order ${entry.id} (orderId=${entry.order_id}, ${entry.symbol}) after TTL ` +
                `${ttlMinutes} minutes (created_at=${new Date(createdAtMs).toISOString()})`
              );
          } catch (recheckErr) {
            // If re-check fails, proceed with cancellation (safer than leaving stale order)
            logger.warn(`[EntryOrderMonitor] Failed to re-check order status before TTL cancel for entry ${entry.id}: ${recheckErr?.message || recheckErr}`);
            try {
              await exchangeService.cancelOrder(entry.order_id, entry.symbol);
            } catch (cancelErr) {
              logger.warn(`[EntryOrderMonitor] Failed to cancel stale entry order ${entry.id}: ${cancelErr?.message || cancelErr}`);
            }
            await EntryOrder.markCanceled(entry.id, 'expired_ttl');
          }
        }
      }
    } catch (inner) {
      logger.warn(`[EntryOrderMonitor] Failed to poll entry order ${entry.id} (${entry.symbol}): ${inner?.message || inner}`);
    }
  }

  /**
   * Confirm entry order by creating Position and marking entry_orders as filled
   * IDEMPOTENT: Checks for existing Position before creating to prevent duplicates
   * @param {number} botId
   * @param {Object} entry
   * @param {number|null} overrideEntryPrice
   */
  async _confirmEntryWithPosition(botId, entry, overrideEntryPrice = null) {
    try {
      // IDEMPOTENCY GUARD: Check if Position already exists for this order_id
      // This prevents duplicate Position creation when WS and REST both detect FILLED
      // or when WS sends duplicate events
      const { pool } = await import('../config/database.js');
      const [existingPositions] = await pool.execute(
        `SELECT id, status FROM positions WHERE bot_id = ? AND order_id = ? LIMIT 1`,
        [botId, entry.order_id]
      );
      
      if (existingPositions.length > 0) {
        const existing = existingPositions[0];
        logger.debug(
          `[EntryOrderMonitor] Position already exists for entry order ${entry.id} (order_id=${entry.order_id}): ` +
          `Position ${existing.id}, status=${existing.status}. Marking entry as filled and skipping creation.`
        );
        // Mark entry as filled even if Position already exists (idempotent operation)
        await EntryOrder.markFilled(entry.id);
        return;
      }

      const { Strategy } = await import('../models/Strategy.js');
      const strategy = await Strategy.findById(entry.strategy_id);
      if (!strategy) {
        logger.warn(`[EntryOrderMonitor] Strategy ${entry.strategy_id} not found for entry order ${entry.id}, marking as canceled.`);
        await EntryOrder.markCanceled(entry.id, 'canceled');
        return;
      }

      // Concurrency management removed - PositionSync will handle limits
      // Create Position directly without reservation logic

      const effectiveEntryPrice = Number.isFinite(overrideEntryPrice) && overrideEntryPrice > 0
        ? overrideEntryPrice
        : Number(entry.entry_price);

      const { calculateTakeProfit, calculateInitialStopLoss } = await import('../utils/calculator.js');
      const side = entry.side;
      const tpPrice = calculateTakeProfit(effectiveEntryPrice, strategy.take_profit, side);
      // Only set SL if strategy.stoploss > 0. No fallback to reduce/up_reduce
      const rawStoploss = strategy.stoploss !== undefined ? Number(strategy.stoploss) : NaN;
      const isStoplossValid = Number.isFinite(rawStoploss) && rawStoploss > 0;
      const slPrice = isStoplossValid ? calculateInitialStopLoss(effectiveEntryPrice, rawStoploss, side) : null;

      let position = null;
      try {
        // CRITICAL FIX: Store reduce and up_reduce from strategy for trailing TP calculation
        // Note: positions table may not have reduce/up_reduce columns, so we store in current_reduce
        // PositionService will read reduce/up_reduce from strategy JOIN when needed
        // CRITICAL FIX: Set tp_sl_pending flag to ensure PositionMonitor places TP/SL orders
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
        current_reduce: strategy.reduce,
        tp_sl_pending: true // Flag: TP/SL orders will be placed by PositionMonitor
      });

      await EntryOrder.markFilled(entry.id);

      logger.debug(`[EntryOrderMonitor] ✅ Confirmed entry order ${entry.id} as Position ${position.id} (${entry.symbol}) at entry=${effectiveEntryPrice}`);

      // CRITICAL FIX: Enable Telegram notification when entry order is filled
      // This alerts user when position is opened
      try {
        // Ensure bot info is available for Telegram alert
        if (!strategy.bot && strategy.bot_id) {
          const { Bot } = await import('../models/Bot.js');
          strategy.bot = await Bot.findById(strategy.bot_id);
        }

        // Send entry trade alert to Telegram channel
        if (this.telegramService?.sendEntryTradeAlert) {
          await this.telegramService.sendEntryTradeAlert(position, strategy, strategy.oc);
          logger.info(`[EntryOrderMonitor] ✅ Entry trade alert sent for Position ${position.id}`);
        } else {
          logger.debug(`[EntryOrderMonitor] TelegramService.sendEntryTradeAlert not available, skipping alert for Position ${position.id}`);
        }
      } catch (e) {
        // Non-critical: log error but don't fail position creation
        logger.warn(`[EntryOrderMonitor] Failed to send Telegram notifications for Position ${position.id}: ${e?.message || e}`);
      }
      } catch (posError) {
        // If Position creation failed, log error and let EntryOrderMonitor retry later
        // PositionSync will also try to create it from exchange
        logger.error(`[EntryOrderMonitor] ❌ Failed to create Position for entry order ${entry.id}: ${posError?.message || posError}`);
        logger.error(`[EntryOrderMonitor] Stack trace:`, posError?.stack);
        
        // Check if error is due to duplicate (race condition between WS and REST)
        if (posError?.code === 'ER_DUP_ENTRY' || posError?.message?.includes('Duplicate entry') || posError?.message?.includes('UNIQUE constraint')) {
          logger.warn(`[EntryOrderMonitor] Position creation failed due to duplicate (likely race condition). Entry order ${entry.id} will be marked as filled.`);
          // Mark entry as filled since Position likely exists (created by another process)
          try {
            await EntryOrder.markFilled(entry.id);
          } catch (markError) {
            logger.warn(`[EntryOrderMonitor] Failed to mark entry ${entry.id} as filled after duplicate error: ${markError?.message || markError}`);
          }
        }
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


