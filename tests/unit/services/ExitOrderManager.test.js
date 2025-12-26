import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ExitOrderManager } from '../../../src/services/ExitOrderManager.js';

describe('ExitOrderManager', () => {
  let exchangeService;
  let mgr;

  beforeEach(() => {
    exchangeService = {
      getTickerPrice: jest.fn().mockResolvedValue(100),
      cancelOrder: jest.fn().mockResolvedValue({ ok: true }),
      createCloseStopMarket: jest.fn().mockResolvedValue({ orderId: 'stop1' }),
      createCloseTakeProfitMarket: jest.fn().mockResolvedValue({ orderId: 'tp1' }),
    };
    mgr = new ExitOrderManager(exchangeService);
  });

  it('LONG: exitPrice > entry => TAKE_PROFIT_MARKET', async () => {
    const position = { id: 1, status: 'open', symbol: 'BTC/USDT', side: 'long', entry_price: 100, exit_order_id: null };
    const res = await mgr.placeOrReplaceExitOrder(position, 110);

    expect(res.orderType).toBe('TAKE_PROFIT_MARKET');
    expect(exchangeService.createCloseTakeProfitMarket).toHaveBeenCalled();
    expect(exchangeService.createCloseStopMarket).not.toHaveBeenCalled();
  });

  it('LONG: exitPrice <= entry => STOP_MARKET', async () => {
    const position = { id: 2, status: 'open', symbol: 'BTC/USDT', side: 'long', entry_price: 100, exit_order_id: null };
    const res = await mgr.placeOrReplaceExitOrder(position, 100);

    expect(res.orderType).toBe('STOP_MARKET');
    expect(exchangeService.createCloseStopMarket).toHaveBeenCalled();
    expect(exchangeService.createCloseTakeProfitMarket).not.toHaveBeenCalled();
  });

  it('SHORT: exitPrice < entry => TAKE_PROFIT_MARKET', async () => {
    const position = { id: 3, status: 'open', symbol: 'BTC/USDT', side: 'short', entry_price: 100, exit_order_id: null };
    const res = await mgr.placeOrReplaceExitOrder(position, 90);

    expect(res.orderType).toBe('TAKE_PROFIT_MARKET');
    expect(exchangeService.createCloseTakeProfitMarket).toHaveBeenCalled();
  });

  it('SHORT: exitPrice >= entry => STOP_MARKET', async () => {
    const position = { id: 4, status: 'open', symbol: 'BTC/USDT', side: 'short', entry_price: 100, exit_order_id: null };
    const res = await mgr.placeOrReplaceExitOrder(position, 101);

    expect(res.orderType).toBe('STOP_MARKET');
    expect(exchangeService.createCloseStopMarket).toHaveBeenCalled();
  });

  it('should cancel existing exit order before placing a new one', async () => {
    const position = { id: 5, status: 'open', symbol: 'BTC/USDT', side: 'long', entry_price: 100, exit_order_id: 'old' };

    await mgr.placeOrReplaceExitOrder(position, 110);
    expect(exchangeService.cancelOrder).toHaveBeenCalledWith('old', 'BTC/USDT');
  });

  it('nudge: LONG TAKE_PROFIT_MARKET must have stopPrice > currentPrice', async () => {
    exchangeService.getTickerPrice.mockResolvedValue(100);

    const position = { id: 6, status: 'open', symbol: 'BTC/USDT', side: 'long', entry_price: 90, exit_order_id: null };

    // desiredExitPrice=95 => profit zone (95>90) => TP_MARKET but invalid vs currentPrice(100)
    const res = await mgr.placeOrReplaceExitOrder(position, 95);

    expect(res.orderType).toBe('TAKE_PROFIT_MARKET');
    // after nudge, stopPrice should be > 100
    expect(res.stopPrice).toBeGreaterThan(100);
  });
});

