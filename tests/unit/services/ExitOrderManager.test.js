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

  it('should use atomic replace: create new order FIRST, then cancel old order', async () => {
    const position = { id: 5, status: 'open', symbol: 'BTC/USDT', side: 'long', entry_price: 100, exit_order_id: 'old' };

    // Track call order
    const callOrder = [];
    exchangeService.createCloseTakeProfitMarket.mockImplementation(() => {
      callOrder.push('create');
      return Promise.resolve({ orderId: 'new' });
    });
    exchangeService.cancelOrder.mockImplementation(() => {
      callOrder.push('cancel');
      return Promise.resolve({ ok: true });
    });

    await mgr.placeOrReplaceExitOrder(position, 110);
    
    // Verify atomic replace: create BEFORE cancel
    expect(callOrder).toEqual(['create', 'cancel']);
    expect(exchangeService.createCloseTakeProfitMarket).toHaveBeenCalled();
    expect(exchangeService.cancelOrder).toHaveBeenCalledWith('old', 'BTC/USDT');
    expect(position.exit_order_id).toBe('new'); // New order ID is set
  });

  it('should NOT cancel old order if new order creation fails', async () => {
    const position = { id: 6, status: 'open', symbol: 'BTC/USDT', side: 'long', entry_price: 100, exit_order_id: 'old' };

    exchangeService.createCloseTakeProfitMarket.mockRejectedValue(new Error('Create failed'));

    await expect(mgr.placeOrReplaceExitOrder(position, 110)).rejects.toThrow('Create failed');
    
    // Old order should NOT be cancelled if new order creation fails
    expect(exchangeService.cancelOrder).not.toHaveBeenCalled();
    expect(position.exit_order_id).toBe('old'); // Old order ID preserved
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

