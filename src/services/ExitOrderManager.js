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
    const orderType = this._decideExitType(side, entry, desiredExit);

    const currentPrice = await this.exchangeService.getTickerPrice(position.symbol);
    let stopPrice = Number(desiredExitPrice);

    if (!this._isValidStopVsMarket(orderType, side, stopPrice, currentPrice)) {
      stopPrice = this._nudgeStopPrice(orderType, side, currentPrice);
    }

    const oldOrderId = position?.exit_order_id ? String(position.exit_order_id) : null;

    // 1) Create NEW order first
    let res;
    let newOrderId = null;
    try {
      const isStopOrder = orderType === 'STOP' || orderType === 'STOP_MARKET';
      if (isStopOrder) {
        res = await this.exchangeService.createCloseStopMarket(position.symbol, side, stopPrice);
      } else {
        res = await this.exchangeService.createCloseTakeProfitMarket(position.symbol, side, stopPrice);
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
      
      logger.error(
        `[ExitOrderManager] ❌ Create error | pos=${position.id} type=${orderType} stopPrice=${stopPrice.toFixed(8)} oldOrderId=${oldOrderId || 'null'} error=${errorMessage} stack=${createError?.stack || 'N/A'} timestamp=${new Date().toISOString()}`
      );
      throw createError;
    }

    // 2) Cancel OLD order after new is created (best-effort)
    if (oldOrderId && oldOrderId !== newOrderId) {
      try {
        await this.exchangeService.cancelOrder(oldOrderId, position.symbol);
      } catch (_) {
        // Non-critical
      }
    }

    const totalDuration = Date.now() - startTime;
    logger.debug(
      `[ExitOrderManager] ✅ COMPLETE | pos=${position.id} oldOrderId=${oldOrderId || 'null'} newOrderId=${newOrderId || 'null'} type=${orderType} stopPrice=${Number(stopPrice).toFixed(8)} totalDuration=${totalDuration}ms timestamp=${new Date().toISOString()}`
    );

    return { orderType, stopPrice, orderId: newOrderId };
  }
}
