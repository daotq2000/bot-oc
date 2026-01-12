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
      logger.error(
        `[ExitOrderManager] Failed to cancel existing exit order ${position.exit_order_id} for pos=${position.id}: ${e?.message || e}`
      );
    }

    position.exit_order_id = null;
  }

  _decideExitType(side, entryPrice, desiredExitPrice) {
    const entry = Number(entryPrice);
    const exit = Number(desiredExitPrice);
    
    if (side === 'long') {
      return exit > entry ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET';
    }
    
    return exit < entry ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET';
  }

  _isValidStopVsMarket(type, side, stopPrice, currentPrice) {
    const stop = Number(stopPrice);
    const cur = Number(currentPrice);
    if (!Number.isFinite(stop) || !Number.isFinite(cur) || cur <= 0) return true;

    if (side === 'long') {
      if (type === 'TAKE_PROFIT_MARKET') return stop > cur;
      return stop < cur;
    }

    if (type === 'TAKE_PROFIT_MARKET') return stop < cur;
    return stop > cur;
  }

  _nudgeStopPrice(type, side, currentPrice) {
    const cur = Number(currentPrice);
    const pct = Number(configService.getNumber('EXIT_ORDER_NUDGE_PCT', 0.005)); // 0.5%
    if (!Number.isFinite(cur) || cur <= 0) return cur;

    if (side === 'long') {
      return type === 'TAKE_PROFIT_MARKET' ? cur * (1 + pct) : cur * (1 - pct);
    }
    return type === 'TAKE_PROFIT_MARKET' ? cur * (1 - pct) : cur * (1 + pct);
  }

  async placeOrReplaceExitOrder(position, desiredExitPrice) {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();
    
    if (!position || position.status !== 'open') {
      logger.warn(
        `[ExitOrderManager] ⚠️ SKIP: position not open. pos=${position?.id} status=${position?.status} timestamp=${timestamp}`
      );
      return null;
    }

    const entry = Number(position?.entry_price || 0);
    const side = position?.side;
    if (side !== 'long' && side !== 'short') throw new Error(`Invalid position.side: ${side}`);
    if (!Number.isFinite(entry) || entry <= 0) {
      throw new Error(`Invalid entry_price for pos=${position.id}: ${position?.entry_price}`);
    }

    // Best-effort: cancel orphaned exits on exchange that are not in DB
    try {
      const openOrders = await this.exchangeService.getOpenOrders(position.symbol);
      if (Array.isArray(openOrders) && openOrders.length > 0) {
        const exitTypes = new Set(['STOP', 'TAKE_PROFIT', 'STOP_MARKET', 'TAKE_PROFIT_MARKET']);
        const positionSide = side === 'long' ? 'LONG' : 'SHORT';
        
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
          const existingIds = existingExits.map(o => String(o?.orderId || '')).filter(Boolean);
          const dbOrderId = position?.exit_order_id ? String(position.exit_order_id) : null;
          
          // Cancel orphaned exit orders
            for (const order of existingExits) {
              const orderId = String(order?.orderId || '');
              if (orderId && orderId !== dbOrderId) {
                try {
                  await this.exchangeService.cancelOrder(orderId, position.symbol);
                } catch (cancelError) {
                  logger.error(
                  `[ExitOrderManager] ⚠️ Failed to cancel orphaned order ${orderId} | pos=${position.id} error=${cancelError?.message || cancelError}`
                  );
              }
            }
          }

          if (dbOrderId && existingIds.includes(dbOrderId)) {
            // ok
          }
        }
      }
    } catch (checkError) {
      logger.error(
        `[ExitOrderManager] Could not check existing orders (non-critical) | pos=${position.id} error=${checkError?.message || checkError} (will continue with order creation)`
      );
    }

    const desiredExit = Number(desiredExitPrice);
    let orderType = this._decideExitType(side, entry, desiredExit);

    const currentPrice = await this.exchangeService.getTickerPrice(position.symbol);
    let stopPrice = Number(desiredExitPrice);

    // CRITICAL: Check if price has already exceeded TP before placing order
    // LONG: currentPrice > desiredTP means we're already past TP (more profit than expected)
    // SHORT: currentPrice < desiredTP means we're already past TP (more profit than expected)
    const hasPriceExceededTP = (side === 'long' && currentPrice > desiredExit) ||
                               (side === 'short' && currentPrice < desiredExit);

    if (hasPriceExceededTP) {
      // Distinguish between initial TP vs trailing TP
      const isInitialTP = !position.exit_order_id || !position.initial_tp_price;
      
      if (isInitialTP) {
        // Initial TP: Price already exceeded TP → Close immediately with MARKET to lock in better profit
        logger.warn(
          `[ExitOrderManager] 🚨 Price already exceeded initial TP | pos=${position.id} ` +
          `desiredTP=${desiredExit.toFixed(8)} currentPrice=${currentPrice.toFixed(8)} side=${side} ` +
          `→ Returning shouldCloseImmediately flag (caller should close with MARKET order)`
        );
        
        // Return special object to signal caller to close position immediately
        return {
          shouldCloseImmediately: true,
          currentPrice: currentPrice,
          desiredTP: desiredExit,
          reason: 'price_exceeded_initial_tp',
          orderType: null,
          stopPrice: null,
          orderId: null
        };
      } else {
        // Trailing TP: Price exceeded trailing TP → Adjust to new TP higher than current price
        const bufferPct = Number(configService.getNumber('TP_TRAILING_BUFFER_PCT', 0.005)); // 0.5% default
        if (side === 'long') {
          stopPrice = currentPrice * (1 + bufferPct);
        } else {
          stopPrice = currentPrice * (1 - bufferPct);
        }
        
        logger.info(
          `[ExitOrderManager] 📈 Price exceeded trailing TP, adjusting to new TP | pos=${position.id} ` +
          `oldTP=${desiredExit.toFixed(8)} newTP=${stopPrice.toFixed(8)} currentPrice=${currentPrice.toFixed(8)} ` +
          `side=${side} bufferPct=${(bufferPct * 100).toFixed(2)}%`
        );
        
        // Recalculate orderType based on new stopPrice
        orderType = this._decideExitType(side, entry, stopPrice);
      }
    }

    // Validate stopPrice vs market (existing logic)
    if (!this._isValidStopVsMarket(orderType, side, stopPrice, currentPrice)) {
      stopPrice = this._nudgeStopPrice(orderType, side, currentPrice);
    }

    const oldOrderId = position?.exit_order_id ? String(position.exit_order_id) : null;

    // CRITICAL FIX: Cancel old order FIRST to avoid -4116 (ClientOrderId duplicated)
    // Also check for orders with same newClientOrderId pattern and cancel them
    if (oldOrderId) {
      try {
        await this.exchangeService.cancelOrder(oldOrderId, position.symbol);
        logger.debug(`[ExitOrderManager] ✅ Cancelled old exit order ${oldOrderId} before creating new one | pos=${position.id}`);
      } catch (cancelError) {
        // If order doesn't exist or already cancelled, that's fine
        const errorMsg = String(cancelError?.message || cancelError);
        if (!errorMsg.includes('does not exist') && !errorMsg.includes('Unknown order') && !errorMsg.includes('-2011')) {
          logger.warn(`[ExitOrderManager] ⚠️ Failed to cancel old order ${oldOrderId} before creating new one | pos=${position.id} error=${errorMsg}`);
        }
      }
    }

    // Also check for orders with same newClientOrderId pattern (to handle race conditions)
    try {
      const botId = this.exchangeService?.bot?.id;
      const posId = position?.id;
      if (botId && posId) {
        // Check for orders with same clientOrderId pattern
        const expectedClientOrderIdPattern = orderType === 'STOP_MARKET' 
          ? `OC_B${botId}_P${posId}_EXIT`
          : `OC_B${botId}_P${posId}_TP`;
        
        const openOrders = await this.exchangeService.getOpenOrders(position.symbol);
        if (Array.isArray(openOrders)) {
          const exitTypes = new Set(['STOP_MARKET', 'TAKE_PROFIT_MARKET']);
          const positionSide = side === 'long' ? 'LONG' : 'SHORT';
          
          const duplicateOrders = openOrders.filter(o => {
            const type = String(o?.type || '').toUpperCase();
            const ps = String(o?.positionSide || '').toUpperCase();
            const clientOrderId = String(o?.clientOrderId || '');
            return exitTypes.has(type) && 
                   (!ps || ps === positionSide) &&
                   clientOrderId === expectedClientOrderIdPattern;
          });
          
          for (const dupOrder of duplicateOrders) {
            const dupOrderId = String(dupOrder?.orderId || '');
            if (dupOrderId && dupOrderId !== oldOrderId) {
              try {
                await this.exchangeService.cancelOrder(dupOrderId, position.symbol);
                logger.info(`[ExitOrderManager] ✅ Cancelled duplicate order ${dupOrderId} with same clientOrderId pattern | pos=${position.id} clientOrderId=${expectedClientOrderIdPattern}`);
              } catch (e) {
                logger.warn(`[ExitOrderManager] ⚠️ Failed to cancel duplicate order ${dupOrderId}: ${e?.message || e}`);
              }
            }
          }
        }
      }
    } catch (checkError) {
      // Non-critical: if we can't check, continue anyway
      logger.debug(`[ExitOrderManager] Could not check for duplicate clientOrderId (non-critical): ${checkError?.message || checkError}`);
    }

    // Small delay to ensure cancellation is processed
    await new Promise(resolve => setTimeout(resolve, 100));

    // 2) Create NEW order after old one is cancelled
    let res;
    let newOrderId = null;
    try {
      const isStopOrder = orderType === 'STOP' || orderType === 'STOP_MARKET';
      if (isStopOrder) {
        res = await this.exchangeService.createCloseStopMarket(position.symbol, side, stopPrice, position);
      } else {
        res = await this.exchangeService.createCloseTakeProfitMarket(position.symbol, side, stopPrice, position);
      }

      newOrderId = res?.orderId != null ? String(res.orderId) : null;
      if (newOrderId) {
        position.exit_order_id = newOrderId;
      } else {
        logger.error(
          `[ExitOrderManager] ❌ No orderId in response | pos=${position.id} type=${orderType} response=${JSON.stringify(res)}`
        );
      }
    } catch (createError) {
      const errorMessage = createError?.message || String(createError);
      
      // Handle -2021: immediate trigger → fallback MARKET close
      if (errorMessage.includes('-2021') || errorMessage.includes('would immediately trigger')) {
        try {
          await this.exchangeService.closePosition(position.symbol, side, null);
          return null; // no exit order, position closed by market
        } catch (fallbackError) {
          logger.error(
            `[ExitOrderManager] ❌ FALLBACK FAILED: Could not close position with MARKET order | pos=${position.id} error=${fallbackError?.message || fallbackError}`
          );
          // Return sentinel to indicate we attempted fallback but failed
          return { orderType: 'MARKET_CLOSE_FAILED', stopPrice: null, orderId: null };
        }
      }
      
      // Handle -4116: ClientOrderId duplicated
      if (errorMessage.includes('-4116') || errorMessage.includes('ClientOrderId is duplicated') || errorMessage.includes('duplicated')) {
        logger.warn(
          `[ExitOrderManager] ⚠️ ClientOrderId duplicated error (-4116) | pos=${position.id} type=${orderType} ` +
          `This may indicate a race condition. Will retry after checking and cancelling duplicate orders.`
        );
        
        // Retry: check and cancel any duplicate orders, then retry creation
        try {
          const botId = this.exchangeService?.bot?.id;
          const posId = position?.id;
          if (botId && posId) {
            const expectedClientOrderIdPattern = orderType === 'STOP_MARKET' 
              ? `OC_B${botId}_P${posId}_EXIT`
              : `OC_B${botId}_P${posId}_TP`;
            
            const openOrders = await this.exchangeService.getOpenOrders(position.symbol);
            if (Array.isArray(openOrders)) {
              const exitTypes = new Set(['STOP_MARKET', 'TAKE_PROFIT_MARKET']);
              const positionSide = side === 'long' ? 'LONG' : 'SHORT';
              
              const duplicateOrders = openOrders.filter(o => {
                const type = String(o?.type || '').toUpperCase();
                const ps = String(o?.positionSide || '').toUpperCase();
                const clientOrderId = String(o?.clientOrderId || '');
                return exitTypes.has(type) && 
                       (!ps || ps === positionSide) &&
                       clientOrderId === expectedClientOrderIdPattern;
              });
              
              for (const dupOrder of duplicateOrders) {
                const dupOrderId = String(dupOrder?.orderId || '');
                if (dupOrderId) {
                  try {
                    await this.exchangeService.cancelOrder(dupOrderId, position.symbol);
                    logger.info(`[ExitOrderManager] ✅ Cancelled duplicate order ${dupOrderId} during retry | pos=${position.id}`);
                  } catch (e) {
                    logger.warn(`[ExitOrderManager] ⚠️ Failed to cancel duplicate order ${dupOrderId} during retry: ${e?.message || e}`);
                  }
                }
              }
              
              // Wait a bit for cancellation to process
              await new Promise(resolve => setTimeout(resolve, 200));
              
              // Retry creation
              const isStopOrder = orderType === 'STOP' || orderType === 'STOP_MARKET';
              if (isStopOrder) {
                res = await this.exchangeService.createCloseStopMarket(position.symbol, side, stopPrice, position);
              } else {
                res = await this.exchangeService.createCloseTakeProfitMarket(position.symbol, side, stopPrice, position);
              }
              
              newOrderId = res?.orderId != null ? String(res.orderId) : null;
              if (newOrderId) {
                position.exit_order_id = newOrderId;
                logger.info(`[ExitOrderManager] ✅ Retry successful after cancelling duplicates | pos=${position.id} newOrderId=${newOrderId}`);
              } else {
                throw new Error('Retry failed: no orderId in response');
              }
            } else {
              throw createError; // Re-throw if we can't check
            }
          } else {
            throw createError; // Re-throw if we don't have botId/posId
          }
        } catch (retryError) {
          logger.error(
            `[ExitOrderManager] ❌ Retry failed after -4116 error | pos=${position.id} error=${retryError?.message || retryError}`
          );
          throw createError; // Re-throw original error
        }
      } else {
        logger.error(
          `[ExitOrderManager] ❌ Create error | pos=${position.id} type=${orderType} stopPrice=${stopPrice.toFixed(8)} oldOrderId=${oldOrderId || 'null'} error=${errorMessage} stack=${createError?.stack || 'N/A'} timestamp=${new Date().toISOString()}`
        );
        throw createError;
      }
    }

    const totalDuration = Date.now() - startTime;
    logger.debug(
      `[ExitOrderManager] ✅ COMPLETE | pos=${position.id} oldOrderId=${oldOrderId || 'null'} newOrderId=${newOrderId || 'null'} type=${orderType} stopPrice=${Number(stopPrice).toFixed(8)} totalDuration=${totalDuration}ms timestamp=${new Date().toISOString()}`
    );

    return { orderType, stopPrice, orderId: newOrderId };
  }
}
