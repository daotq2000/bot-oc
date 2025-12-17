import dotenv from 'dotenv';
import logger from '../src/utils/logger.js';
import { configService } from '../src/services/ConfigService.js';
import { Candle } from '../src/models/Candle.js';
import { mexcPriceWs } from '../src/services/MexcWebSocketManager.js';
import { webSocketManager } from '../src/services/WebSocketManager.js';
import { PriceAlertConfig } from '../src/models/PriceAlertConfig.js';
import { testConnection } from '../src/config/database.js';

dotenv.config();

function normalizeSymbol(s) {
  if (!s) return s;
  return s.toUpperCase().replace(/[/:_]/g, '').replace(/USD$/, 'USDT');
}

function getIntervalMs(interval) {
  const m = interval.match(/^(\d+)m$/i); if (m) return Number(m[1]) * 60_000;
  const h = interval.match(/^(\d+)h$/i); if (h) return Number(h[1]) * 3_600_000;
  return 60_000;
}

function bucketStart(interval, ts = Date.now()) {
  const iv = getIntervalMs(interval);
  return Math.floor(ts / iv) * iv;
}

async function getCurrentPrice(exchange, symbol) {
  const ex = (exchange || 'mexc').toLowerCase();
  if (ex === 'mexc') {
    const p = mexcPriceWs.getPrice(symbol);
    if (Number.isFinite(Number(p))) return Number(p);
  }
  if (ex === 'binance') {
    const p = webSocketManager.getPrice(symbol);
    if (Number.isFinite(Number(p))) return Number(p);
  }
  const c = await Candle.getLatest(ex, symbol, '1m');
  return c ? Number(c.close) : null;
}

async function getOpen(ex, symbol, interval) {
  const now = Date.now();
  if (interval === '1m') {
    const bs = Math.floor(now / 60_000) * 60_000;
    const latest = await Candle.getLatest(ex, symbol, '1m');
    if (!latest) return null;
    if (Number(latest.open_time) === bs) return Number(latest.open);
    return Number(latest.close);
  }
  const ivMs = getIntervalMs(interval);
  const bs = Math.floor(now / ivMs) * ivMs;
  const minutes = Math.max(1, Math.floor(ivMs / 60_000)) + 1;
  const candles = await Candle.getCandles(ex, symbol, '1m', minutes);
  if (!Array.isArray(candles) || candles.length === 0) return null;
  let exact = candles.find(c => Number(c.open_time) === bs);
  if (exact) return Number(exact.open);
  // previous 1m close before bucket
  for (let i = candles.length - 1; i >= 0; i--) {
    const ct = Number(candles[i].open_time);
    if (ct < bs) return Number(candles[i].close);
  }
  return Number(candles[candles.length - 1].close);
}

async function main() {
  const ok = await testConnection();
  if (!ok) { console.error('DB failed'); process.exit(1); }
  await configService.loadAll();

  // Inputs
  const exchange = (process.env.DIAG_EX || 'mexc').toLowerCase();
  const interval = process.env.DIAG_IV || '1m';
  const symbol = normalizeSymbol(process.env.DIAG_SYMBOL || 'FRANKLINUSDT');

  // Ensure WS connections
  try { mexcPriceWs.subscribe([symbol]); } catch(_){}
  try { webSocketManager.subscribe([symbol]); } catch(_){}

  const cfgs = await PriceAlertConfig.findAll(exchange);
  const active = cfgs.find(c => (c.exchange||'').toLowerCase()===exchange);
  const thr = Number(active?.threshold || 0);

  const ex = exchange;
  const open = await getOpen(ex, symbol, interval);
  const price = await getCurrentPrice(ex, symbol);
  const oc = (Number.isFinite(price) && Number.isFinite(open) && open>0)
    ? ((price - open)/open) * 100 : null;

  const res = {
    exchange: ex, symbol, interval,
    bucketStart: bucketStart(interval),
    threshold: thr,
    open, price, oc,
    meets: (oc!==null && Math.abs(oc) >= thr)
  };
  console.log(JSON.stringify(res, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}


