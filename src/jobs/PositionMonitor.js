import { Position } from '../models/Position.js';
import { Strategy } from '../models/Strategy.js';
import { ExchangeService } from '../services/ExchangeService.js';
import { PositionService } from '../services/PositionService.js';
import { OrderService } from '../services/OrderService.js';
import { TelegramService } from '../services/TelegramService.js';
import { SCAN_INTERVALS } from '../config/constants.js';
import { configService } from '../services/ConfigService.js';
import logger from '../utils/logger.js';
import { ScanCycleCache } from '../utils/ScanCycleCache.js';

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

    // Scan-cycle caches (cleared at the start of every monitorAllPositions run)
    this._scanCache = new ScanCycleCache();
    this._priceCache = new ScanCycleCache();
    this._closableQtyCache = new ScanCycleCache();
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

      const positionService = new PositionService(exchangeService, this.telegramService, {
        scanCache: this._scanCache,
        priceCache: this._priceCache,
        closableQtyCache: this._closableQtyCache
      });
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
      const botId = position.bot_id || position.strategy?.bot_id;
      const positionService = this.positionServices.get(botId);
      if (!positionService) {
        logger.warn(`PositionService not found for position ${position.id}`);
        return;
      }

      // Scan-cycle cache: avoid reprocessing the same position multiple times per cycle
      const scanKey = `monitor:${position.id}`;
      if (this._scanCache.has(scanKey)) {
        return;
      }
      this._scanCache.set(scanKey, true);

      // Update position (checks TP/SL and updates dynamic SL)
      const updated = await positionService.updatePosition(position);

      // positionService.updatePosition() may return null/undefined on failure (e.g., network timeout)
      if (!updated) {
        logger.warn(`Position ${position.id}: updatePosition returned null/undefined (skipping status check)`);
        return;
      }

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

    // CRITICAL SAFETY CHECK: If position has been open > 30s without TP/SL, force create immediately
    // This prevents positions from being exposed to market risk without protection
    const SAFETY_CHECK_MS = 30000; // 30 seconds
    if (position.opened_at) {
      const openedAt = new Date(position.opened_at).getTime();
      const timeSinceOpened = Date.now() - openedAt;
      const hasTPSL = position.exit_order_id && position.sl_order_id;
      
      if (timeSinceOpened > SAFETY_CHECK_MS && !hasTPSL) {
        logger.error(
          `[Place TP/SL] 🚨 CRITICAL SAFETY CHECK: Position ${position.id} (${position.symbol}) has been open for ` +
          `${Math.floor(timeSinceOpened / 1000)}s without TP/SL! ` +
          `exit_order_id=${position.exit_order_id || 'NULL'}, sl_order_id=${position.sl_order_id || 'NULL'}. ` +
          `FORCING immediate TP/SL creation to prevent deep loss or missed profit!`
        );
        // Force set tp_sl_pending to ensure TP/SL creation
        try {
          if (Position?.rawAttributes?.tp_sl_pending) {
            await Position.update(position.id, { tp_sl_pending: true });
            position.tp_sl_pending = true;
          }
        } catch (e) {
          logger.debug(`[Place TP/SL] Could not set tp_sl_pending flag: ${e?.message || e}`);
        }
      }
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

    // Skip if both TP and SL already exist and are active, AND tp_sl_pending is false
    if (!needsTp && !needsSl && !isTPSLPending) {
      // Release lock before returning
      await this._releasePositionLock(position.id);
      return;
    }
    
    // If tp_sl_pending is true but we have both orders, clear the flag
    if (isTPSLPending && position.exit_order_id && (!needsSl || position.sl_order_id)) {
      // Both orders exist, clear pending flag (only if column exists)
      try {
        if (Position?.rawAttributes?.tp_sl_pending) {
      await Position.update(position.id, { tp_sl_pending: false });
      logger.debug(`[Place TP/SL] Cleared tp_sl_pending flag for position ${position.id} (both TP and SL exist)`);
        } else {
          logger.debug(`[Place TP/SL] Skipped clearing tp_sl_pending (column not supported) for position ${position.id}`);
        }
      } catch (e) {
        logger.debug(`[Place TP/SL] Failed to clear tp_sl_pending flag (column may not exist): ${e?.message || e}`);
      }
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
      // CRITICAL FIX: Check order_id before querying exchange (synced positions have order_id=null)
      let fillPrice = null;
      if (position.order_id) {
        try {
          fillPrice = await exchangeService.getOrderAverageFillPrice(position.symbol, position.order_id);
        } catch (e) {
          logger.debug(`[Place TP/SL] Failed to get fill price from exchange for position ${position.id} (order_id=${position.order_id}): ${e?.message || e}`);
        }
      } else {
        logger.debug(`[Place TP/SL] Position ${position.id} has no order_id (synced position), skipping getOrderAverageFillPrice`);
      }
      
      if (!fillPrice || !Number.isFinite(fillPrice) || fillPrice <= 0) {
        // Fallback to position.entry_price if available
        if (position.entry_price && Number.isFinite(Number(position.entry_price)) && Number(position.entry_price) > 0) {
          fillPrice = Number(position.entry_price);
          logger.info(
            `[Place TP/SL] Using entry_price from DB for position ${position.id} ` +
            `(order_id=${position.order_id || 'null'}, synced position or order not found): ${fillPrice}`
          );
        } else {
          logger.warn(`[Place TP/SL] Could not get fill price for position ${position.id} (order_id=${position.order_id || 'null'}), will retry.`);
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
        // Release lock before returning
        await this._releasePositionLock(position.id);
        return;
      }

      // Recalculate TP/SL based on the real entry price
      const { calculateTakeProfit, calculateInitialStopLoss, calculateInitialStopLossByAmount } = await import('../utils/calculator.js');
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
      
      // CRITICAL FIX: Use trailing TP from DB if available, otherwise calculate initial TP
      // This ensures we use the latest trailing TP price, not the initial TP
      let tpPrice = null;
      if (position.take_profit_price && Number.isFinite(Number(position.take_profit_price)) && Number(position.take_profit_price) > 0) {
        // Use trailing TP from DB (already calculated by PositionService.updatePosition)
        tpPrice = Number(position.take_profit_price);
        logger.info(
          `[Place TP/SL] ✅ Using trailing TP from DB | pos=${position.id} ` +
          `take_profit_price=${tpPrice} (from DB, already trailing) timestamp=${new Date().toISOString()}`
        );
      } else if (takeProfit) {
        // Calculate initial TP if not available in DB
        tpPrice = calculateTakeProfit(fillPrice, takeProfit, position.side);
        logger.info(
          `[Place TP/SL] 📊 Calculated initial TP | pos=${position.id} ` +
          `tpPrice=${tpPrice} (calculated from strategy) timestamp=${new Date().toISOString()}`
        );
      }
      
      // Get the exact quantity of the position first (needed for SL calculation)
      const quantity = await exchangeService.getClosableQuantity(position.symbol, position.side);
      if (!quantity || quantity <= 0) {
        logger.warn(`[Place TP/SL] No closable quantity found for position ${position.id}, cannot place TP/SL.`);
        // Release lock before returning
        await this._releasePositionLock(position.id);
        return;
      }

      // Only set SL if strategy.stoploss > 0. No fallback to reduce/up_reduce
      // NEW: stoploss is now in USDT (not percentage), need quantity to calculate SL price
      const rawStoploss = strategy.stoploss !== undefined ? Number(strategy.stoploss) : (position.stoploss !== undefined ? Number(position.stoploss) : NaN);
      const isStoplossValid = Number.isFinite(rawStoploss) && rawStoploss > 0;
      
      // Check quantity mismatch with DB amount BEFORE calculating SL
      // CRITICAL: If quantity differs significantly, actual loss will differ from slAmount
      const dbAmount = parseFloat(position.amount || 0);
      const markPrice = parseFloat(position.entry_price || fillPrice || 0);
      const estimatedQuantity = markPrice > 0 ? dbAmount / markPrice : 0;
      const quantityDiffPercent = estimatedQuantity > 0 ? Math.abs((quantity - estimatedQuantity) / estimatedQuantity) * 100 : 0;
      
      let slPrice = null;
      let quantityToUse = quantity; // Default: use exchange quantity
      
      if (isStoplossValid) {
        // CRITICAL FIX: If quantity mismatch > 10%, use estimated quantity to ensure loss = slAmount
        // This prevents actual loss from exceeding the set slAmount
        if (quantityDiffPercent > 10 && estimatedQuantity > 0) {
          logger.warn(
            `[Place TP/SL] ⚠️ Quantity mismatch detected for position ${position.id}: ` +
            `DB estimated=${estimatedQuantity.toFixed(4)}, Exchange=${quantity.toFixed(4)}, diff=${quantityDiffPercent.toFixed(2)}% ` +
            `Using estimated quantity to ensure SL loss matches set amount (${rawStoploss} USDT)`
          );
          
          // Use estimated quantity to calculate SL (ensures loss = slAmount)
          quantityToUse = estimatedQuantity;
          slPrice = calculateInitialStopLossByAmount(fillPrice, quantityToUse, rawStoploss, position.side);
          
          if (slPrice) {
            // Calculate what the actual loss would be with exchange quantity
            const actualLossWithExchangeQty = Math.abs(slPrice - fillPrice) * quantity;
            const lossDiff = actualLossWithExchangeQty - rawStoploss;
            
            logger.warn(
              `[Place TP/SL] 🔄 Recalculated SL using estimated quantity | ` +
              `pos=${position.id} slPrice=${slPrice.toFixed(8)} ` +
              `(if exchange qty used, actual loss would be ${actualLossWithExchangeQty.toFixed(2)} USDT, diff=${lossDiff.toFixed(2)} USDT)`
            );
          }
        } else {
          // Quantity matches or difference is small, safe to use exchange quantity
          slPrice = calculateInitialStopLossByAmount(fillPrice, quantityToUse, rawStoploss, position.side);
        }
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
          
          logger.info(
            `[Place TP/SL] 🚀 Calling ExitOrderManager.placeOrReplaceExitOrder | pos=${position.id} ` +
            `symbol=${position.symbol} side=${position.side} tpPrice=${tpPrice} ` +
            `currentExitOrderId=${position.exit_order_id || 'NULL'} timestamp=${new Date().toISOString()}`
          );
          
          const placed = await mgr.placeOrReplaceExitOrder(position, tpPrice);
          
          // CRITICAL: Check if ExitOrderManager signals to close position immediately
          // This happens when price has already exceeded initial TP before order placement
          if (placed?.shouldCloseImmediately === true) {
            logger.warn(
              `[Place TP/SL] 🚨 Price exceeded initial TP before order placement | pos=${position.id} ` +
              `desiredTP=${placed.desiredTP?.toFixed(8) || tpPrice} currentPrice=${placed.currentPrice?.toFixed(8)} ` +
              `side=${position.side} reason=${placed.reason || 'price_exceeded_initial_tp'} ` +
              `→ Closing position immediately with MARKET order`
            );
            
            // Release lock before closing
            await this._releasePositionLock(position.id);
            
            // Close position immediately using PositionService
            try {
              const positionService = this.positionServices.get(position.bot_id);
              if (!positionService) {
                logger.error(`[Place TP/SL] PositionService not found for bot ${position.bot_id}, cannot close position ${position.id}`);
                return;
              }
              
              // Calculate PnL for the close
              const { calculatePnL } = await import('../utils/calculator.js');
              const currentPnl = calculatePnL(
                position.entry_price,
                placed.currentPrice,
                position.amount,
                position.side
              );
              
              // Close position with proper reason
              const closedPosition = await positionService.closePosition(
                position,
                placed.currentPrice,
                currentPnl,
                'price_exceeded_initial_tp'
              );
              
              logger.info(
                `[Place TP/SL] ✅ Position ${position.id} closed immediately | ` +
                `price=${placed.currentPrice?.toFixed(8)} pnl=${currentPnl.toFixed(2)} ` +
                `reason=price_exceeded_initial_tp`
              );
              
              return; // Exit early, position is closed
            } catch (closeError) {
              logger.error(
                `[Place TP/SL] ❌ Failed to close position immediately | pos=${position.id} ` +
                `error=${closeError?.message || closeError} stack=${closeError?.stack || 'N/A'}`
              );
              // Continue to try placing TP order as fallback (though it may fail)
            }
          }
          
          const tpOrderId = placed?.orderId ? String(placed.orderId) : null;
          // Use adjusted stopPrice if available (for trailing TP), otherwise use original tpPrice
          const finalTPPrice = placed?.stopPrice && Number.isFinite(Number(placed.stopPrice)) 
            ? Number(placed.stopPrice) 
            : tpPrice;
          
          logger.info(
            `[Place TP/SL] 📋 ExitOrderManager returned | pos=${position.id} ` +
            `tpOrderId=${tpOrderId || 'NULL'} orderType=${placed?.orderType || 'N/A'} ` +
            `stopPrice=${finalTPPrice.toFixed(8)} (original=${tpPrice.toFixed(8)}) timestamp=${new Date().toISOString()}`
          );
          
          if (tpOrderId) {
            // Store initial TP price for trailing calculation (only if not already set)
            // CRITICAL: Only include tp_sl_pending if column exists (backward compatibility)
            // Use finalTPPrice (may be adjusted for trailing TP) instead of original tpPrice
            const updateData = { 
              exit_order_id: tpOrderId, 
              take_profit_price: finalTPPrice
            };
            if (!shouldPreserveInitialTP) {
              updateData.initial_tp_price = tpPrice; // Only set if not already set
            }
            
            // Only set tp_sl_pending if Position model supports it (check rawAttributes)
            if (Position?.rawAttributes?.tp_sl_pending) {
              updateData.tp_sl_pending = false; // Clear pending flag after successful EXIT placement
            }
            
            logger.info(
              `[Place TP/SL] 💾 Updating DB with exit_order_id | pos=${position.id} ` +
              `exit_order_id=${tpOrderId} take_profit_price=${finalTPPrice.toFixed(8)} ` +
              `initial_tp_price=${updateData.initial_tp_price || 'preserved'} ` +
              `tp_sl_pending=${updateData.tp_sl_pending !== undefined ? updateData.tp_sl_pending : 'N/A (column not supported)'} ` +
              `timestamp=${new Date().toISOString()}`
            );
            
            try {
            await Position.update(position.id, updateData);
              logger.info(
                `[Place TP/SL] ✅ Placed EXIT order ${tpOrderId} for position ${position.id} @ ${finalTPPrice.toFixed(8)} ` +
                `${shouldPreserveInitialTP ? '(preserved initial TP)' : '(initial TP)'} ` +
                `${finalTPPrice !== tpPrice ? `(adjusted from ${tpPrice.toFixed(8)} due to trailing TP)` : ''} ` +
                `timestamp=${new Date().toISOString()}`
              );
              
              // CRITICAL FIX: Run dedupe AFTER successfully creating new order to clean up old duplicate orders
              // This ensures new order exists before cancelling old ones, preventing miss hit TP
              try {
                const exchangeService = this.exchangeServices.get(position.bot_id);
                if (exchangeService && exchangeService.bot?.exchange === 'binance') {
                  // Refresh position to get latest exit_order_id
                  const refreshedPosition = await Position.findById(position.id);
                  if (refreshedPosition) {
                    await this._dedupeCloseOrdersOnExchange(exchangeService, refreshedPosition);
                  }
                }
              } catch (dedupeError) {
                // Non-critical: dedupe failure doesn't affect order placement
                logger.debug(`[Place TP/SL] Dedupe after order creation skipped/failed for position ${position.id}: ${dedupeError?.message || dedupeError}`);
              }
            } catch (dbError) {
              // If error is about missing column, retry without that column
              if (dbError?.message?.includes("Unknown column") || dbError?.message?.includes("tp_sl_pending")) {
                logger.warn(
                  `[Place TP/SL] ⚠️ DB column error, retrying without tp_sl_pending | pos=${position.id} ` +
                  `error=${dbError?.message || dbError} timestamp=${new Date().toISOString()}`
                );
                const retryData = { 
                  exit_order_id: tpOrderId, 
                  take_profit_price: finalTPPrice
                };
                if (!shouldPreserveInitialTP) {
                  retryData.initial_tp_price = finalTPPrice;
                }
                // Retry without tp_sl_pending
                await Position.update(position.id, retryData);
                logger.info(
                  `[Place TP/SL] ✅ Retry successful: Placed EXIT order ${tpOrderId} for position ${position.id} @ ${finalTPPrice.toFixed(8)} ` +
                  `(without tp_sl_pending column) timestamp=${new Date().toISOString()}`
                );
              } else {
                logger.error(
                  `[Place TP/SL] ❌ DB UPDATE FAILED after order creation! | pos=${position.id} ` +
                  `tpOrderId=${tpOrderId} error=${dbError?.message || dbError} ` +
                  `stack=${dbError?.stack || 'N/A'} timestamp=${new Date().toISOString()}`
                );
                // CRITICAL: Order was created on exchange but DB update failed!
                // This will cause the order to be cancelled by dedupe on next run
                throw new Error(`DB update failed after order creation: ${dbError?.message || dbError}`);
              }
            }
          } else {
            // Order creation returned null (e.g., price too close to market)
            // Use finalTPPrice (may be adjusted for trailing TP) instead of original tpPrice
            logger.warn(
              `[Place TP/SL] ⚠️ TP order creation returned null for position ${position.id} @ ${finalTPPrice.toFixed(8)}. ` +
              `Updating TP price in DB only. timestamp=${new Date().toISOString()}`
            );
            const updateData = { take_profit_price: finalTPPrice };
            if (!shouldPreserveInitialTP) {
              updateData.initial_tp_price = finalTPPrice; // Only set if not already set
            }
            await Position.update(position.id, updateData);
          }
        } catch (e) {
          // If TP order creation fails, still update take_profit_price in DB
          // This allows trailing TP to work even if orders can't be placed
          logger.error(
            `[Place TP/SL] ❌ EXCEPTION in TP order placement | pos=${position.id} ` +
            `error=${e?.message || e} stack=${e?.stack || 'N/A'} ` +
            `timestamp=${new Date().toISOString()}`
          );
          // Use finalTPPrice if available (may be adjusted for trailing TP), otherwise use original tpPrice
          const fallbackTPPrice = placed?.stopPrice && Number.isFinite(Number(placed.stopPrice))
            ? Number(placed.stopPrice)
            : tpPrice;
          
          logger.warn(
            `[Place TP/SL] Updating TP price in DB to ${fallbackTPPrice.toFixed(8)} for position ${position.id} ` +
            `(order may have been created on exchange but DB update failed - check logs above) ` +
            `timestamp=${new Date().toISOString()}`
          );
          try {
            const currentPosition = await Position.findById(position.id);
            const shouldPreserveInitialTP = currentPosition?.initial_tp_price && 
                                            Number.isFinite(Number(currentPosition.initial_tp_price)) && 
                                            Number(currentPosition.initial_tp_price) > 0;
            const updateData = { take_profit_price: fallbackTPPrice };
            if (!shouldPreserveInitialTP) {
              updateData.initial_tp_price = fallbackTPPrice; // Only set if not already set
            }
            await Position.update(position.id, updateData);
          } catch (updateError) {
            logger.error(`[Place TP/SL] Failed to update TP price in DB:`, updateError?.message || updateError);
          }
        }
      } else if (needsTp && (!tpPrice || !Number.isFinite(tpPrice) || tpPrice <= 0)) {
        logger.error(
          `[Place TP/SL] ❌ CRITICAL: Cannot place TP order for position ${position.id}: invalid tpPrice (${tpPrice}). ` +
          `Position is exposed to unlimited loss risk! Strategy take_profit=${strategy?.take_profit || 'N/A'}, ` +
          `position.take_profit=${position?.take_profit || 'N/A'}. Please check strategy configuration.`
        );
        // CRITICAL: Even if TP cannot be placed, we should still try to place SL if possible
        // This is better than having no protection at all
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
            
            // Cancel TP order if any (invalid SL detected, must close position immediately)
            if (position.exit_order_id) {
              try {
                await exchangeService.cancelOrder(position.exit_order_id, position.symbol);
                logger.info(`[Place TP/SL] Cancelled TP order ${position.exit_order_id} for position ${position.id} (invalid SL detected)`);
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
            // Clear pending flag if both TP and SL are placed (only if column exists)
            if (hasTP && Position?.rawAttributes?.tp_sl_pending) {
              updateData.tp_sl_pending = false;
            }
            await Position.update(position.id, updateData);
            logger.debug(`[Place TP/SL] ✅ Placed SL order ${slOrderId} for position ${position.id} @ ${slPrice}`);
            
            // CRITICAL FIX: Run dedupe AFTER successfully creating SL order to clean up old duplicate orders
            try {
              const exchangeService = this.exchangeServices.get(position.bot_id);
              if (exchangeService && exchangeService.bot?.exchange === 'binance') {
                // Refresh position to get latest sl_order_id
                const refreshedPosition = await Position.findById(position.id);
                if (refreshedPosition) {
                  await this._dedupeCloseOrdersOnExchange(exchangeService, refreshedPosition);
                }
              }
            } catch (dedupeError) {
              // Non-critical: dedupe failure doesn't affect order placement
              logger.debug(`[Place TP/SL] Dedupe after SL creation skipped/failed for position ${position.id}: ${dedupeError?.message || dedupeError}`);
            }
          }
        } catch (e) {
          logger.error(
            `[Place TP/SL] ❌ CRITICAL: Failed to create SL order for position ${position.id}: ${e?.message || e}. ` +
            `Position is exposed to unlimited loss risk! Will retry on next cycle.`
          );
          // CRITICAL: Set tp_sl_pending to true to ensure retry on next cycle
          try {
            if (Position?.rawAttributes?.tp_sl_pending) {
              await Position.update(position.id, { tp_sl_pending: true });
            }
          } catch (updateError) {
            logger.debug(`[Place TP/SL] Could not set tp_sl_pending flag for retry: ${updateError?.message || updateError}`);
          }
        }
      } else if (slPrice === null || slPrice <= 0) {
        // If strategy has no stoploss configured, this is expected behavior
        logger.debug(`[Place TP/SL] Skipping SL order placement for position ${position.id} (stoploss <= 0 or not set in strategy)`);
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
   * CRITICAL: Never cancels SL orders if strategy has stoploss > 0 (hard SL requirement).
   */
  async _dedupeCloseOrdersOnExchange(exchangeService, position) {
    const symbol = position.symbol;
    const side = position.side;
    const desiredPositionSide = side === 'long' ? 'LONG' : 'SHORT';
    const timestamp = new Date().toISOString();

    // CRITICAL FIX: Check if strategy has hard SL requirement (stoploss > 0)
    // If yes, we must NEVER cancel SL orders, only cancel duplicate TP orders
    let hasHardSL = false;
    try {
      const strategy = await Strategy.findById(position.strategy_id);
      if (strategy) {
        const rawStoploss = strategy.stoploss !== undefined ? Number(strategy.stoploss) : NaN;
        hasHardSL = Number.isFinite(rawStoploss) && rawStoploss > 0;
        if (hasHardSL) {
          logger.info(
            `[Dedupe] 🛡️ Strategy ${strategy.id} has hard SL requirement (stoploss=${rawStoploss} USDT). ` +
            `Will NOT cancel any SL orders, only dedupe TP orders. | pos=${position.id}`
          );
        }
      }
    } catch (e) {
      logger.debug(`[Dedupe] Could not check strategy for hard SL: ${e?.message || e} | pos=${position.id}`);
    }

    logger.debug(
      `[Dedupe] 🔍 Starting dedupe check | pos=${position.id} symbol=${symbol} side=${side} ` +
      `exit_order_id=${position.exit_order_id || 'NULL'} sl_order_id=${position.sl_order_id || 'NULL'} ` +
      `hasHardSL=${hasHardSL} timestamp=${timestamp}`
    );

    const openOrders = await exchangeService.getOpenOrders(symbol);
    if (!Array.isArray(openOrders) || openOrders.length <= 1) {
      logger.debug(`[Dedupe] ⏭️  SKIP: ${openOrders?.length || 0} open orders (<=1), no dedupe needed | pos=${position.id}`);
      return;
    }

    logger.debug(`[Dedupe] 📋 Found ${openOrders.length} total open orders on exchange | pos=${position.id} symbol=${symbol}`);

    // Only consider close / reduce-only style orders
    const reduceOnlyOrders = openOrders.filter(o => {
      const isReduceOnly = o?.reduceOnly === true || o?.reduceOnly === 'true';
      const isClosePosition = o?.closePosition === true || o?.closePosition === 'true';
      const type = String(o?.type || '').toUpperCase();
      const isTpOrStop = type === 'STOP_MARKET' || type === 'TAKE_PROFIT_MARKET' || type === 'STOP' || type === 'STOP_LOSS' || type === 'STOP_LOSS_LIMIT';
      // Some responses don't include reduceOnly flag but include closePosition
      return (isReduceOnly || isClosePosition) && isTpOrStop;
    });

    logger.debug(
      `[Dedupe] 🔍 Filtered to ${reduceOnlyOrders.length} reduce-only close orders | pos=${position.id} ` +
      `(types: ${reduceOnlyOrders.map(o => o?.type).join(', ')})`
    );

    if (reduceOnlyOrders.length <= 2) {
      logger.debug(`[Dedupe] ⏭️  SKIP: ${reduceOnlyOrders.length} reduce-only orders (<=2), no dedupe needed | pos=${position.id}`);
      return;
    }

    // Match positionSide if present (hedge mode)
    const scoped = reduceOnlyOrders.filter(o => {
      const ps = String(o?.positionSide || '').toUpperCase();
      return !ps || ps === desiredPositionSide;
    });

    logger.debug(
      `[Dedupe] 🎯 Scoped to ${scoped.length} orders matching positionSide=${desiredPositionSide} | pos=${position.id} ` +
      `(orderIds: ${scoped.map(o => o?.orderId).join(', ')})`
    );

    if (scoped.length <= 2) {
      logger.debug(`[Dedupe] ⏭️  SKIP: ${scoped.length} scoped orders (<=2), no dedupe needed | pos=${position.id}`);
      return;
    }

    // Unified exit order types
    const exitTypes = new Set(['STOP_MARKET', 'TAKE_PROFIT_MARKET']);
    const stopTypes = new Set(['STOP', 'STOP_LOSS', 'STOP_LOSS_LIMIT']);

    const keepIds = new Set();
    if (position.exit_order_id) {
      keepIds.add(String(position.exit_order_id));
      logger.debug(`[Dedupe] ✅ Keeping exit_order_id from DB: ${position.exit_order_id} | pos=${position.id}`);
    } else {
      logger.warn(
        `[Dedupe] ⚠️  WARNING: exit_order_id is NULL in DB but found ${scoped.length} exit orders on exchange! ` +
        `This may indicate a race condition or order was created but DB not updated. ` +
        `Will keep newest exit order to avoid cancelling valid order. | pos=${position.id}`
      );
    }
    if (position.sl_order_id) {
      keepIds.add(String(position.sl_order_id));
      logger.debug(`[Dedupe] ✅ Keeping sl_order_id from DB: ${position.sl_order_id} | pos=${position.id}`);
    }

    const byTimeAsc = [...scoped].sort((a, b) => Number(a?.time || a?.updateTime || a?.origTime || 0) - Number(b?.time || b?.updateTime || b?.origTime || 0));

    const exits = byTimeAsc.filter(o => exitTypes.has(String(o?.type || '').toUpperCase()));
    const stops = byTimeAsc.filter(o => stopTypes.has(String(o?.type || '').toUpperCase()));

    logger.debug(
      `[Dedupe] 📊 Categorized orders | pos=${position.id} ` +
      `exits=${exits.length} (${exits.map(o => `${o?.orderId}(${o?.type})`).join(', ')}) ` +
      `stops=${stops.length} (${stops.map(o => `${o?.orderId}(${o?.type})`).join(', ')})`
    );

    // Keep newest order of each class if not explicitly referenced
    const newestExit = exits.length ? exits[exits.length - 1] : null;
    const newestStop = stops.length ? stops[stops.length - 1] : null;
    if (newestExit?.orderId) {
      keepIds.add(String(newestExit.orderId));
      logger.debug(
        `[Dedupe] ✅ Keeping newest exit order: ${newestExit.orderId} (${newestExit.type}) | pos=${position.id} ` +
        `time=${newestExit.time || newestExit.updateTime || 'N/A'}`
      );
    }
    if (newestStop?.orderId) {
      keepIds.add(String(newestStop.orderId));
      logger.debug(
        `[Dedupe] ✅ Keeping newest stop order: ${newestStop.orderId} (${newestStop.type}) | pos=${position.id} ` +
        `time=${newestStop.time || newestStop.updateTime || 'N/A'}`
      );
    }

    const toCancel = scoped.filter(o => !keepIds.has(String(o?.orderId)));
    
    logger.info(
      `[Dedupe] 📋 Dedupe summary | pos=${position.id} symbol=${symbol} ` +
      `total=${scoped.length} keep=${keepIds.size} cancel=${toCancel.length} ` +
      `keepIds=[${Array.from(keepIds).join(', ')}] ` +
      `cancelIds=[${toCancel.map(o => o?.orderId).join(', ')}]`
    );

    if (toCancel.length === 0) {
      logger.debug(`[Dedupe] ✅ No orders to cancel | pos=${position.id}`);
      return;
    }

    // CRITICAL FIX: If exit_order_id is NULL in DB but we found exit orders on exchange,
    // DO NOT cancel them! This indicates the order was just created and DB hasn't been updated yet.
    // Instead, log a warning and skip cancellation for exit orders.
    if (!position.exit_order_id && exits.length > 0) {
      logger.error(
        `[Dedupe] 🚨 CRITICAL: exit_order_id is NULL in DB but found ${exits.length} exit orders on exchange! ` +
        `This is likely a race condition. Will NOT cancel exit orders to avoid data loss. ` +
        `Position ${position.id} needs manual intervention or PositionMonitor.placeExitOrder should be called. ` +
        `Found exit orders: ${exits.map(o => `${o.orderId}(${o.type}@${o.stopPrice || o.price})`).join(', ')}`
      );
      
      // CRITICAL FIX: Only cancel stop orders (SL) if strategy does NOT have hard SL requirement
      // If strategy has hard SL (stoploss > 0), NEVER cancel SL orders
      if (!hasHardSL) {
        const stopOrdersToCancel = toCancel.filter(o => stopTypes.has(String(o?.type || '').toUpperCase()));
        if (stopOrdersToCancel.length > 0) {
          logger.warn(
            `[Dedupe] ⚠️  Will cancel ${stopOrdersToCancel.length} duplicate STOP orders only (not exit orders) | pos=${position.id}`
          );
          for (const o of stopOrdersToCancel) {
            try {
              logger.info(`[Dedupe] 🗑️  Cancelling duplicate STOP order ${o.orderId} (${o.type}) | pos=${position.id} symbol=${symbol}`);
              await exchangeService.cancelOrder(String(o.orderId), symbol);
              logger.info(`[Dedupe] ✅ Cancelled duplicate STOP order ${o.orderId} | pos=${position.id}`);
            } catch (e) {
              logger.error(`[Dedupe] ❌ Failed to cancel duplicate STOP order ${o.orderId}: ${e?.message || e} | pos=${position.id}`);
            }
          }
        }
      } else {
        logger.info(
          `[Dedupe] 🛡️ Strategy has hard SL requirement, skipping cancellation of ${toCancel.filter(o => stopTypes.has(String(o?.type || '').toUpperCase())).length} STOP orders | pos=${position.id}`
        );
      }
      return; // Exit early, don't cancel exit orders
    }

    // CRITICAL FIX: Enable cancellation of duplicate orders to prevent order spam
    // Only cancel if exit_order_id exists in DB (race condition protection above)
    // CRITICAL: If strategy has hard SL requirement, NEVER cancel SL orders, only cancel duplicate TP orders
    const ordersToCancel = hasHardSL 
      ? toCancel.filter(o => exitTypes.has(String(o?.type || '').toUpperCase())) // Only cancel TP orders
      : toCancel; // Cancel all duplicate orders
    
    if (ordersToCancel.length === 0 && toCancel.length > 0) {
      logger.info(
        `[Dedupe] 🛡️ Strategy has hard SL requirement, skipping cancellation of ${toCancel.length} SL orders | pos=${position.id} ` +
        `(only ${toCancel.filter(o => exitTypes.has(String(o?.type || '').toUpperCase())).length} TP orders would be cancelled if any)`
      );
      return; // No orders to cancel
    }
    
    logger.info(
      `[Dedupe] 🗑️  Cancelling ${ordersToCancel.length} duplicate orders | pos=${position.id} symbol=${symbol} ` +
      `${hasHardSL ? '(SL orders protected due to hard SL requirement)' : ''} ` +
      `to enforce 1-exit-order invariant. Orders to cancel: ${ordersToCancel.map(o => `${o.orderId}(${o.type})`).join(', ')}`
    );

    for (const o of ordersToCancel) {
      try {
        const cancelStart = Date.now();
        logger.info(
          `[Dedupe] 🗑️  Cancelling duplicate order ${o.orderId} (${o.type}) | pos=${position.id} ` +
          `symbol=${symbol} stopPrice=${o.stopPrice || o.price || 'N/A'} timestamp=${new Date().toISOString()}`
        );
        await exchangeService.cancelOrder(String(o.orderId), symbol);
        const cancelDuration = Date.now() - cancelStart;
        logger.info(
          `[Dedupe] ✅ Cancelled duplicate order ${o.orderId} | pos=${position.id} ` +
          `duration=${cancelDuration}ms timestamp=${new Date().toISOString()}`
        );
      } catch (e) {
        logger.error(
          `[Dedupe] ❌ Failed to cancel duplicate order ${o.orderId}: ${e?.message || e} | pos=${position.id} ` +
          `stack=${e?.stack || 'N/A'}`
        );
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

    // Reset per-cycle caches
    this._scanCache.clear();
    this._priceCache.clear();
    this._closableQtyCache.clear();

    try {
      const openPositions = await Position.findOpen();
      
      // DEBUG: Log position IDs being monitored (use info level for visibility)
      if (openPositions.length > 0) {
        const positionIds = openPositions.map(p => `${p.id}(${p.symbol})`).join(', ');
        logger.info(`[PositionMonitor] 📋 Found ${openPositions.length} open positions: [${positionIds}]`);
      } else {
        logger.warn(`[PositionMonitor] ⚠️ No open positions found`);
      }
      
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

      // CRITICAL FIX: Group positions by bot_id to ensure fair distribution
      // Process each bot's positions in parallel to avoid one bot monopolizing the monitor
      const positionsByBot = new Map();
      for (const pos of openPositions) {
        const botId = pos.bot_id || pos.strategy?.bot_id;
        if (!botId) {
          logger.warn(`[PositionMonitor] Position ${pos.id} has no bot_id, skipping`);
          continue;
        }
        if (!positionsByBot.has(botId)) {
          positionsByBot.set(botId, []);
        }
        positionsByBot.get(botId).push(pos);
      }

      // PRIORITY QUEUE: Sort bots by mainnet/testnet priority
      // Mainnet (binance_testnet=false/null) = priority 1 (highest), Testnet = priority 0 (lower)
      const botEntries = Array.from(positionsByBot.entries());
      botEntries.sort(([botIdA], [botIdB]) => {
        const exchangeServiceA = this.exchangeServices.get(botIdA);
        const exchangeServiceB = this.exchangeServices.get(botIdB);
        const isMainnetA = exchangeServiceA?.bot?.exchange === 'binance' && 
                          (exchangeServiceA.bot.binance_testnet === null || exchangeServiceA.bot.binance_testnet === false || exchangeServiceA.bot.binance_testnet === 0);
        const isMainnetB = exchangeServiceB?.bot?.exchange === 'binance' && 
                          (exchangeServiceB.bot.binance_testnet === null || exchangeServiceB.bot.binance_testnet === false || exchangeServiceB.bot.binance_testnet === 0);
        const priorityA = isMainnetA ? 1 : 0;
        const priorityB = isMainnetB ? 1 : 0;
        return priorityB - priorityA; // Higher priority first (mainnet first)
      });

      const mainnetBots = botEntries.filter(([botId]) => {
        const exchangeService = this.exchangeServices.get(botId);
        return exchangeService?.bot?.exchange === 'binance' && 
               (exchangeService.bot.binance_testnet === null || exchangeService.bot.binance_testnet === false || exchangeService.bot.binance_testnet === 0);
      }).length;
      const testnetBots = botEntries.length - mainnetBots;

      logger.info(
        `[PositionMonitor] 🔄 Processing ${openPositions.length} positions across ${positionsByBot.size} bots ` +
        `(MAINNET: ${mainnetBots}, TESTNET: ${testnetBots}): ` +
        `${botEntries.map(([botId, positions]) => `bot_${botId}=${positions.length}`).join(', ')}`
      );

      // CRITICAL OPTIMIZATION: Separate positions into priority queues
      // High priority: positions without TP/SL (need immediate attention)
      // CRITICAL FIX: Also check positions that have been open for > 30s without TP/SL (safety check)
      // Low priority: positions with TP/SL (can be monitored less frequently)
      const highPriorityPositions = [];
      const lowPriorityPositions = [];
      const now = Date.now();
      const SAFETY_CHECK_MS = 30000; // 30 seconds - force create TP/SL if missing
      
      for (const pos of openPositions) {
        const needsTPSL = !pos.exit_order_id || !pos.sl_order_id || pos.tp_sl_pending === true || pos.tp_sl_pending === 1;
        
        // CRITICAL SAFETY CHECK: If position has been open > 30s without TP/SL, force it to high priority
        if (!needsTPSL && pos.opened_at) {
          const openedAt = new Date(pos.opened_at).getTime();
          const timeSinceOpened = now - openedAt;
          if (timeSinceOpened > SAFETY_CHECK_MS) {
            // Position has been open for > 30s without TP/SL - CRITICAL RISK!
            logger.error(
              `[PositionMonitor] 🚨 CRITICAL: Position ${pos.id} (${pos.symbol}) has been open for ${Math.floor(timeSinceOpened / 1000)}s ` +
              `without TP/SL! exit_order_id=${pos.exit_order_id || 'NULL'}, sl_order_id=${pos.sl_order_id || 'NULL'}. ` +
              `FORCING TP/SL creation immediately to prevent deep loss!`
            );
            highPriorityPositions.push(pos);
            continue;
          }
        }
        
        if (needsTPSL) {
          highPriorityPositions.push(pos);
        } else {
          lowPriorityPositions.push(pos);
        }
      }
      
      logger.info(
        `[PositionMonitor] 📊 Priority split: ${highPriorityPositions.length} high-priority (need TP/SL), ` +
        `${lowPriorityPositions.length} low-priority (have TP/SL)`
      );

      // Process each bot's positions in parallel (fair distribution)
      // CRITICAL OPTIMIZATION: Process mainnet bots first (already sorted), then high-priority positions, then low-priority
      const botProcessingPromises = botEntries.map(async ([botId, botPositions]) => {
        const startTime = Date.now();
        try {
          // Split bot positions by priority
          const botHighPriority = botPositions.filter(p => 
            !p.exit_order_id || !p.sl_order_id || p.tp_sl_pending === true || p.tp_sl_pending === 1
          );
          const botLowPriority = botPositions.filter(p => 
            p.exit_order_id && p.sl_order_id && p.tp_sl_pending !== true && p.tp_sl_pending !== 1
          );
          
          logger.info(
            `[PositionMonitor] 🚀 Starting processing ${botPositions.length} positions for bot ${botId} ` +
            `(high-priority: ${botHighPriority.length}, low-priority: ${botLowPriority.length})`
          );
          
          // Process positions in batches per bot (to avoid rate limits per exchange)
          const batchSize = Number(configService.getNumber('POSITION_MONITOR_BATCH_SIZE', 5)); // Increased from 3 to 5
          const tpPlacementBatchSize = Number(configService.getNumber('POSITION_MONITOR_TP_BATCH_SIZE', 10)); // Larger batch for TP placement (parallel)
          const maxProcessingTimeMs = Number(configService.getNumber('POSITION_MONITOR_MAX_TIME_PER_BOT_MS', 300000)); // 5 minutes max per bot
          
          // PHASE 1: Process high-priority positions (need TP/SL) - URGENT
          // CRITICAL: Sort by opened_at (newest first) to prioritize recently filled positions
          // This ensures positions just filled get TP/SL immediately, reducing exposure risk
          botHighPriority.sort((a, b) => {
            const timeA = a.opened_at ? new Date(a.opened_at).getTime() : 0;
            const timeB = b.opened_at ? new Date(b.opened_at).getTime() : 0;
            return timeB - timeA; // Newest first (highest priority)
          });
          
          if (botHighPriority.length > 0) {
            logger.info(`[PositionMonitor] 🔥 Processing ${botHighPriority.length} high-priority positions for bot ${botId} (TP/SL placement, sorted by newest first)`);
            
            // Process TP/SL placement in larger parallel batches (faster)
            for (let i = 0; i < botHighPriority.length; i += tpPlacementBatchSize) {
              const elapsed = Date.now() - startTime;
              if (elapsed > maxProcessingTimeMs) {
                logger.warn(`[PositionMonitor] ⏱️ Max time reached for bot ${botId}, stopping high-priority processing`);
                break;
              }
              
              const batch = botHighPriority.slice(i, i + tpPlacementBatchSize);
              
              // Parallel TP/SL placement (no delay between positions in batch)
              await Promise.allSettled(
                batch.map(p => this.placeExitOrder(p))
              );
              
              // Small delay between batches only
              if (i + tpPlacementBatchSize < botHighPriority.length) {
                const delayMs = Number(configService.getNumber('POSITION_MONITOR_TP_BATCH_DELAY_MS', 300)); // Reduced from 2000ms to 300ms
                await new Promise(resolve => setTimeout(resolve, delayMs));
              }
            }
          }
          
          // PHASE 2: Process all positions for monitoring (can be done in parallel with smaller batches)
          const allPositionsForMonitoring = [...botHighPriority, ...botLowPriority];
          const monitoringBatchSize = Number(configService.getNumber('POSITION_MONITOR_MONITORING_BATCH_SIZE', 8)); // Parallel monitoring
          
          for (let i = 0; i < allPositionsForMonitoring.length; i += monitoringBatchSize) {
            const elapsed = Date.now() - startTime;
            if (elapsed > maxProcessingTimeMs) {
              logger.warn(
                `[PositionMonitor] ⏱️ Max processing time (${maxProcessingTimeMs}ms) reached for bot ${botId}. ` +
                `Processed ${i}/${allPositionsForMonitoring.length} positions. Remaining will be processed in next cycle.`
              );
              break;
            }
            
            const batch = allPositionsForMonitoring.slice(i, i + monitoringBatchSize);
            
            // Parallel monitoring (update dynamic SL, check for TP/SL hit, trailing TP)
            await Promise.allSettled(
              batch.map(async (position) => {
                try {
                  await this.monitorPosition(position);
                } catch (monitorError) {
                  logger.error(`[PositionMonitor] Error monitoring position ${position.id}: ${monitorError?.message || monitorError}`);
                }
              })
            );

            // Check for other order management tasks (parallel)
            await Promise.allSettled(
              batch.map(p => this.checkUnfilledOrders(p))
            );

            // Reduced delay between monitoring batches
            if (i + monitoringBatchSize < allPositionsForMonitoring.length) {
              const delayMs = Number(configService.getNumber('POSITION_MONITOR_MONITORING_BATCH_DELAY_MS', 200)); // Reduced delay
              await new Promise(resolve => setTimeout(resolve, delayMs));
            }
          }
          
          const totalTime = Date.now() - startTime;
          logger.info(
            `[PositionMonitor] ✅ Completed processing ${botPositions.length} positions for bot ${botId} in ${totalTime}ms ` +
            `(avg ${(totalTime / botPositions.length).toFixed(0)}ms per position)`
          );
        } catch (error) {
          logger.error(`[PositionMonitor] ❌ Error processing positions for bot ${botId}:`, error?.message || error);
        }
      });

      // Wait for all bots to complete (parallel processing)
      await Promise.allSettled(botProcessingPromises);

      // Log monitoring summary
      if (openPositions.length > 0 || !this._lastLogTime || (Date.now() - this._lastLogTime) > 60000) {
        logger.info(`[PositionMonitor] ✅ Monitored ${openPositions.length} open positions (interval: ${Date.now() - (this._lastLogTime || Date.now())}ms)`);
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
    // Get interval from config or use default 30 seconds
    // Changed from cron (1 minute) to setInterval (30 seconds) for faster TP order updates
    const intervalMs = Number(configService.getNumber('POSITION_MONITOR_INTERVAL_MS', SCAN_INTERVALS.POSITION_MONITOR));
    
    // Run immediately on start
    this.monitorAllPositions().catch(err => {
      logger.error('[PositionMonitor] Error in initial monitor run:', err);
    });
    
    // Then run every intervalMs
    setInterval(async () => {
      await this.monitorAllPositions();
    }, intervalMs);

    logger.info(`PositionMonitor started with interval: ${intervalMs}ms (${intervalMs / 1000}s)`);
  }
}
