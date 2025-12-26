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
    this._lastLogTime = null; // For throttling debug logs
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
        await this.addBot(bots[i]);
        // Add delay between bot initializations to avoid CPU spike
        if (i < bots.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 600)); // 600ms delay
        }
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
   * Uses soft lock to prevent race conditions when multiple instances run concurrently.
   * @param {Object} position - Position object
   */
  async placeExitOrder(position) {
    // Skip if position is not open
    if (position.status !== 'open') {
      return;
    }

    // RACE CONDITION FIX: Use soft lock to prevent concurrent TP/SL placement
    // Try to acquire lock by setting is_processing flag
    try {
      const { pool } = await import('../config/database.js');
      const [result] = await pool.execute(
        `UPDATE positions 
         SET is_processing = 1 
         WHERE id = ? AND status = 'open' AND (is_processing = 0 OR is_processing IS NULL)
         LIMIT 1`,
        [position.id]
      );
      
      // If no rows updated, another process is already handling this position
      if (result.affectedRows === 0) {
        logger.debug(`[Place TP/SL] Position ${position.id} is already being processed by another instance, skipping...`);
        return;
      }
    } catch (lockError) {
      // If is_processing column doesn't exist, continue without lock (backward compatibility)
      logger.debug(`[Place TP/SL] Could not acquire lock for position ${position.id} (column may not exist): ${lockError?.message || lockError}`);
    }

    // Check if TP/SL orders still exist on exchange
    // If exit_order_id exists in DB but order is not on exchange (filled/canceled), we should recreate it
    // CRITICAL FIX: Also check tp_sl_pending flag - if true, we need to place TP/SL even if exit_order_id exists
    const isTPSLPending = position.tp_sl_pending === true || position.tp_sl_pending === 1;
    let needsTp = !position.exit_order_id || isTPSLPending;
    let needsSl = !position.sl_order_id || isTPSLPending;

    // If exit_order_id exists, verify it's still active on exchange
    if (position.exit_order_id) {
      try {
        const exchangeService = this.exchangeServices.get(position.bot_id);
        if (exchangeService) {
          const orderStatus = await exchangeService.getOrderStatus(position.symbol, position.exit_order_id);
          const status = (orderStatus?.status || '').toLowerCase();
          // If order is filled, canceled, or expired, we need to recreate it
          if (status === 'filled' || status === 'canceled' || status === 'cancelled' || status === 'expired') {
            logger.warn(`[Place TP/SL] TP order ${position.exit_order_id} for position ${position.id} is ${status} on exchange, will recreate`);
            needsTp = true;
            // Clear exit_order_id in DB so we can recreate
            await Position.update(position.id, { exit_order_id: null });
            position.exit_order_id = null;
          }
        }
      } catch (e) {
        // If we can't check order status, assume it might be missing and try to recreate
        logger.warn(`[Place TP/SL] Could not verify TP order ${position.exit_order_id} for position ${position.id}: ${e?.message || e}. Will try to recreate.`);
        needsTp = true;
        await Position.update(position.id, { exit_order_id: null });
        position.exit_order_id = null;
      }
    }

    // If sl_order_id exists, verify it's still active on exchange
    if (position.sl_order_id) {
      try {
        const exchangeService = this.exchangeServices.get(position.bot_id);
        if (exchangeService) {
          const orderStatus = await exchangeService.getOrderStatus(position.symbol, position.sl_order_id);
          const status = (orderStatus?.status || '').toLowerCase();
          // If order is filled, canceled, or expired, we need to recreate it
          if (status === 'filled' || status === 'canceled' || status === 'cancelled' || status === 'expired') {
            logger.warn(`[Place TP/SL] SL order ${position.sl_order_id} for position ${position.id} is ${status} on exchange, will recreate`);
            needsSl = true;
            // Clear sl_order_id in DB so we can recreate
            await Position.update(position.id, { sl_order_id: null });
            position.sl_order_id = null;
          }
        }
      } catch (e) {
        // If we can't check order status, assume it might be missing and try to recreate
        logger.warn(`[Place TP/SL] Could not verify SL order ${position.sl_order_id} for position ${position.id}: ${e?.message || e}. Will try to recreate.`);
        needsSl = true;
        await Position.update(position.id, { sl_order_id: null });
        position.sl_order_id = null;
      }
    }

    // --- De-duplicate safety (Binance): if exchange has multiple reduce-only close orders, keep only one TP + one SL ---
    try {
      const exchangeService = this.exchangeServices.get(position.bot_id);
      if (exchangeService && exchangeService.bot?.exchange === 'binance') {
        await this._dedupeCloseOrdersOnExchange(exchangeService, position);
      }
    } catch (e) {
      logger.debug(`[Place TP/SL] Dedupe open orders skipped/failed for position ${position.id}: ${e?.message || e}`);
    }

    // Skip if both TP and SL already exist and are active, AND tp_sl_pending is false
    if (!needsTp && !needsSl && !isTPSLPending) {
      // Release lock before returning
      await this._releasePositionLock(position.id);
      return;
    }
    
    // If tp_sl_pending is true but we have both orders, clear the flag
    if (isTPSLPending && position.exit_order_id && (!needsSl || position.sl_order_id)) {
      // Both orders exist, clear pending flag
      await Position.update(position.id, { tp_sl_pending: false });
      logger.debug(`[Place TP/SL] Cleared tp_sl_pending flag for position ${position.id} (both TP and SL exist)`);
      await this._releasePositionLock(position.id);
      return;
    }

    try {
      const exchangeService = this.exchangeServices.get(position.bot_id);
      if (!exchangeService) {
        logger.warn(`[Place TP/SL] ExchangeService not found for bot ${position.bot_id}`);
        // Release lock before returning
        await this._releasePositionLock(position.id);
        return;
      }

      // Get the actual fill price from the exchange (abstract method, not exchange-specific)
      let fillPrice = await exchangeService.getOrderAverageFillPrice(position.symbol, position.order_id);
      if (!fillPrice || !Number.isFinite(fillPrice) || fillPrice <= 0) {
        // Fallback to position.entry_price if available
        if (position.entry_price && Number.isFinite(Number(position.entry_price)) && Number(position.entry_price) > 0) {
          fillPrice = Number(position.entry_price);
          logger.info(`[Place TP/SL] Could not get fill price from exchange for position ${position.id}, using entry_price from DB: ${fillPrice}`);
        } else {
          logger.warn(`[Place TP/SL] Could not get fill price for position ${position.id} (order_id=${position.order_id}), will retry.`);
          // Release lock before returning
          await this._releasePositionLock(position.id);
          return;
        }
      } else {
        // Update position with the real entry price
        await Position.update(position.id, { entry_price: fillPrice });
        position.entry_price = fillPrice;
        logger.info(`[Place TP/SL] Updated position ${position.id} with actual fill price: ${fillPrice}`);
      }

      // Get strategy to access oc, take_profit, stoploss
      const strategy = await Strategy.findById(position.strategy_id);
      if (!strategy) {
        logger.warn(`[Place TP/SL] Strategy ${position.strategy_id} not found for position ${position.id}`);
        return;
      }

      // Recalculate TP/SL based on the real entry price
      const { calculateTakeProfit, calculateInitialStopLoss } = await import('../utils/calculator.js');
      const oc = strategy.oc || position.oc || 1; // Fallback to position.oc if available, then default to 1
      
      // CRITICAL FIX: Don't fallback to 50 if strategy.take_profit is explicitly 0 (disabled)
      // Only use fallback if take_profit is undefined/null, not if it's 0
      let takeProfit;
      if (strategy.take_profit !== undefined && strategy.take_profit !== null) {
        takeProfit = Number(strategy.take_profit);
      } else if (position.take_profit !== undefined && position.take_profit !== null) {
        takeProfit = Number(position.take_profit);
      } else {
        takeProfit = 50; // Default only if both are undefined/null
      }
      
      // If take_profit is 0 or invalid, skip TP calculation
      if (!Number.isFinite(takeProfit) || takeProfit <= 0) {
        logger.warn(`[Place TP/SL] Invalid take_profit (${takeProfit}) for position ${position.id}, skipping TP order placement`);
        takeProfit = null;
      }
      
      const tpPrice = takeProfit ? calculateTakeProfit(fillPrice, takeProfit, position.side) : null;
      
      // Only set SL if strategy.stoploss > 0. No fallback to reduce/up_reduce
      const rawStoploss = strategy.stoploss !== undefined ? Number(strategy.stoploss) : (position.stoploss !== undefined ? Number(position.stoploss) : NaN);
      const isStoplossValid = Number.isFinite(rawStoploss) && rawStoploss > 0;
      const slPrice = isStoplossValid ? calculateInitialStopLoss(fillPrice, rawStoploss, position.side) : null;

      // Get the exact quantity of the position
      const quantity = await exchangeService.getClosableQuantity(position.symbol, position.side);
      if (!quantity || quantity <= 0) {
        logger.warn(`[Place TP/SL] No closable quantity found for position ${position.id}, cannot place TP/SL.`);
        // Release lock before returning
        await this._releasePositionLock(position.id);
        return;
      }

      // Check quantity mismatch with DB amount (warn if significant difference)
      const dbAmount = parseFloat(position.amount || 0);
      const markPrice = parseFloat(position.entry_price || fillPrice || 0);
      const estimatedQuantity = markPrice > 0 ? dbAmount / markPrice : 0;
      const quantityDiffPercent = estimatedQuantity > 0 ? Math.abs((quantity - estimatedQuantity) / estimatedQuantity) * 100 : 0;
      
      if (quantityDiffPercent > 10) { // More than 10% difference
        logger.warn(
          `[Place TP/SL] Quantity mismatch for position ${position.id}: ` +
          `DB estimated=${estimatedQuantity.toFixed(4)}, Exchange=${quantity.toFixed(4)}, diff=${quantityDiffPercent.toFixed(2)}%`
        );
      }

      // Place TP order if needed and tpPrice is valid
      if (needsTp && tpPrice && Number.isFinite(tpPrice) && tpPrice > 0) {
        try {
          // CRITICAL: Only update initial_tp_price if it's not already set (preserve original initial TP)
          const currentPosition = await Position.findById(position.id);
          const shouldPreserveInitialTP = currentPosition?.initial_tp_price && 
                                          Number.isFinite(Number(currentPosition.initial_tp_price)) && 
                                          Number(currentPosition.initial_tp_price) > 0;
          
          // ✅ Unified exit order: type switches based on profit/loss zone (STOP_MARKET <-> TAKE_PROFIT_MARKET)
          const { ExitOrderManager } = await import('../services/ExitOrderManager.js');
          const mgr = new ExitOrderManager(exchangeService);
          const placed = await mgr.placeOrReplaceExitOrder(position, tpPrice);
          const tpOrderId = placed?.orderId ? String(placed.orderId) : null;
          if (tpOrderId) {
            // Store initial TP price for trailing calculation (only if not already set)
            const updateData = { 
              exit_order_id: tpOrderId, 
              take_profit_price: tpPrice,
              tp_sl_pending: false // Clear pending flag after successful EXIT placement
            };
            if (!shouldPreserveInitialTP) {
              updateData.initial_tp_price = tpPrice; // Only set if not already set
            }
            await Position.update(position.id, updateData);
            logger.info(`[Place TP/SL] ✅ Placed EXIT order ${tpOrderId} for position ${position.id} @ ${tpPrice} ${shouldPreserveInitialTP ? '(preserved initial TP)' : '(initial TP)'}`);
          } else {
            // Order creation returned null (e.g., price too close to market)
            logger.warn(`[Place TP/SL] ⚠️ TP order creation returned null for position ${position.id} @ ${tpPrice}. Updating TP price in DB only.`);
            const updateData = { take_profit_price: tpPrice };
            if (!shouldPreserveInitialTP) {
              updateData.initial_tp_price = tpPrice; // Only set if not already set
            }
            await Position.update(position.id, updateData);
          }
        } catch (e) {
          // If TP order creation fails, still update take_profit_price in DB
          // This allows trailing TP to work even if orders can't be placed
          logger.error(`[Place TP/SL] ❌ Failed to create TP order for position ${position.id}:`, e?.message || e);
          logger.warn(`[Place TP/SL] Updating TP price in DB to ${tpPrice} for position ${position.id} (order not placed, trailing TP will still work)`);
          try {
            const currentPosition = await Position.findById(position.id);
            const shouldPreserveInitialTP = currentPosition?.initial_tp_price && 
                                            Number.isFinite(Number(currentPosition.initial_tp_price)) && 
                                            Number(currentPosition.initial_tp_price) > 0;
            const updateData = { take_profit_price: tpPrice };
            if (!shouldPreserveInitialTP) {
              updateData.initial_tp_price = tpPrice; // Only set if not already set
            }
            await Position.update(position.id, updateData);
          } catch (updateError) {
            logger.error(`[Place TP/SL] Failed to update TP price in DB:`, updateError?.message || updateError);
          }
        }
      } else if (needsTp && (!tpPrice || !Number.isFinite(tpPrice) || tpPrice <= 0)) {
        logger.warn(`[Place TP/SL] Cannot place TP order for position ${position.id}: invalid tpPrice (${tpPrice})`);
      }

      // Delay before placing SL order to avoid rate limits
      const delayMs = configService.getNumber('TP_SL_PLACEMENT_DELAY_MS', 10000);
      if (delayMs > 0) {
        logger.info(`[Place TP/SL] Waiting ${delayMs}ms before placing SL order for position ${position.id}...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      // Place SL order (only if slPrice is valid, i.e., stoploss > 0)
      if (needsSl && slPrice !== null && Number.isFinite(slPrice) && slPrice > 0) {
        // Safety check: If SL is invalid (SL <= entry for SHORT or SL >= entry for LONG), force close position immediately
        const entryPrice = Number(fillPrice);
        const slPriceNum = Number(slPrice);
        if (Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(slPriceNum) && slPriceNum > 0) {
          const isInvalidSL = (position.side === 'short' && slPriceNum <= entryPrice) || 
                             (position.side === 'long' && slPriceNum >= entryPrice);
          
          if (isInvalidSL) {
            logger.warn(`[Place TP/SL] Invalid SL detected for position ${position.id}: SL=${slPriceNum}, Entry=${entryPrice}, Side=${position.side}. Force closing position immediately to minimize risk.`);
            
            // Cancel TP order if any
            if (position.exit_order_id) {
              try {
                await exchangeService.cancelOrder(position.exit_order_id, position.symbol);
                logger.info(`[Place TP/SL] Cancelled TP order ${position.exit_order_id} for position ${position.id}`);
              } catch (e) {
                logger.warn(`[Place TP/SL] Failed to cancel TP order ${position.exit_order_id}: ${e?.message || e}`);
              }
            }
            
            // Force close position immediately with market order
            // REUSE existing PositionService instance instead of creating new one
            const positionService = this.positionServices.get(position.bot_id);
            if (!positionService) {
              logger.error(`[Place TP/SL] PositionService not found for bot ${position.bot_id}, cannot force close position ${position.id}`);
              await this._releasePositionLock(position.id);
              return;
            }
            const currentPrice = await exchangeService.getTickerPrice(position.symbol);
            const pnl = positionService.calculatePnL(position, currentPrice);
            await positionService.closePosition(position, currentPrice, pnl, 'sl_invalid');
            await this._releasePositionLock(position.id);
            return; // Exit early, position is closed
          }
        }
        
        try {
          const slRes = await exchangeService.createStopLossLimit(position.symbol, position.side, slPrice, quantity);
          const slOrderId = slRes?.orderId ? String(slRes.orderId) : null;
          if (slOrderId) {
            // Clear tp_sl_pending flag if both TP and SL are now placed
            const currentPosition = await Position.findById(position.id);
            const hasTP = currentPosition?.exit_order_id && currentPosition.exit_order_id.trim() !== '';
            const updateData = { 
              sl_order_id: slOrderId, 
              stop_loss_price: slPrice 
            };
            // Clear pending flag if both TP and SL are placed
            if (hasTP) {
              updateData.tp_sl_pending = false;
            }
            await Position.update(position.id, updateData);
            logger.debug(`[Place TP/SL] ✅ Placed SL order ${slOrderId} for position ${position.id} @ ${slPrice}`);
          }
        } catch (e) {
          logger.error(`[Place TP/SL] ❌ Failed to create SL order for position ${position.id}:`, e?.message || e);
        }
      } else if (slPrice === null || slPrice <= 0) {
        logger.debug(`[Place TP/SL] Skipping SL order placement for position ${position.id} (stoploss <= 0 or not set)`);
      }
    } catch (error) {
      logger.error(`[Place TP/SL] Error processing TP/SL for position ${position.id}:`, error?.message || error, error?.stack);
    } finally {
      // Always release lock in finally block
      await this._releasePositionLock(position.id);
    }
  }

  /**
   * Release soft lock for position
   * @param {number} positionId - Position ID
   */
  async _releasePositionLock(positionId) {
    try {
      const { pool } = await import('../config/database.js');
      await pool.execute(
        `UPDATE positions SET is_processing = 0 WHERE id = ?`,
        [positionId]
      );
    } catch (e) {
      // Ignore errors (column may not exist for backward compatibility)
      logger.debug(`[Place TP/SL] Could not release lock for position ${positionId}: ${e?.message || e}`);
    }
  }

  /**
   * Binance-only: remove duplicated close orders (TP/SL) to avoid order spam / Binance open-order limits.
   * Keeps at most 1 unified STOP_MARKET exit order (tracked by position.exit_order_id) and 1 STOP order (only if strategy stoploss enabled).
   * Also tries to keep the orders referenced by position.exit_order_id / position.sl_order_id (if present).
   */
  async _dedupeCloseOrdersOnExchange(exchangeService, position) {
    const symbol = position.symbol;
    const side = position.side;
    const desiredPositionSide = side === 'long' ? 'LONG' : 'SHORT';

    const openOrders = await exchangeService.getOpenOrders(symbol);
    if (!Array.isArray(openOrders) || openOrders.length <= 1) return;

    // Only consider close / reduce-only style orders
    const reduceOnlyOrders = openOrders.filter(o => {
      const isReduceOnly = o?.reduceOnly === true || o?.reduceOnly === 'true';
      const isClosePosition = o?.closePosition === true || o?.closePosition === 'true';
      const type = String(o?.type || '').toUpperCase();
      const isTpOrStop = type === 'STOP_MARKET' || type === 'TAKE_PROFIT_MARKET' || type === 'STOP' || type === 'STOP_LOSS' || type === 'STOP_LOSS_LIMIT';
      // Some responses don't include reduceOnly flag but include closePosition
      return (isReduceOnly || isClosePosition) && isTpOrStop;
    });

    if (reduceOnlyOrders.length <= 2) return;

    // Match positionSide if present (hedge mode)
    const scoped = reduceOnlyOrders.filter(o => {
      const ps = String(o?.positionSide || '').toUpperCase();
      return !ps || ps === desiredPositionSide;
    });

    if (scoped.length <= 2) return;

    // Unified exit order types
    const exitTypes = new Set(['STOP_MARKET', 'TAKE_PROFIT_MARKET']);
    const stopTypes = new Set(['STOP', 'STOP_LOSS', 'STOP_LOSS_LIMIT']);

    const keepIds = new Set();
    if (position.exit_order_id) keepIds.add(String(position.exit_order_id));
    if (position.sl_order_id) keepIds.add(String(position.sl_order_id));

    const byTimeAsc = [...scoped].sort((a, b) => Number(a?.time || a?.updateTime || a?.origTime || 0) - Number(b?.time || b?.updateTime || b?.origTime || 0));

    const exits = byTimeAsc.filter(o => exitTypes.has(String(o?.type || '').toUpperCase()));
    const stops = byTimeAsc.filter(o => stopTypes.has(String(o?.type || '').toUpperCase()));

    // Keep newest order of each class if not explicitly referenced
    const newestExit = exits.length ? exits[exits.length - 1] : null;
    const newestStop = stops.length ? stops[stops.length - 1] : null;
    if (newestExit?.orderId) keepIds.add(String(newestExit.orderId));
    if (newestStop?.orderId) keepIds.add(String(newestStop.orderId));

    const toCancel = scoped.filter(o => !keepIds.has(String(o?.orderId)));
    if (toCancel.length === 0) return;

    logger.warn(
      `[Place Exit] Detected ${scoped.length} reduce-only close orders on exchange for ${symbol} (${desiredPositionSide}). ` +
      `Cancelling ${toCancel.length} duplicates to enforce 1-exit-order invariant.`
    );

    for (const o of toCancel) {
      try {
        await exchangeService.cancelOrder(String(o.orderId), symbol);
      } catch (e) {
        logger.debug(`[Place TP/SL] Failed to cancel duplicate order ${o?.orderId} for ${symbol}: ${e?.message || e}`);
      }
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

      // TTL-based cancellation for ENTRY orders only (not TP/SL orders)
      // IMPORTANT: This only cancels position.order_id (entry order), NOT exit_order_id or sl_order_id
      // EntryOrderMonitor handles entry orders from entry_orders table, but this is a fallback
      // for positions that may still have an unfilled entry order_id
      // TP/SL orders (exit_order_id, sl_order_id) are NEVER cancelled by this TTL
      const ttlMinutes = Number(configService.getNumber('ENTRY_ORDER_TTL_MINUTES', 30));
      const ttlMs = Math.max(1, ttlMinutes) * 60 * 1000;
      const openedAtMs = new Date(position.opened_at).getTime();
      const now = Date.now();

      // Only check position.order_id (entry order), NOT exit_order_id or sl_order_id
      if (position.status === 'open' && position.order_id && now - openedAtMs >= ttlMs) {
        // Check actual order status on exchange to avoid cancelling filled orders
        // This is the ENTRY order, not TP/SL orders
        const st = await exchangeService.getOrderStatus(position.symbol, position.order_id);
        if (st.status === 'open' && (st.filled || 0) === 0) {
          // Only cancel entry order, never cancel TP/SL orders here
          await orderService.cancelOrder(position, 'ttl_expired');
          logger.debug(`[PositionMonitor] Cancelled unfilled ENTRY order (order_id=${position.order_id}, TTL ${ttlMinutes}m) for position ${position.id}. TP/SL orders are NOT affected.`);
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
                  logger.debug(`Recreated entry order for position ${position.id} (${position.symbol}) after manual cancel. New order_id=${newOrder.id}`);
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
      
      // Ensure WebSocket subscriptions for all position symbols (Binance)
      try {
        const { webSocketManager } = await import('../services/WebSocketManager.js');
        const binanceSymbols = new Set();
        for (const pos of openPositions) {
          if (pos.bot_id) {
            const exchangeService = this.exchangeServices.get(pos.bot_id);
            if (exchangeService && exchangeService.bot?.exchange === 'binance') {
              binanceSymbols.add(pos.symbol.toUpperCase());
            }
          }
        }
        if (binanceSymbols.size > 0) {
          webSocketManager.subscribe(Array.from(binanceSymbols));
          logger.debug(`[PositionMonitor] Ensured WebSocket subscriptions for ${binanceSymbols.size} Binance symbols`);
        }
      } catch (e) {
        logger.debug(`[PositionMonitor] Failed to ensure WebSocket subscriptions: ${e?.message || e}`);
      }

      // Process positions in batches (reduced to avoid rate limits)
      const batchSize = Number(configService.getNumber('POSITION_MONITOR_BATCH_SIZE', 3)); // Reduced from 5 to 3
      for (let i = 0; i < openPositions.length; i += batchSize) {
        const batch = openPositions.slice(i, i + batchSize);
        
        // First, try to place TP/SL for new positions that might be missing them
        await Promise.allSettled(
          batch.map(p => this.placeExitOrder(p))
        );

        // Then, monitor positions (update dynamic SL, check for TP/SL hit)
        // Process sequentially with delay to avoid rate limits
        for (const position of batch) {
          await this.monitorPosition(position);
          // Small delay between each position to avoid rate limits
          const positionDelayMs = Number(configService.getNumber('POSITION_MONITOR_POSITION_DELAY_MS', 500));
          if (positionDelayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, positionDelayMs));
          }
        }

        // Check for other order management tasks
        await Promise.allSettled(
          batch.map(p => this.checkUnfilledOrders(p))
        );

        // Increased delay between batches to avoid rate limits
        if (i + batchSize < openPositions.length) {
          const delayMs = Number(configService.getNumber('POSITION_MONITOR_BATCH_DELAY_MS', 2000)); // Increased from 500ms to 2s
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }

      // Only log if there are positions or if it's been a while since last log
      if (openPositions.length > 0 || !this._lastLogTime || (Date.now() - this._lastLogTime) > 60000) {
        logger.debug(`Monitored ${openPositions.length} open positions`);
        this._lastLogTime = Date.now();
      }
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
