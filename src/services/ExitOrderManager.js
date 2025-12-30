import logger from '../utils/logger.js';
import { configService } from './ConfigService.js';
// NOTE: avoid importing DB model here to keep manager easily unit-testable.
// Callers are responsible for persisting exit_order_id to DB if needed.


/**
 * ExitOrderManager
 *
 * 1 position = 1 exit order duy nhất.
 * Exit order sẽ tự switch type theo desiredExitPrice so với entryPrice (profit zone vs loss zone)
 * để đúng cơ chế Binance Futures và tránh -2021.
 *
 * LONG:
 *  - desiredExitPrice > entry => SELL TAKE_PROFIT_MARKET
 *  - desiredExitPrice <= entry => SELL STOP_MARKET
 *
 * SHORT:
 *  - desiredExitPrice < entry => BUY TAKE_PROFIT_MARKET
 *  - desiredExitPrice >= entry => BUY STOP_MARKET
 */
export class ExitOrderManager {
  constructor(exchangeService) {
    this.exchangeService = exchangeService;
  }

  async _cancelExistingExitOrder(position) {
    if (!position?.exit_order_id) return;

    try {
      await this.exchangeService.cancelOrder(String(position.exit_order_id), position.symbol);
    } catch (e) {
      logger.warn(`[ExitOrderManager] Failed to cancel existing exit order ${position.exit_order_id} for pos=${position.id}: ${e?.message || e}`);
    }


    position.exit_order_id = null;
  }

  _decideExitType(side, entryPrice, desiredExitPrice) {
    const entry = Number(entryPrice);
    const exit = Number(desiredExitPrice);

    // CRITICAL FIX: For SHORT positions, TP must be BELOW entry (profit zone)
    // If TP crosses entry (TP > entry), it's in loss zone and should use STOP_MARKET
    // However, we should prevent TP from crossing entry in the first place
    // This function only decides order type based on current TP price
    
    if (side === 'long') {
      // LONG: TP must be ABOVE entry (profit zone)
      // exit > entry → TAKE_PROFIT_MARKET (profit zone)
      // exit <= entry → STOP_MARKET (loss/breakeven zone)
      return exit > entry ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET';
    }
    
    // SHORT: TP must be BELOW entry (profit zone)
    // exit < entry → TAKE_PROFIT_MARKET (profit zone)
    // exit >= entry → STOP_MARKET (loss/breakeven zone)
    // CRITICAL: If TP crosses entry (exit >= entry), it's no longer a profit target
    // This can happen with trailing TP that moves towards entry
    return exit < entry ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET';
  }

  _isValidStopVsMarket(type, side, stopPrice, currentPrice) {
    const stop = Number(stopPrice);
    const cur = Number(currentPrice);
    if (!Number.isFinite(stop) || !Number.isFinite(cur) || cur <= 0) return true;

    if (side === 'long') {
      // LONG closes with SELL
      // TAKE_PROFIT_MARKET: stopPrice must be ABOVE current price
      // STOP_MARKET:        stopPrice must be BELOW current price
      if (type === 'TAKE_PROFIT_MARKET') return stop > cur;
      return stop < cur; // STOP_MARKET
    }

    // SHORT closes with BUY
    // TAKE_PROFIT_MARKET: stopPrice must be BELOW current price
    // STOP_MARKET:        stopPrice must be ABOVE current price
    if (type === 'TAKE_PROFIT_MARKET') return stop < cur;
    return stop > cur; // STOP_MARKET
  }

  _nudgeStopPrice(type, side, currentPrice) {
    const cur = Number(currentPrice);
    const pct = Number(configService.getNumber('EXIT_ORDER_NUDGE_PCT', 0.005)); // 0.5%
    if (!Number.isFinite(cur) || cur <= 0) return cur;

    // push stop to the nearest valid side of market
    if (side === 'long') {
      return type === 'TAKE_PROFIT_MARKET' ? cur * (1 + pct) : cur * (1 - pct);
    }
    return type === 'TAKE_PROFIT_MARKET' ? cur * (1 - pct) : cur * (1 + pct);
  }

