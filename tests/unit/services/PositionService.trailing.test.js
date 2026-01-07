import { describe, it, expect, beforeEach, jest } from '@jest/globals';

import { PositionService } from '../../../src/services/PositionService.js';

// --- Mocks ---
const mockExchangeService = {
  getTickerPrice: jest.fn(),
  cancelOrder: jest.fn().mockResolvedValue({ ok: true }),
  getClosableQuantity: jest.fn().mockResolvedValue(0.1),
  closePosition: jest.fn().mockResolvedValue({ ok: true }),
};

// Mock ExitOrderManager used inside PositionService
// NOTE: PositionService does `await import('./ExitOrderManager.js')`.
// From this test file location, the correct module path is: ../../../src/services/ExitOrderManager.js
jest.mock(new URL('../../../src/services/ExitOrderManager.js', import.meta.url).pathname, () => {
  return {
    ExitOrderManager: class {
      constructor() {}
      placeOrReplaceExitOrder = jest.fn(async (_position, desiredExitPrice) => {
        // Return a fake order that always changes orderId to prove replacement
        const type = desiredExitPrice > Number(_position.entry_price) ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET';
        return { orderType: type, stopPrice: desiredExitPrice, orderId: `ord_${Math.round(desiredExitPrice)}` };
      });
    },
  };
});

// Mock DB model calls inside PositionService
jest.mock('../../../src/models/Position.js', () => {
  return {
    Position: {
      // emulate Sequelize model metadata so PositionService can decide whether tp_synced exists
      rawAttributes: {},
      update: jest.fn(async (_id, data) => ({ id: _id, ...data })),
      findById: jest.fn(async (id) => ({ id })),
      close: jest.fn(async (id) => ({ id, status: 'closed' })),
    },
  };
});

jest.mock('../../../src/models/Strategy.js', () => {
  return {
    Strategy: {
      findById: jest.fn(async () => ({ id: 1, stoploss: 0 })),
    },
  };
});

// --- Fixtures ---
function makePosition({
  side = 'long',
  openedAtMs,
  prevMinutes = 0,
  reduce = 10,
  upReduce = 10,
  entry = 100000,
  initialTp = 110000,
  currentTp = 110000,
} = {}) {
  return {
    id: 1,
    bot_id: 1,
    strategy_id: 1,
    symbol: 'BTC/USDT',
    side,
    entry_price: entry,
    amount: 100,
    opened_at: new Date(openedAtMs).toISOString(),
    minutes_elapsed: prevMinutes,
    reduce,
    up_reduce: upReduce,
    take_profit_price: currentTp,
    initial_tp_price: initialTp,
    exit_order_id: 'old_exit',
    stop_loss_price: null,
    status: 'open',
  };
}

describe('PositionService - Trailing TP should move each minute', () => {
  let svc;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new PositionService(mockExchangeService, null);
    mockExchangeService.getTickerPrice.mockResolvedValue(100000);
  });

  it('time-based minutes_elapsed: when < 1 minute passed => TP should NOT move', async () => {
    const now = Date.now();
    // opened 30s ago => actualMinutesElapsed=0
    const position = makePosition({ openedAtMs: now - 30_000, prevMinutes: 0, initialTp: 110000, currentTp: 110000, reduce: 10, entry: 100000 });

    await svc.updatePosition(position);

    expect(Position.update).toHaveBeenCalled();
    // Should only update pnl, not take_profit_price
    const payload = Position.update.mock.calls[0][1];
    expect(payload.take_profit_price).toBeUndefined();
  });

  it('time-based minutes_elapsed: after 1 minute => TP should move (and exit order replaced)', async () => {
    const now = Date.now();
    // opened 70s ago => actualMinutesElapsed=1
    const position = makePosition({ openedAtMs: now - 70_000, prevMinutes: 0, initialTp: 110000, currentTp: 110000, reduce: 10, entry: 100000 });

    await svc.updatePosition(position);

    // We should have updated take_profit_price at least once
    const calls = Position.update.mock.calls.map((c) => c[1]);
    const anyTpUpdate = calls.some((p) => p.take_profit_price !== undefined);
    expect(anyTpUpdate).toBe(true);
  });

  it('time-based minutes_elapsed: TP should move step-by-step (not jump) even if many minutes passed', async () => {
    const now = Date.now();
    // opened 10 minutes ago => actualMinutesElapsed=10, prevMinutes=0
    // Code clamps to process only 1 minute per call.
    const position = makePosition({ openedAtMs: now - 10 * 60_000, prevMinutes: 0, initialTp: 110000, currentTp: 110000, reduce: 10, entry: 100000 });

    await svc.updatePosition(position);

    // minutes_elapsed update payload should be prevMinutes+1
    const minutesPayload = Position.update.mock.calls.find((c) => c[1].minutes_elapsed !== undefined)?.[1];
    expect(minutesPayload.minutes_elapsed).toBe(1);
  });
});

