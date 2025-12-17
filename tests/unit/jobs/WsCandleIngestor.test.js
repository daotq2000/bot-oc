import { describe, it, expect, beforeEach, jest } from '@jest/globals';

import { Candle } from '../../../src/models/Candle.js';
import { Strategy } from '../../../src/models/Strategy.js';
import { PriceAlertConfig } from '../../../src/models/PriceAlertConfig.js';
import { configService } from '../../../src/services/ConfigService.js';
import { mexcPriceWs } from '../../../src/services/MexcWebSocketManager.js';
import { WsCandleIngestor } from '../../../src/jobs/WsCandleIngestor.js';

let onPriceHandler = null;

function minuteStart(ts) { return Math.floor(ts / 60000) * 60000; }

function emit(symbol, price, ts) {
  if (onPriceHandler) onPriceHandler({ symbol, price, ts });
}

describe('WsCandleIngestor (integration-mock)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Mock DB/model functions by overriding
    Candle.bulkInsert = jest.fn().mockResolvedValue(1);
    Candle.getCandles = jest.fn();
    Candle.getLatest = jest.fn();

    // Mock Strategy and PriceAlertConfig sources
    Strategy.findAll = jest.fn().mockResolvedValue([
      { id: 1, bot_id: 1, exchange: 'mexc', symbol: 'CYS/USDT', interval: '1m', is_active: true },
      { id: 2, bot_id: 2, exchange: 'binance', symbol: 'BTC/USDT', interval: '1m', is_active: true },
    ]);

    PriceAlertConfig.findAll = jest.fn().mockResolvedValue([
      { id: 10, exchange: 'mexc', symbols: JSON.stringify(['ELX_USDT']), intervals: JSON.stringify(['1m']), threshold: 5, telegram_chat_id: '123', is_active: true },
    ]);

    // Config
    configService.getNumber = jest.fn((key, def) => {
      if (key === 'WS_CANDLE_FLUSH_INTERVAL_MS') return 5000;
      return def || 0;
    });

    // WS manager
    mexcPriceWs.subscribe = jest.fn();
    mexcPriceWs.onPrice = (cb) => { onPriceHandler = cb; };
  });

  it('subscribes normalized symbols from sources', async () => {
    const ing = new WsCandleIngestor();
    await ing.initialize();

    const subArgs = mexcPriceWs.subscribe.mock.calls[0][0];
    expect(subArgs).toEqual(expect.arrayContaining(['CYSUSDT', 'ELXUSDT']));
  });

  it('aggregates 1m ticks and flushes to DB', async () => {
    const ing = new WsCandleIngestor();
    await ing.initialize();

    const now = Date.now();
    const t1 = minuteStart(now) + 1000;
    const t2 = minuteStart(now) + 20000;

    emit('CYS_USDT', 0.2218, t1);
    emit('CYS_USDT', 0.2185, t2);

    await ing.flush();

    expect(Candle.bulkInsert).toHaveBeenCalled();
    const flushed = Candle.bulkInsert.mock.calls[0][0];
    const c = flushed.find(x => x.symbol === 'CYSUSDT');
    expect(c).toBeTruthy();
    expect(c.open_time).toBe(minuteStart(now));
    expect(c.open).toBe(0.2218);
    expect(c.close).toBe(0.2185);
    expect(c.high).toBe(0.2218);
    expect(c.low).toBe(0.2185);
  });

  it('rolls minute and resets open', async () => {
    const ing = new WsCandleIngestor();
    await ing.initialize();

    const now = Date.now();
    const m0 = minuteStart(now);
    const m1 = m0 + 60000;

    emit('ELX_USDT', 0.0042, m0 + 1000);
    await ing.flush();
    let flushed = Candle.bulkInsert.mock.calls.at(-1)[0];
    let c1 = flushed.find(x => x.symbol === 'ELXUSDT');
    expect(c1.open_time).toBe(m0);
    expect(c1.open).toBe(0.0042);

    emit('ELX_USDT', 0.0046, m1 + 300);
    await ing.flush();
    flushed = Candle.bulkInsert.mock.calls.at(-1)[0];
    const c2 = flushed.find(x => x.symbol === 'ELXUSDT');
    expect(c2.open_time).toBe(m1);
    expect(c2.open).toBe(0.0046);
  });
});
