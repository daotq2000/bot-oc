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

    if (side === 'long') {
      return exit > entry ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET';
    }
    // short
    return exit < entry ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET';
  }

  _isValidStopVsMarket(type, side, stopPrice, currentPrice) {
    const stop = Number(stopPrice);
    const cur = Number(currentPrice);
    if (!Number.isFinite(stop) || !Number.isFinite(cur) || cur <= 0) return true;

    if (side === 'long') {
      // LONG closes with SELL
      if (type === 'TAKE_PROFIT_MARKET') return stop > cur;
      return stop < cur; // STOP_MARKET
    }

    // SHORT closes with BUY
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
    if (!position || position.status !== 'open') return null;

    const entry = Number(position?.entry_price || 0);
    const side = position?.side;
    if (side !== 'long' && side !== 'short') throw new Error(`Invalid position.side: ${side}`);
    if (!Number.isFinite(entry) || entry <= 0) throw new Error(`Invalid entry_price for pos=${position.id}: ${position?.entry_price}`);

    // 1) cancel old
    await this._cancelExistingExitOrder(position);

    // 2) decide type
    const orderType = this._decideExitType(side, entry, desiredExitPrice);

    // 3) validate stopPrice vs market and nudge if needed
    const currentPrice = await this.exchangeService.getTickerPrice(position.symbol);
    let stopPrice = Number(desiredExitPrice);

    if (!this._isValidStopVsMarket(orderType, side, stopPrice, currentPrice)) {
      stopPrice = this._nudgeStopPrice(orderType, side, currentPrice);
      logger.warn(
        `[ExitOrderManager] stopPrice invalid vs market, nudged. pos=${position.id} type=${orderType} side=${side} ` +
        `desired=${desiredExitPrice} current=${currentPrice} final=${stopPrice}`
      );
    }

    // 4) place
    let res;
    if (orderType === 'STOP_MARKET') {
      res = await this.exchangeService.createCloseStopMarket(position.symbol, side, stopPrice);
    } else {
      res = await this.exchangeService.createCloseTakeProfitMarket(position.symbol, side, stopPrice);
    }

    const orderId = res?.orderId ? String(res.orderId) : null;
    if (orderId) {
      position.exit_order_id = orderId;
    }

    return { orderType, stopPrice, orderId };
  }
}
