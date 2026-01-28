import cron from 'node-cron';
// EntryOrder tracking deprecated (replaced by positions.status='entry_pending')
// import { EntryOrder } from '../models/EntryOrder.js';
import { Position } from '../models/Position.js';
import { ExchangeService } from '../services/ExchangeService.js';
import { PositionWebSocketClient } from '../services/PositionWebSocketClient.js';
import { orderStatusCache } from '../services/OrderStatusCache.js';
import { calculatePnL } from '../utils/calculator.js';
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
    this.positionServices = new Map(); // botId -> PositionService (lazy)

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
      // IMPORTANT: Skip WS user-data stream for bots missing API credentials to avoid listenKey retry storms
      // (which can spam logs, waste CPU, and indirectly affect other bots)
      const isBinance = (bot.exchange || '').toLowerCase() === 'binance';
      const hasApiCreds = !!(bot?.access_key && String(bot.access_key).trim()) && !!(bot?.secret_key && String(bot.secret_key).trim());

      if (isBinance && !hasApiCreds) {
        logger.warn(`[EntryOrderMonitor] Bot ${bot.id} is Binance but missing access_key/secret_key. Skipping user-data WebSocket initialization.`);
      }

      if (isBinance && hasApiCreds && exchangeService.binanceDirectClient) {
        const restMakeRequest = exchangeService.binanceDirectClient.makeRequest.bind(exchangeService.binanceDirectClient);
        const isTestnet = !!exchangeService.binanceDirectClient.isTestnet;
        const wsClient = new PositionWebSocketClient(restMakeRequest, isTestnet);

        wsClient.on('ORDER_TRADE_UPDATE', (evt) => {
          this._handleBinanceOrderTradeUpdate(bot.id, evt).catch(err => {
            logger.error(`[EntryOrderMonitor] Error in ORDER_TRADE_UPDATE handler for bot ${bot.id}:`, err?.message || err);
          });
        });

        wsClient.on('ACCOUNT_UPDATE', (evt) => {
          this._handleBinanceAccountUpdate(bot.id, evt).catch(err => {
            logger.error(`[EntryOrderMonitor] Error in ACCOUNT_UPDATE handler for bot ${bot.id}:`, err?.message || err);
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
      const clientOrderId = o.c ?? o.clientOrderId ?? null; // c: clientOrderId in futures stream
      const symbol = o.s || o.symbol;
      // Normalize symbol: RIVER_USDT -> RIVERUSDT (remove underscore)
      const normalizedSymbol = symbol ? symbol.replace(/_/g, '') : symbol;
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

      // Parse positionId from clientOrderId if present (format: OC_B{botId}_P{positionId}_EXIT/TP/SL)
      let parsedPositionId = null;
      if (clientOrderId && typeof clientOrderId === 'string') {
        const match = clientOrderId.match(/OC_B\d+_P(\d+)_(EXIT|TP|SL)/);
        if (match) {
          parsedPositionId = parseInt(match[1], 10);
          logger.debug(`[EntryOrderMonitor] Parsed positionId=${parsedPositionId} from clientOrderId=${clientOrderId}`);
        }
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

      // CRITICAL: Distinguish ENTRY orders from EXIT orders
      // Entry orders: orderId matches order_id in positions table
      // Exit orders: orderId matches exit_order_id/sl_order_id OR clientOrderId has _EXIT/_TP/_SL
      if (isFilled) {
        // Strategy 1: Check if this is an entry order (by order_id in positions table)
        const entryPosition = await this._findPositionByOrderId(botId, orderId);
        if (entryPosition) {
          // This is an ENTRY order fill
          if (entryPosition.status === 'entry_pending') {
            logger.info(`[EntryOrderMonitor] Entry order FILLED via WS. Promoting entry_pending position ${entryPosition.id} (orderId=${orderId}, ${symbol}) to open...`);
            await this._confirmEntryFill(entryPosition, isNaN(avgPrice) || avgPrice <= 0 ? null : avgPrice);
          } else {
            logger.debug(`[EntryOrderMonitor] Entry order ${orderId} already processed (position ${entryPosition.id} status=${entryPosition.status}). Skipping.`);
          }
          return; // Entry order handled, don't process as exit order
        }

        // Strategy 2: Check if this is an exit order
        // Exit order indicators:
        // - clientOrderId contains _EXIT/_TP/_SL
        // - parsedPositionId is available (from clientOrderId)
        // - orderId matches exit_order_id or sl_order_id
        const isExitOrder = 
          (clientOrderId && (clientOrderId.includes('_EXIT') || clientOrderId.includes('_TP') || clientOrderId.includes('_SL'))) ||
          parsedPositionId !== null ||
          await this._isExitOrderId(botId, orderId);

        if (isExitOrder) {
          logger.info(`[EntryOrderMonitor] Exit order ${orderId} (${symbol}, normalized=${normalizedSymbol}) FILLED via WebSocket. clientOrderId=${clientOrderId || 'n/a'}, parsedPositionId=${parsedPositionId || 'n/a'}. Will close matching DB position + notify.`);
          logger.debug(`[EntryOrderMonitor] Searching for position with exit_order_id=${orderId} or sl_order_id=${orderId} for bot=${botId}`);
          await this._closePositionFromExitFill(botId, orderId, normalizedSymbol, avgPrice, filledQty, clientOrderId, parsedPositionId);
        } else {
          logger.debug(`[EntryOrderMonitor] Order ${orderId} (${symbol}) FILLED but not identified as entry or exit order. Skipping position update.`);
        }
      } else if (isCanceled) {
        logger.debug(`[EntryOrderMonitor] TP/SL order ${orderId} (${symbol}) ${status} via WebSocket. Cache updated.`);
      } else if (status === 'PARTIALLY_FILLED') {
        logger.debug(`[EntryOrderMonitor] TP/SL order ${orderId} (${symbol}) PARTIALLY_FILLED: ${filledQty}`);
      } else {
        logger.debug(`[EntryOrderMonitor] Order ${orderId} (${symbol}) status=${status}, not an entry order, not FILLED/CANCELED. Skipping.`);
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
   * Close DB position and notify when an exit order (TP/SL) is FILLED via WebSocket.
   * This is the ONLY allowed path to mark a position closed + send Telegram close alert.
   * @param {number} botId
   * @param {string|number} exitOrderId - Exchange orderId
   * @param {string} symbol - Normalized symbol (without underscore)
   * @param {number} avgPrice
   * @param {number|null} filledQty
   * @param {string|null} clientOrderId - Optional clientOrderId from WebSocket
   * @param {number|null} parsedPositionId - Optional positionId parsed from clientOrderId
   */
  async _closePositionFromExitFill(botId, exitOrderId, symbol, avgPrice, filledQty = null, clientOrderId = null, parsedPositionId = null) {
    try {
      logger.debug(`[EntryOrderMonitor] _closePositionFromExitFill: botId=${botId}, exitOrderId=${exitOrderId}, symbol=${symbol}, avgPrice=${avgPrice}, clientOrderId=${clientOrderId || 'n/a'}, parsedPositionId=${parsedPositionId || 'n/a'}`);
      
      // Strategy 1: If we have parsedPositionId from clientOrderId, try direct lookup first
      let dbPos = null;
      if (parsedPositionId) {
        try {
          const { default: pool } = await import('../config/database.js');
          const [rows] = await pool.execute(
            `SELECT * FROM positions WHERE id = ? AND bot_id = ? AND status = 'open' LIMIT 1`,
            [parsedPositionId, botId]
          );
          if (rows.length > 0) {
            dbPos = rows[0];
            logger.info(`[EntryOrderMonitor] ✅ Found position ${dbPos.id} by parsedPositionId from clientOrderId`);
          }
        } catch (err) {
          logger.warn(`[EntryOrderMonitor] Failed to lookup position by parsedPositionId ${parsedPositionId}: ${err?.message || err}`);
        }
      }
      
      // Strategy 2: Match by exit_order_id
      if (!dbPos) {
        dbPos = await Position.findOpenByExitOrderId(botId, exitOrderId);
      }
      
      // Strategy 3: Match by sl_order_id
      if (!dbPos) {
        logger.debug(`[EntryOrderMonitor] No position found with exit_order_id=${exitOrderId}, trying sl_order_id...`);
        const dbPosSl = await Position.findOpenBySlOrderId(botId, exitOrderId);
        if (dbPosSl) {
          dbPos = dbPosSl;
        }
      }
      
      if (!dbPos) {
          logger.warn(`[EntryOrderMonitor] ❌ No open DB position found for exitOrderId=${exitOrderId} bot=${botId} symbol=${symbol}`);
          logger.warn(`[EntryOrderMonitor] Searched: exit_order_id=${exitOrderId} (type: ${typeof exitOrderId}) and sl_order_id=${exitOrderId} (type: ${typeof exitOrderId})`);
          
          // Try to find any open position for this symbol to help debug
          // Normalize both DB symbol and search symbol for comparison
          try {
            const openPositions = await Position.findOpen();
            const symbolPositions = openPositions.filter(p => {
              if (p.bot_id !== botId) return false;
              // Normalize both symbols for comparison
              const dbSymbol = (p.symbol || '').replace(/_/g, '');
              const searchSymbol = (symbol || '').replace(/_/g, '');
              return dbSymbol === searchSymbol || 
                     dbSymbol === searchSymbol.replace('USDT', '') || 
                     searchSymbol.includes(dbSymbol) ||
                     dbSymbol.includes(searchSymbol);
            });
            
            logger.warn(`[EntryOrderMonitor] Found ${symbolPositions.length} open positions for bot=${botId} symbol=${symbol}`);
            
            if (symbolPositions.length > 0) {
              symbolPositions.forEach(pos => {
                logger.warn(`[EntryOrderMonitor] Position ${pos.id}: exit_order_id=${pos.exit_order_id} (type: ${typeof pos.exit_order_id}), sl_order_id=${pos.sl_order_id} (type: ${typeof pos.sl_order_id}), status=${pos.status}`);
              });
              
              // Try to match with type conversion
              const matchingPos = symbolPositions.find(p => 
                String(p.exit_order_id) === String(exitOrderId) || 
                String(p.sl_order_id) === String(exitOrderId) ||
                Number(p.exit_order_id) === Number(exitOrderId) ||
                Number(p.sl_order_id) === Number(exitOrderId)
              );
              
              if (matchingPos) {
                logger.warn(`[EntryOrderMonitor] ✅ Found matching position ${matchingPos.id} after type conversion!`);
                return await this._finalizeDbClose(botId, matchingPos, avgPrice, exitOrderId);
              }
            } else {
              // Check if position was already closed
              const { default: pool } = await import('../config/database.js');
              const [closedRows] = await pool.execute(
                `SELECT id, exit_order_id, sl_order_id, status, closed_at FROM positions WHERE bot_id = ? AND symbol = ? ORDER BY closed_at DESC LIMIT 5`,
                [botId, symbol]
              );
              if (closedRows.length > 0) {
                logger.warn(`[EntryOrderMonitor] Found ${closedRows.length} closed positions for bot=${botId} symbol=${symbol}`);
                closedRows.forEach(pos => {
                  logger.warn(`[EntryOrderMonitor] Closed position ${pos.id}: exit_order_id=${pos.exit_order_id}, sl_order_id=${pos.sl_order_id}, closed_at=${pos.closed_at}`);
                });
              }
            }
          } catch (debugErr) {
            logger.error(`[EntryOrderMonitor] Debug query failed: ${debugErr?.message || debugErr}`, debugErr?.stack);
          }
          
          // CRITICAL: Always send Telegram alert for WS-filled exit orders, even if DB position not found
          // This ensures we don't miss any exit order fills from WebSocket
          try {
            if (this.telegramService?.sendWsExitFilledAlert) {
              const bot = this.bots.get(botId);
              const exchange = (bot?.exchange || 'binance').toLowerCase();
              await this.telegramService.sendWsExitFilledAlert(botId, exitOrderId, symbol, avgPrice, filledQty, exchange);
              logger.info(`[EntryOrderMonitor] ✅ Sent WS exit filled alert for order ${exitOrderId} (position not found in DB)`);
            } else {
              logger.warn(`[EntryOrderMonitor] TelegramService.sendWsExitFilledAlert not available, cannot send alert for order ${exitOrderId}`);
            }
          } catch (alertErr) {
            logger.error(`[EntryOrderMonitor] Failed to send WS exit filled alert for order ${exitOrderId}: ${alertErr?.message || alertErr}`);
          }
          
          // CRITICAL: Cancel all pending orders for this symbol even if position not found in DB
          // This prevents orders from hanging when position is closed via websocket but not found in DB
          try {
            await this._cancelPendingOrdersForSymbol(botId, symbol, null);
          } catch (cancelErr) {
            // Non-critical: log error but don't fail
            logger.warn(`[EntryOrderMonitor] Failed to cancel pending orders for symbol ${symbol} after exit order ${exitOrderId} fill (position not found): ${cancelErr?.message || cancelErr}`);
          }
          
          return;
      }
      
      // Found position - close it
      logger.info(`[EntryOrderMonitor] Found position ${dbPos.id} with exit_order_id=${exitOrderId} or sl_order_id=${exitOrderId}`);
      return await this._finalizeDbClose(botId, dbPos, avgPrice, exitOrderId);
    } catch (e) {
      logger.error(`[EntryOrderMonitor] ❌ Failed to close DB position from exit fill | bot=${botId} orderId=${exitOrderId} symbol=${symbol}: ${e?.message || e}`, e?.stack);
    }
  }

  async _finalizeDbClose(botId, position, avgPrice, exitOrderId) {
    // Determine reason
    const reason = (String(exitOrderId) === String(position.exit_order_id)) ? 'tp_hit' : 'sl_hit';
    const closePrice = Number.isFinite(Number(avgPrice)) && Number(avgPrice) > 0 ? Number(avgPrice) : Number(position.take_profit_price || position.stoploss_price || position.entry_price);

    const pnl = calculatePnL(position.entry_price, closePrice, position.amount, position.side);

    // Close in DB
    const closed = await Position.close(position.id, closePrice, pnl, reason);
    logger.info(`[EntryOrderMonitor] ✅ Closed DB position ${position.id} via WS exit fill | reason=${reason} closePrice=${closePrice} pnl=${pnl}`);

    // Telegram notify
    try {
      const positionService = await this._getPositionServiceForBot(botId);
      if (positionService?.sendTelegramCloseNotification) {
        await positionService.sendTelegramCloseNotification(closed);
      } else {
        // fallback direct telegram
        if (this.telegramService?.sendCloseSummaryAlert) {
          const stats = await Position.getBotStats(closed.bot_id);
          await this.telegramService.sendCloseSummaryAlert(closed, stats);
        }
      }
    } catch (notifyErr) {
      logger.error(`[EntryOrderMonitor] Failed to send Telegram close alert for position ${position.id}: ${notifyErr?.message || notifyErr}`);
    }

    // CRITICAL: Cancel all pending orders for this symbol to prevent hanging orders
    // This ensures that when a position is closed via websocket, any pending entry orders
    // or other pending orders for the same symbol are cancelled to avoid order hanging
    try {
      await this._cancelPendingOrdersForSymbol(botId, position.symbol, position.id);
    } catch (cancelErr) {
      // Non-critical: log error but don't fail position close
      logger.warn(`[EntryOrderMonitor] Failed to cancel pending orders for symbol ${position.symbol} after position ${position.id} close: ${cancelErr?.message || cancelErr}`);
    }

    return closed;
  }

  /**
   * Cancel all pending orders for a symbol after position is closed
   * This prevents orders from hanging when position is closed via websocket
   * CRITICAL: This function cancels ALL pending orders for the symbol, including:
   * - Entry orders (LIMIT, MARKET)
   * - TP orders (TAKE_PROFIT_MARKET, TAKE_PROFIT)
   * - SL orders (STOP_MARKET, STOP, STOP_LOSS_LIMIT)
   * - Any other pending orders
   * This ensures no orders are left hanging after position closure
   * @param {number} botId - Bot ID
   * @param {string} symbol - Symbol (e.g., 'BTCUSDT')
   * @param {number|null} closedPositionId - Closed position ID (for logging, null if position not found in DB)
   */
  async _cancelPendingOrdersForSymbol(botId, symbol, closedPositionId) {
    try {
      const exchangeService = this.exchangeServices.get(botId);
      if (!exchangeService) {
        logger.debug(`[EntryOrderMonitor] ExchangeService not found for bot ${botId}, skipping pending order cancellation for ${symbol}`);
        return;
      }

      // Get all open orders for this symbol
      const openOrders = await exchangeService.getOpenOrders(symbol);
      if (!Array.isArray(openOrders) || openOrders.length === 0) {
        const positionInfo = closedPositionId ? `position ${closedPositionId}` : 'exit order fill';
        logger.debug(`[EntryOrderMonitor] No open orders found for symbol ${symbol} after ${positionInfo}`);
        return;
      }

      // CRITICAL: Cancel ALL pending orders for this symbol, regardless of order type
      // This includes:
      // - Entry orders (LIMIT, MARKET)
      // - TP orders (TAKE_PROFIT_MARKET, TAKE_PROFIT)
      // - SL orders (STOP_MARKET, STOP, STOP_LOSS_LIMIT) - even if hard SL, position is closed so cancel them
      // - Any other pending orders
      // Filter pending orders (status: NEW, OPEN, or PARTIALLY_FILLED)
      // Exclude orders that are already filled or cancelled
      const pendingOrders = openOrders.filter(order => {
        const status = String(order?.status || '').toUpperCase();

        // Skip if order is already filled, cancelled, or expired
        if (status === 'FILLED' || status === 'CANCELED' || status === 'CANCELLED' || status === 'EXPIRED') {
          return false;
        }

        // Include NEW, OPEN, or PARTIALLY_FILLED orders
        // For PARTIALLY_FILLED, we still cancel to avoid hanging partial fills
        if (status === 'NEW' || status === 'OPEN' || status === 'PARTIALLY_FILLED') {
          return true;
        }

        // If status is unknown but order exists, include it to be safe
        // This ensures we don't miss any orders that might be in an unexpected state
        return true;
      });

      if (pendingOrders.length === 0) {
        const positionInfo = closedPositionId ? `position ${closedPositionId}` : 'exit order fill';
        logger.debug(`[EntryOrderMonitor] No pending orders to cancel for symbol ${symbol} after ${positionInfo}`);
        return;
      }

      const positionInfo = closedPositionId ? `position ${closedPositionId} close` : 'exit order fill';
      const orderTypes = pendingOrders.map(o => `${o.orderId || o.id}(${o.type || o.orderType || 'UNKNOWN'})`).join(', ');
      logger.info(
        `[EntryOrderMonitor] 🗑️ Cancelling ${pendingOrders.length} pending orders for symbol ${symbol} ` +
        `after ${positionInfo}. Orders: ${orderTypes}`
      );

      // Cancel all pending orders in parallel (with error handling)
      const cancelResults = await Promise.allSettled(
        pendingOrders.map(async (order) => {
          const orderId = String(order.orderId || order.id || '');
          const orderType = String(order?.type || order?.orderType || 'UNKNOWN').toUpperCase();
          if (!orderId) {
            logger.warn(`[EntryOrderMonitor] Skipping order cancellation: invalid orderId for order ${JSON.stringify(order)}`);
            return { success: false, orderId: 'invalid', error: 'Invalid orderId' };
          }

          try {
            await exchangeService.cancelOrder(orderId, symbol);
            const posInfo = closedPositionId ? `position ${closedPositionId} closed` : 'exit order filled';
            logger.info(`[EntryOrderMonitor] ✅ Cancelled pending order ${orderId} (${orderType}) for symbol ${symbol} (${posInfo})`);
            return { success: true, orderId };
          } catch (cancelError) {
            const errorMsg = cancelError?.message || String(cancelError);
            // Ignore "Unknown order" errors (order may have been filled/cancelled already)
            if (errorMsg.includes('Unknown order') || errorMsg.includes('not found') || errorMsg.includes('does not exist')) {
              logger.debug(`[EntryOrderMonitor] Order ${orderId} already cancelled/filled on exchange, skipping`);
              return { success: true, orderId, skipped: true };
            }
            logger.warn(`[EntryOrderMonitor] Failed to cancel pending order ${orderId} for symbol ${symbol}: ${errorMsg}`);
            return { success: false, orderId, error: errorMsg };
          }
        })
      );

      // Log summary
      const successful = cancelResults.filter(r => r.status === 'fulfilled' && r.value?.success).length;
      const failed = cancelResults.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value?.success)).length;
      const posInfo = closedPositionId ? `position ${closedPositionId} close` : 'exit order fill';
      
      if (failed > 0) {
        logger.warn(
          `[EntryOrderMonitor] ⚠️ Cancelled ${successful}/${pendingOrders.length} pending orders for symbol ${symbol} ` +
          `after ${posInfo} (${failed} failed)`
        );
      } else {
        logger.info(
          `[EntryOrderMonitor] ✅ Successfully cancelled ${successful} pending orders for symbol ${symbol} ` +
          `after ${posInfo}`
        );
      }
    } catch (error) {
      logger.error(
        `[EntryOrderMonitor] ❌ Error cancelling pending orders for symbol ${symbol} after position ${closedPositionId} close: ` +
        `${error?.message || error}`
      );
      throw error; // Re-throw to be caught by caller
    }
  }

  async _getPositionServiceForBot(botId) {
    if (this.positionServices && this.positionServices.has(botId)) {
      return this.positionServices.get(botId);
    }

    const exchangeService = this.exchangeServices.get(botId);
    if (!exchangeService) return null;

    // Lazy import to avoid circular deps
    const { PositionService } = await import('../services/PositionService.js');
    const svc = new PositionService(exchangeService, this.telegramService);

    if (this.positionServices) {
      this.positionServices.set(botId, svc);
    }

    return svc;
  }

  /**
   * Place TP order with retry mechanism and exponential backoff
   * Retry schedule: 200ms -> 500ms -> 1000ms (max 3 retries)
   * This ensures TP is always placed even if initial attempt fails due to network/rate limit issues
   * @param {ExitOrderManager} mgr - ExitOrderManager instance
   * @param {Object} position - Position object
   * @param {number} tpPrice - Take profit price
   * @returns {Promise<Object|null>} Result from placeOrReplaceExitOrder or null if all retries failed
   */
  async _placeTPWithRetry(mgr, position, tpPrice) {
    const maxRetries = 3;
    const retryDelays = [200, 500, 1000]; // ms: 200ms, 500ms, 1000ms
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await mgr.placeOrReplaceExitOrder(position, tpPrice);
        
        // Check if placement was successful (has orderId or shouldCloseImmediately flag)
        if (result?.orderId || result?.shouldCloseImmediately) {
          if (attempt > 0) {
            logger.info(
              `[EntryOrderMonitor] ✅ TP placement succeeded on retry attempt ${attempt + 1}/${maxRetries + 1} | ` +
              `pos=${position.id} symbol=${position.symbol} tpPrice=${tpPrice}`
            );
          }
          return result;
        }
        
        // If result is null but no error thrown, it might be a valid case (e.g., price too close to market)
        // But we still retry to ensure TP is placed
        if (result === null && attempt < maxRetries) {
          const delay = retryDelays[attempt] || 1000;
          logger.warn(
            `[EntryOrderMonitor] ⚠️ TP placement returned null (attempt ${attempt + 1}/${maxRetries + 1}) | ` +
            `pos=${position.id} symbol=${position.symbol} tpPrice=${tpPrice}. ` +
            `Retrying in ${delay}ms...`
          );
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        // If we've exhausted retries and result is still null, return null
        if (result === null) {
          logger.error(
            `[EntryOrderMonitor] ❌ TP placement returned null after ${maxRetries + 1} attempts | ` +
            `pos=${position.id} symbol=${position.symbol} tpPrice=${tpPrice}`
          );
          return null;
        }
        
        return result;
      } catch (error) {
        const errorMsg = error?.message || String(error);
        const isRetryable = !errorMsg.includes('shouldCloseImmediately') && 
                           !errorMsg.includes('position not open') &&
                           !errorMsg.includes('Invalid entry_price');
        
        if (attempt < maxRetries && isRetryable) {
          const delay = retryDelays[attempt] || 1000;
          logger.warn(
            `[EntryOrderMonitor] ⚠️ TP placement failed (attempt ${attempt + 1}/${maxRetries + 1}) | ` +
            `pos=${position.id} symbol=${position.symbol} error=${errorMsg}. ` +
            `Retrying in ${delay}ms...`
          );
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        // If error is not retryable or we've exhausted retries, throw/return
        if (!isRetryable) {
          logger.error(
            `[EntryOrderMonitor] ❌ TP placement failed with non-retryable error | ` +
            `pos=${position.id} symbol=${position.symbol} error=${errorMsg}`
          );
          throw error; // Re-throw non-retryable errors
        }
        
        // Last attempt failed
        logger.error(
          `[EntryOrderMonitor] ❌ TP placement failed after ${maxRetries + 1} attempts | ` +
          `pos=${position.id} symbol=${position.symbol} error=${errorMsg}`
        );
        throw error;
      }
    }
    
    return null; // Should never reach here, but just in case
  }

  /**
   * Find entry_pending position by botId and orderId
   * @param {number} botId
   * @param {number|string} orderId
   * @returns {Promise<Object|null>}
   */
  async _findEntryPendingPosition(botId, orderId) {
    try {
      const { default: pool } = await import('../config/database.js');
      const [rows] = await pool.execute(
        `SELECT * FROM positions WHERE bot_id = ? AND order_id = ? AND status = 'entry_pending' LIMIT 1`,
        [botId, String(orderId)]
      );
      return rows[0] || null;
    } catch (error) {
      logger.error(`[EntryOrderMonitor] Error finding entry_pending position: ${error?.message || error}`);
      return null;
    }
  }

  /**
   * Find position by order_id (entry order)
   * @param {number} botId
   * @param {number|string} orderId
   * @returns {Promise<Object|null>}
   */
  async _findPositionByOrderId(botId, orderId) {
    try {
      const { default: pool } = await import('../config/database.js');
      const [rows] = await pool.execute(
        `SELECT * FROM positions WHERE bot_id = ? AND order_id = ? LIMIT 1`,
        [botId, String(orderId)]
      );
      return rows[0] || null;
    } catch (error) {
      logger.error(`[EntryOrderMonitor] Error finding position by order_id: ${error?.message || error}`);
      return null;
    }
  }

  /**
   * Check if orderId matches exit_order_id or sl_order_id (exit order)
   * @param {number} botId
   * @param {number|string} orderId
   * @returns {Promise<boolean>}
   */
  async _isExitOrderId(botId, orderId) {
    try {
      const { default: pool } = await import('../config/database.js');
      const [rows] = await pool.execute(
        `SELECT id FROM positions WHERE bot_id = ? AND (exit_order_id = ? OR sl_order_id = ?) AND status = 'open' LIMIT 1`,
        [botId, String(orderId), String(orderId)]
      );
      return rows.length > 0;
    } catch (error) {
      logger.error(`[EntryOrderMonitor] Error checking exit order: ${error?.message || error}`);
      return false;
    }
  }

  /**
   * Find an open DB position by botId + symbol.
   * Used for ACCOUNT_UPDATE-based close detection (manual close on exchange).
   * @param {number} botId
   * @param {string} symbol
   * @returns {Promise<Object|null>}
   */
  async _findOpenPosition(botId, symbol) {
    if (!botId || !symbol) return null;

    const normalized = String(symbol).replace(/_/g, '').toUpperCase();

    try {
      // Fast path: query open positions and match normalized symbol.
      const open = await Position.findOpen();
      for (const p of open) {
        if (Number(p?.bot_id) !== Number(botId)) continue;
        const dbSym = String(p?.symbol || '').replace(/_/g, '').toUpperCase();
        if (dbSym === normalized) return p;
      }
      return null;
    } catch (error) {
      logger.error(`[EntryOrderMonitor] Error finding open position for bot ${botId} symbol ${symbol}: ${error?.message || error}`);
      return null;
    }
  }

  /**
   * Handle Binance ACCOUNT_UPDATE user-data event.
   * Primary purpose here: detect manual closes on exchange and close DB position accordingly.
   * @param {number} botId
   * @param {Object} evt
   */
  async _handleBinanceAccountUpdate(botId, evt) {
    try {
      const e = evt?.e || evt?.eventType;
      if (e !== 'ACCOUNT_UPDATE') return;

      const a = evt?.a || evt?.account || null;
      const positions = a?.P || a?.positions || [];
      if (!Array.isArray(positions) || positions.length === 0) return;

      for (const p of positions) {
        const sym = p?.s || p?.symbol;
        const pa = p?.pa ?? p?.positionAmt;
        if (!sym) continue;

        const amt = Number(pa);
        // Binance futures: when position is closed, positionAmt becomes 0
        if (Number.isFinite(amt) && amt === 0) {
          const normalizedSymbol = String(sym).replace(/_/g, '');
          const dbPos = await this._findOpenPosition(botId, normalizedSymbol);
          if (!dbPos) continue;

          // We don't have reliable close price from ACCOUNT_UPDATE; best-effort using exit order avgPrice cache or last ticker
          let closePrice = Number(dbPos.take_profit_price || dbPos.stoploss_price || dbPos.entry_price);
          try {
            const exchangeService = this.exchangeServices.get(botId);
            if (exchangeService) {
              const px = await exchangeService.getTickerPrice(dbPos.symbol);
              if (Number.isFinite(px) && px > 0) closePrice = px;
            }
          } catch (_) {}

          const pnl = calculatePnL(dbPos.entry_price, closePrice, dbPos.amount, dbPos.side);
          const closed = await Position.close(dbPos.id, closePrice, pnl, 'exchange_manual_close');

          logger.info(`[EntryOrderMonitor] ✅ Closed DB position ${dbPos.id} via ACCOUNT_UPDATE (manual close) | symbol=${dbPos.symbol} closePrice=${closePrice} pnl=${pnl}`);

          // Telegram notify (best-effort)
          try {
            const positionService = await this._getPositionServiceForBot(botId);
            if (positionService?.sendTelegramCloseNotification) {
              await positionService.sendTelegramCloseNotification(closed);
            } else if (this.telegramService?.sendCloseSummaryAlert) {
              const stats = await Position.getBotStats(closed.bot_id);
              await this.telegramService.sendCloseSummaryAlert(closed, stats);
            }
          } catch (notifyErr) {
            logger.error(`[EntryOrderMonitor] Failed to send Telegram close alert for position ${dbPos.id} (ACCOUNT_UPDATE): ${notifyErr?.message || notifyErr}`);
          }

          // Cancel pending orders for safety
          try {
            await this._cancelPendingOrdersForSymbol(botId, dbPos.symbol, dbPos.id);
          } catch (cancelErr) {
            logger.warn(`[EntryOrderMonitor] Failed to cancel pending orders for ${dbPos.symbol} after ACCOUNT_UPDATE close: ${cancelErr?.message || cancelErr}`);
          }
        }
      }
    } catch (error) {
      logger.error(`[EntryOrderMonitor] Error in _handleBinanceAccountUpdate for bot ${botId}: ${error?.message || error}`, error?.stack);
    }
  }

  /**
   * Confirm entry fill: promote entry_pending position to open
   * IDEMPOTENT: Checks if position is already open before updating
   * @param {Object} position - Position object with status='entry_pending'
   * @param {number|null} overrideEntryPrice - Optional override entry price from WS/REST
   * @returns {Promise<Object>} Updated position
   */
  async _confirmEntryFill(position, overrideEntryPrice = null) {
    try {
      // IDEMPOTENCY GUARD: Check if position is already open
      if (position.status === 'open') {
        logger.debug(`[EntryOrderMonitor] Position ${position.id} already open, skipping promotion.`);
        return position;
      }

      // Validate position is entry_pending
      if (position.status !== 'entry_pending') {
        logger.warn(`[EntryOrderMonitor] Position ${position.id} status is '${position.status}', expected 'entry_pending'. Skipping.`);
        return position;
      }

      // Update entry_price if override provided and valid
      const updates = { status: 'open' };
      if (Number.isFinite(overrideEntryPrice) && overrideEntryPrice > 0) {
        updates.entry_price = overrideEntryPrice;
        logger.debug(`[EntryOrderMonitor] Updating entry_price to ${overrideEntryPrice} for position ${position.id}`);
      }

      // Update position status to 'open'
      const updated = await Position.update(position.id, updates);
      logger.info(`[EntryOrderMonitor] ✅ Promoted entry_pending position ${position.id} to 'open' (orderId=${position.order_id}, ${position.symbol})`);

      // Send Telegram notification
      try {
        const { Strategy } = await import('../models/Strategy.js');
        const strategy = await Strategy.findById(position.strategy_id);
        if (strategy && this.telegramService?.sendEntryTradeAlert) {
          await this.telegramService.sendEntryTradeAlert(updated, strategy, strategy.oc);
          logger.info(`[EntryOrderMonitor] ✅ Entry trade alert sent for Position ${updated.id}`);
        }
      } catch (notifyErr) {
        logger.warn(`[EntryOrderMonitor] Failed to send Telegram notification for Position ${position.id}: ${notifyErr?.message || notifyErr}`);
      }

      return updated;
    } catch (error) {
      logger.error(`[EntryOrderMonitor] Error confirming entry fill for position ${position.id}: ${error?.message || error}`, error?.stack);
      throw error;
    }
  }

  /**
   * Fallback polling using REST for all exchanges
   */
  async pollEntryPendingPositions() {
    try {
      // New flow: poll positions that are waiting for entry fill confirmation
      const pendingPositions = await Position.findAll({ status: 'entry_pending' });
      if (!pendingPositions.length) return;

      logger.debug(`[EntryOrderMonitor] Polling ${pendingPositions.length} entry_pending positions via REST.`);

      // RATE-LIMIT GUARD: Process entries in batches with delay to avoid overwhelming exchange API
      const batchSize = Number(configService.getNumber('ENTRY_ORDER_POLL_BATCH_SIZE', 10));
      const batchDelayMs = Number(configService.getNumber('ENTRY_ORDER_POLL_BATCH_DELAY_MS', 1000));
      
      for (let i = 0; i < pendingPositions.length; i += batchSize) {
        const batch = pendingPositions.slice(i, i + batchSize);
        
        // Process batch with Promise.allSettled to handle errors gracefully
        await Promise.allSettled(
          batch.map(pos => this._pollSingleEntryPendingPosition(pos))
        );
        
        // Delay between batches to avoid rate limits
        if (i + batchSize < pendingPositions.length && batchDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, batchDelayMs));
        }
      }
    } catch (error) {
      logger.error('[EntryOrderMonitor] Error in pollEntryPendingPositions:', error?.message || error);
    }
  }

  /**
   * Poll a single entry order (extracted for batch processing)
   * @param {Object} entry - Entry order object
   */
  async _pollSingleEntryPendingPosition(position) {
        try {
          const exchangeService = this.exchangeServices.get(position.bot_id);
          if (!exchangeService) return;

          const st = await exchangeService.getOrderStatus(position.symbol, position.order_id);
          const status = (st?.status || '').toLowerCase();
          const filled = Number(st?.filled || 0);

          if ((status === 'closed' || status === 'filled') && filled > 0) {
            // Confirmed filled via REST: promote to open
            await this._confirmEntryFill(position, null);
          } else if ((status === 'canceled' || status === 'cancelled' || status === 'expired') && filled === 0) {
            await Position.update(position.id, { status: 'cancelled', close_reason: 'entry_order_canceled', closed_at: new Date() });
            logger.debug(`[EntryOrderMonitor] entry_pending position ${position.id} (orderId=${position.order_id}, ${position.symbol}) canceled/expired via REST polling.`);
          } else {
        // TTL-based auto-cancel for stale pending entry positions
        const ttlMinutes = Number(configService.getNumber('ENTRY_ORDER_TTL_MINUTES', 30));
        const ttlMs = Math.max(1, ttlMinutes) * 60 * 1000;
        const createdAtMs = new Date(position.opened_at || position.created_at || Date.now()).getTime();
        const now = Date.now();

        if (!Number.isNaN(createdAtMs) && now - createdAtMs >= ttlMs) {
          try {
            const recheckStatus = await exchangeService.getOrderStatus(position.symbol, position.order_id);
            const recheckStatusLower = (recheckStatus?.status || '').toLowerCase();
            const recheckFilled = Number(recheckStatus?.filled || 0);
            
            if ((recheckStatusLower === 'closed' || recheckStatusLower === 'filled') && recheckFilled > 0) {
              logger.info(`[EntryOrderMonitor] Position ${position.id} was FILLED during TTL check. Promoting to 'open'.`);
              await this._confirmEntryFill(position, null);
              return; // Skip cancellation
            }
            
            try {
              await exchangeService.cancelOrder(position.order_id, position.symbol);
            } catch (cancelErr) {
              logger.warn(`[EntryOrderMonitor] Failed to cancel stale entry order ${position.order_id} on exchange: ${cancelErr?.message || cancelErr}`);
            }

            await Position.update(position.id, { status: 'cancelled', close_reason: 'entry_order_ttl', closed_at: new Date() });
            logger.info(`[EntryOrderMonitor] ⏱️ Auto-canceled stale entry position ${position.id} (orderId=${position.order_id}) after TTL.`);
          } catch (recheckErr) {
            logger.warn(`[EntryOrderMonitor] Failed to re-check order status before TTL cancel for position ${position.id}: ${recheckErr?.message || recheckErr}`);
          }
        }
      }
    } catch (inner) {
      logger.warn(`[EntryOrderMonitor] Failed to poll entry_pending position ${position.id} (${position.symbol}): ${inner?.message || inner}`);
    }
  }

  /**
   * Confirm entry order by creating Position and marking entry_orders as filled
   * IDEMPOTENT: Checks for existing Position before creating to prevent duplicates
   * @param {number} botId
   * @param {Object} entry
   * @param {number|null} overrideEntryPrice
   */
  // Deprecated: EntryOrder-based flow. Kept for backward compatibility during rollout.
  async _confirmEntryWithPosition(botId, entry, overrideEntryPrice = null) {
    try {
      // IDEMPOTENCY GUARD: Check if Position already exists for this order_id
      // This prevents duplicate Position creation when WS and REST both detect FILLED
      // or when WS sends duplicate events
      const { pool } = await import('../config/database.js');
      const [existingPositions] = await pool.execute(
        `SELECT id, status, exit_order_id FROM positions WHERE bot_id = ? AND order_id = ? LIMIT 1`,
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
        
        // ✅ CRITICAL: Nếu Position đã tồn tại nhưng chưa có TP (exit_order_id = null), tạo TP ngay lập tức
        // Điều này xử lý trường hợp Position được tạo từ nguồn khác (ví dụ: PositionMonitor) nhưng chưa có TP
        if (existing.status === 'open' && !existing.exit_order_id) {
          try {
            const exchangeService = this.exchangeServices.get(botId);
            if (exchangeService) {
              const { Position } = await import('../models/Position.js');
              const existingPosition = await Position.findById(existing.id);
              if (existingPosition && existingPosition.take_profit_price && Number.isFinite(existingPosition.take_profit_price) && existingPosition.take_profit_price > 0) {
                const { ExitOrderManager } = await import('../services/ExitOrderManager.js');
                const mgr = new ExitOrderManager(exchangeService);
                logger.info(
                  `[EntryOrderMonitor] 🚀 Creating TP for existing position without TP | pos=${existing.id} ` +
                  `symbol=${existingPosition.symbol} tpPrice=${existingPosition.take_profit_price}`
                );
                const placed = await mgr.placeOrReplaceExitOrder(existingPosition, existingPosition.take_profit_price);
                const tpOrderId = placed?.orderId ? String(placed.orderId) : null;
                if (tpOrderId) {
                  await Position.update(existing.id, { 
                    exit_order_id: tpOrderId,
                    tp_sl_pending: false
                  });
                  logger.info(`[EntryOrderMonitor] ✅ TP created for existing position ${existing.id} exit_order_id=${tpOrderId}`);
                }
              }
            }
          } catch (tpErr) {
            logger.error(
              `[EntryOrderMonitor] ❌ Failed to create TP for existing position ${existing.id}:`,
              tpErr?.message || tpErr
            );
          }
        }
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

      // NEW: Place TP immediately after entry is filled (do not wait for PositionMonitor interval)
      // This anchors a TP on the exchange ASAP to reduce risk in highly volatile markets.
      try {
        const exchangeService = this.exchangeServices.get(botId);

        // Only attempt if we have a valid TP price (strategy.take_profit might be 0/disabled)
        if (exchangeService && tpPrice && Number.isFinite(tpPrice) && tpPrice > 0) {
          const { ExitOrderManager } = await import('../services/ExitOrderManager.js');
          const mgr = new ExitOrderManager(exchangeService);

          logger.info(
            `[EntryOrderMonitor] 🚀 Immediate TP placement after fill | pos=${position.id} ` +
            `symbol=${position.symbol} side=${position.side} tpPrice=${tpPrice} entry=${effectiveEntryPrice}`
          );

          // CRITICAL: Use retry mechanism with exponential backoff to ensure TP is always placed
          // Retry schedule: 200ms -> 500ms -> 1000ms (max 3 retries)
          const placed = await this._placeTPWithRetry(mgr, position, tpPrice);
          const tpOrderId = placed?.orderId ? String(placed.orderId) : null;

          if (tpOrderId) {
            // ✅ CRITICAL: Update position với exit_order_id ngay lập tức để tránh PositionMonitor tạo duplicate TP
            // ✅ Set tp_sl_pending=false vì TP đã được tạo, chỉ còn SL cần tạo
            await Position.update(position.id, { 
              exit_order_id: tpOrderId,
              tp_sl_pending: false // TP đã được tạo, chỉ còn SL cần PositionMonitor tạo
            });
            logger.info(
              `[EntryOrderMonitor] ✅ Immediate TP placed | pos=${position.id} exit_order_id=${tpOrderId} ` +
              `type=${placed?.orderType || 'n/a'} stopPrice=${placed?.stopPrice || tpPrice}`
            );
          } else {
            // ⚠️ Nếu TP placement failed sau tất cả retries, giữ tp_sl_pending=true để PositionMonitor retry
            logger.warn(
              `[EntryOrderMonitor] ⚠️ Immediate TP placement failed after all retries | pos=${position.id} symbol=${position.symbol} tpPrice=${tpPrice}. ` +
              `PositionMonitor will retry on next cycle.`
            );
          }
        } else {
          logger.debug(
            `[EntryOrderMonitor] Immediate TP not placed (no exchangeService or invalid tpPrice) | ` +
            `pos=${position?.id || 'n/a'} botId=${botId} tpPrice=${tpPrice}`
          );
        }
      } catch (tpErr) {
        logger.error(
          `[EntryOrderMonitor] ❌ Immediate TP placement failed | pos=${position?.id || 'n/a'} ` +
          `error=${tpErr?.message || tpErr}`
        );
      }

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
      await this.pollEntryPendingPositions();
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


