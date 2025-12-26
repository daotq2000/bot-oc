import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// We test the internal de-duplication logic that prevents STOP_MARKET exit order spam.
// This is critical to avoid Binance open-order limits.

describe('PositionMonitor - exit order de-duplication (STOP_MARKET/TAKE_PROFIT_MARKET)', () => {
  let PositionMonitor;
  let monitor;

  beforeEach(async () => {
    jest.resetModules();
    ({ PositionMonitor } = await import('../../../src/jobs/PositionMonitor.js'));
    monitor = new PositionMonitor();
  });

  it('should cancel duplicate STOP_MARKET close orders and keep the newest + referenced ids', async () => {
    const exchangeService = {
      bot: { exchange: 'binance' },
      getOpenOrders: jest.fn().mockResolvedValue([
        // multiple exit orders for same symbol
        { orderId: '1', type: 'STOP_MARKET', closePosition: true, positionSide: 'LONG', time: 1 },
        { orderId: '2', type: 'TAKE_PROFIT_MARKET', closePosition: true, positionSide: 'LONG', time: 2 },
        { orderId: '3', type: 'TAKE_PROFIT_MARKET', closePosition: true, positionSide: 'LONG', time: 3 },
      ]),
      cancelOrder: jest.fn().mockResolvedValue({ ok: true }),
    };

    const position = {
      id: 99,
      symbol: 'BTC/USDT',
      side: 'long',
      exit_order_id: '2', // referenced by DB should be kept
      sl_order_id: null,
    };

    await monitor._dedupeCloseOrdersOnExchange(exchangeService, position);

    // Keep ids: '2' (referenced) and '3' (newest). Cancel the remaining '1'.
    expect(exchangeService.cancelOrder).toHaveBeenCalledTimes(1);
    expect(exchangeService.cancelOrder).toHaveBeenCalledWith('1', 'BTC/USDT');
  });

  it('should do nothing when there is only one STOP_MARKET exit order', async () => {
    const exchangeService = {
      bot: { exchange: 'binance' },
      getOpenOrders: jest.fn().mockResolvedValue([
        { orderId: '10', type: 'STOP_MARKET', closePosition: true, positionSide: 'SHORT', time: 10 },
      ]),
      cancelOrder: jest.fn(),
    };

    const position = {
      id: 100,
      symbol: 'ETH/USDT',
      side: 'short',
      exit_order_id: '10',
      sl_order_id: null,
    };

    await monitor._dedupeCloseOrdersOnExchange(exchangeService, position);
    expect(exchangeService.cancelOrder).not.toHaveBeenCalled();
  });
});