  async placeOrReplaceExitOrder(position, desiredExitPrice) {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();
    
    if (!position || position.status !== 'open') {
      logger.warn(`[ExitOrderManager] ⚠️ SKIP: position not open. pos=${position?.id} status=${position?.status} timestamp=${timestamp}`);
      return null;
    }

    const entry = Number(position?.entry_price || 0);
    const side = position?.side;
    if (side !== 'long' && side !== 'short') throw new Error(`Invalid position.side: ${side}`);
    if (!Number.isFinite(entry) || entry <= 0) throw new Error(`Invalid entry_price for pos=${position.id}: ${position?.entry_price}`);

    // CRITICAL FIX: Check for existing exit orders on exchange BEFORE creating new one
    // This prevents duplicate orders from being created
    try {
      const openOrders = await this.exchangeService.getOpenOrders(position.symbol);
      if (Array.isArray(openOrders) && openOrders.length > 0) {
        const exitTypes = new Set(['STOP', 'TAKE_PROFIT', 'STOP_MARKET', 'TAKE_PROFIT_MARKET']); // Support both old and new types
        const positionSide = side === 'long' ? 'LONG' : 'SHORT';
        
        // Find existing exit orders for this position
        const existingExits = openOrders.filter(o => {
          const type = String(o?.type || '').toUpperCase();
          const isExitType = exitTypes.has(type);
          const isReduceOnly = o?.reduceOnly === true || o?.reduceOnly === 'true';
          const isClosePosition = o?.closePosition === true || o?.closePosition === 'true';
          const ps = String(o?.positionSide || '').toUpperCase();
          const matchesPositionSide = !ps || ps === positionSide;
          return isExitType && (isReduceOnly || isClosePosition) && matchesPositionSide;
        });
        
        if (existingExits.length > 0) {
          const existingIds = existingExits.map(o => o?.orderId).filter(Boolean);
          const dbOrderId = position?.exit_order_id ? String(position.exit_order_id) : null;
          
          // If we have an exit_order_id in DB, check if it exists on exchange
          if (dbOrderId && existingIds.includes(dbOrderId)) {
            logger.debug(
              `[ExitOrderManager] ✅ Found existing exit order ${dbOrderId} on exchange | pos=${position.id} ` +
              `(will replace if price changed) timestamp=${timestamp}`
            );
          } else if (existingExits.length > 0) {
            // Found exit orders on exchange but not in DB (race condition or orphaned orders)
            logger.warn(
              `[ExitOrderManager] ⚠️ Found ${existingExits.length} exit order(s) on exchange not in DB | pos=${position.id} ` +
              `existingIds=${existingIds.join(', ')} dbOrderId=${dbOrderId || 'null'} ` +
              `(will cancel orphaned orders and create new one) timestamp=${timestamp}`
            );
            
            // Cancel orphaned orders (except the one in DB if it exists)
            for (const order of existingExits) {
              const orderId = String(order?.orderId || '');
              if (orderId && orderId !== dbOrderId) {
                try {
                  await this.exchangeService.cancelOrder(orderId, position.symbol);
                  logger.info(
                    `[ExitOrderManager] 🗑️ Cancelled orphaned exit order ${orderId} | pos=${position.id} ` +
                    `type=${order?.type} timestamp=${timestamp}`
                  );
                } catch (cancelError) {
                  logger.warn(
                    `[ExitOrderManager] ⚠️ Failed to cancel orphaned order ${orderId} | pos=${position.id} ` +
                    `error=${cancelError?.message || cancelError}`
                  );
                }
              }
            }
          }
        }
      }
    } catch (checkError) {
      // Non-critical: if we can't check existing orders, continue with creation
      logger.debug(
        `[ExitOrderManager] Could not check existing orders (non-critical) | pos=${position.id} ` +
        `error=${checkError?.message || checkError} (will continue with order creation)`
      );
    }

    // ATOMIC REPLACE PATTERN: Create new order FIRST, then cancel old order
    // This eliminates the dangerous gap where no exit order exists

    logger.info(
      `[ExitOrderManager] 🔄 START atomic replace | pos=${position.id} symbol=${position.symbol} side=${side} ` +
      `entry=${entry.toFixed(8)} desiredExit=${Number(desiredExitPrice).toFixed(8)} ` +
      `oldOrderId=${position?.exit_order_id || 'null'} timestamp=${timestamp}`
    );

    // 1) Decide order type based on TP price vs entry (profit zone vs loss zone)
    // CRITICAL FIX: For trailing TP, allow TP to cross entry and use STOP in loss zone
    // - LONG: exit > entry → TAKE_PROFIT (profit zone), exit <= entry → STOP (loss zone)
    // - SHORT: exit < entry → TAKE_PROFIT (profit zone), exit >= entry → STOP (loss zone)
    const desiredExit = Number(desiredExitPrice);
    const orderType = this._decideExitType(side, entry, desiredExit);
    const typeDecisionTime = Date.now();
    
    // Check if TP is in loss zone (crossed entry)
    const isInLossZone = (side === 'long' && desiredExit <= entry) || (side === 'short' && desiredExit >= entry);
    
    if (isInLossZone) {
      logger.info(
        `[ExitOrderManager] 📊 TP in loss zone (crossed entry) | pos=${position.id} side=${side} ` +
        `entry=${entry.toFixed(8)} desiredExit=${desiredExit.toFixed(8)} orderType=${orderType} ` +
        `(will use STOP for loss zone) time=${typeDecisionTime - startTime}ms`
      );
    } else {
      logger.info(
        `[ExitOrderManager] 📊 TP in profit zone | pos=${position.id} side=${side} ` +
        `entry=${entry.toFixed(8)} desiredExit=${desiredExit.toFixed(8)} orderType=${orderType} ` +
        `time=${typeDecisionTime - startTime}ms`
      );
    }

    // 2) validate stopPrice vs market and nudge if needed
    const priceCheckStart = Date.now();
    const currentPrice = await this.exchangeService.getTickerPrice(position.symbol);
    let stopPrice = Number(desiredExitPrice); // Use original exit price (no clamping for trailing TP)
    const priceCheckTime = Date.now() - priceCheckStart;

    logger.debug(
      `[ExitOrderManager] 💹 Market price check: ${currentPrice.toFixed(8)} | pos=${position.id} ` +
      `desiredStop=${stopPrice.toFixed(8)} time=${priceCheckTime}ms`
    );

    if (!this._isValidStopVsMarket(orderType, side, stopPrice, currentPrice)) {
      const nudgedPrice = this._nudgeStopPrice(orderType, side, currentPrice);
      logger.warn(
        `[ExitOrderManager] ⚠️ Price nudged: pos=${position.id} type=${orderType} side=${side} ` +
        `desired=${desiredExitPrice.toFixed(8)} current=${currentPrice.toFixed(8)} ` +
        `nudged=${nudgedPrice.toFixed(8)} (invalid vs market)`
      );
      stopPrice = nudgedPrice;
    }

    // 3) Store old order ID before creating new one
    const oldOrderId = position?.exit_order_id ? String(position.exit_order_id) : null;
    const createStartTime = Date.now();

    logger.info(
      `[ExitOrderManager] 🆕 STEP 1: Creating NEW order | pos=${position.id} ` +
      `type=${orderType} stopPrice=${stopPrice.toFixed(8)} oldOrderId=${oldOrderId || 'null'} ` +
      `timestamp=${new Date().toISOString()}`
    );

    // 4) Place NEW order FIRST (atomic replace)
    // CRITICAL FIX: Map orderType correctly - TAKE_PROFIT -> TAKE_PROFIT_MARKET, STOP -> STOP_MARKET
    let res;
    let newOrderId = null;
    try {
      // Map internal type to Binance API type
      const isStopOrder = orderType === 'STOP' || orderType === 'STOP_MARKET';
      if (isStopOrder) {
        res = await this.exchangeService.createCloseStopMarket(position.symbol, side, stopPrice);
      } else {
        // orderType is 'TAKE_PROFIT' or 'TAKE_PROFIT_MARKET' - both map to TAKE_PROFIT_MARKET
        res = await this.exchangeService.createCloseTakeProfitMarket(position.symbol, side, stopPrice);
      }

      const createEndTime = Date.now();
      const createDuration = createEndTime - createStartTime;

      newOrderId = res?.orderId ? String(res.orderId) : null;
      if (newOrderId) {
        position.exit_order_id = newOrderId;
        logger.info(
          `[ExitOrderManager] ✅ STEP 1 SUCCESS: New order created | pos=${position.id} ` +
          `newOrderId=${newOrderId} type=${orderType} stopPrice=${stopPrice.toFixed(8)} ` +
          `duration=${createDuration}ms timestamp=${new Date().toISOString()}`
        );
      } else {
        logger.error(
          `[ExitOrderManager] ❌ STEP 1 FAILED: No orderId in response | pos=${position.id} ` +
          `type=${orderType} response=${JSON.stringify(res)} duration=${createDuration}ms`
        );
      }
    } catch (createError) {
      const createEndTime = Date.now();
      const createDuration = createEndTime - createStartTime;
      const errorMessage = createError?.message || String(createError);
      
      // CRITICAL FIX: Handle -2021 error (Order would immediately trigger)
      // This happens when stopPrice is already crossed by market price
      // Fallback: Close position immediately with MARKET order
      if (errorMessage.includes('-2021') || errorMessage.includes('would immediately trigger')) {
        logger.warn(
          `[ExitOrderManager] ⚠️ Order would immediately trigger (-2021) | pos=${position.id} ` +
          `type=${orderType} stopPrice=${stopPrice.toFixed(8)} currentPrice=${currentPrice?.toFixed(8) || 'unknown'} ` +
          `(falling back to MARKET close) duration=${createDuration}ms`
        );
        
        try {
          // Close position immediately with MARKET order
          // Pass null for amount to let closePosition auto-detect from exchange
          const marketCloseResult = await this.exchangeService.closePosition(position.symbol, side, null);
          logger.info(
            `[ExitOrderManager] ✅ FALLBACK SUCCESS: Position closed with MARKET order | pos=${position.id} ` +
            `symbol=${position.symbol} side=${side} result=${JSON.stringify(marketCloseResult)}`
          );
          // Return null to indicate position was closed (no exit order needed)
          return null;
        } catch (fallbackError) {
          logger.error(
            `[ExitOrderManager] ❌ FALLBACK FAILED: Could not close position with MARKET order | pos=${position.id} ` +
            `error=${fallbackError?.message || fallbackError}`
          );
          // Re-throw original error if fallback also fails
          throw createError;
        }
      }
      
      logger.error(
        `[ExitOrderManager] ❌ STEP 1 FAILED: Create error | pos=${position.id} ` +
        `type=${orderType} stopPrice=${stopPrice.toFixed(8)} oldOrderId=${oldOrderId || 'null'} ` +
        `duration=${createDuration}ms error=${errorMessage} ` +
        `stack=${createError?.stack || 'N/A'} timestamp=${new Date().toISOString()}`
      );
      // If new order creation fails, keep old order (don't cancel it)
      throw createError;
    }

    // 5) Cancel OLD order AFTER new order is successfully created
    // CRITICAL FIX: Enable cancel old orders to prevent duplicate orders accumulation
    if (oldOrderId && oldOrderId !== newOrderId) {
      const cancelStartTime = Date.now();
      logger.info(
        `[ExitOrderManager] 🗑️ STEP 2: Cancelling OLD order | pos=${position.id} ` +
        `oldOrderId=${oldOrderId} newOrderId=${newOrderId} ` +
        `timestamp=${new Date().toISOString()}`
      );

      try {
        await this.exchangeService.cancelOrder(oldOrderId, position.symbol);
        const cancelEndTime = Date.now();
        const cancelDuration = cancelEndTime - cancelStartTime;
        const totalDuration = cancelEndTime - startTime;

        logger.info(
          `[ExitOrderManager] ✅ STEP 2 SUCCESS: Old order cancelled | pos=${position.id} ` +
          `oldOrderId=${oldOrderId} newOrderId=${newOrderId} ` +
          `cancelDuration=${cancelDuration}ms totalDuration=${totalDuration}ms ` +
          `timestamp=${new Date().toISOString()}`
        );
      } catch (cancelError) {
        const cancelEndTime = Date.now();
        const cancelDuration = cancelEndTime - cancelStartTime;
        const totalDuration = cancelEndTime - startTime;
        
        // Non-critical: old order might already be filled or cancelled
        logger.warn(
          `[ExitOrderManager] ⚠️ STEP 2 WARNING: Cancel failed (non-critical) | pos=${position.id} ` +
          `oldOrderId=${oldOrderId} newOrderId=${newOrderId} ` +
          `cancelDuration=${cancelDuration}ms totalDuration=${totalDuration}ms ` +
          `error=${cancelError?.message || cancelError} ` +
          `(Old order may already be filled/cancelled. New order ${newOrderId} is active.) ` +
          `timestamp=${new Date().toISOString()}`
        );
      }
    } else {
      const totalDuration = Date.now() - startTime;
      if (oldOrderId && oldOrderId !== newOrderId) {
        logger.info(
          `[ExitOrderManager] ⚠️ STEP 2 DISABLED (DEBUG MODE): Old order NOT cancelled | pos=${position.id} ` +
          `oldOrderId=${oldOrderId} newOrderId=${newOrderId} ` +
          `(Both orders will exist on exchange for debugging) ` +
          `totalDuration=${totalDuration}ms timestamp=${new Date().toISOString()}`
        );
      } else if (!oldOrderId) {
        logger.info(
          `[ExitOrderManager] ℹ️ STEP 2 SKIP: No old order to cancel | pos=${position.id} ` +
          `newOrderId=${newOrderId} (first time placement) totalDuration=${totalDuration}ms ` +
          `timestamp=${new Date().toISOString()}`
        );
      } else if (oldOrderId === newOrderId) {
        logger.warn(
          `[ExitOrderManager] ⚠️ STEP 2 SKIP: Old order ID same as new | pos=${position.id} ` +
          `orderId=${oldOrderId} (unexpected, should not happen) totalDuration=${totalDuration}ms ` +
          `timestamp=${new Date().toISOString()}`
        );
      }
    }

    const totalDuration = Date.now() - startTime;
    logger.info(
      `[ExitOrderManager] ✅ COMPLETE: Atomic replace finished | pos=${position.id} ` +
      `oldOrderId=${oldOrderId || 'null'} newOrderId=${newOrderId || 'null'} ` +
      `type=${orderType} stopPrice=${stopPrice.toFixed(8)} ` +
      `totalDuration=${totalDuration}ms timestamp=${new Date().toISOString()}`
    );

    return { orderType, stopPrice, orderId: newOrderId };
  }
}
