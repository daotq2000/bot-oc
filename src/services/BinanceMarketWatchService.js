import logger from '../utils/logger.js';
import { webSocketManager } from './WebSocketManager.js';
import { exchangeInfoService } from './ExchangeInfoService.js';
import { configService } from './ConfigService.js';

class BinanceMarketWatchService {
  constructor() {
    this._started = false;
    this._symbols = [];
    this._latencyWarnMs = Number(configService.getNumber('BINANCE_WS_LATENCY_WARN_MS', 1200));
    this._maxSymbols = Number(configService.getNumber('BINANCE_WS_MAX_SYMBOLS', 0)); // 0 = unlimited
  }

  async start({ symbols = null } = {}) {
    if (this._started) return;
    this._started = true;

    // Priority: explicit symbols > DB symbol_filters
    let list = [];
    if (Array.isArray(symbols) && symbols.length > 0) {
      list = symbols;
    } else {
      list = await exchangeInfoService.getSymbolsFromDB('binance', true);
    }

    if (Number.isFinite(this._maxSymbols) && this._maxSymbols > 0) {
      list = list.slice(0, this._maxSymbols);
    }

    this._symbols = list;

    logger.info(`[BinanceMarketWatch] Starting WS subscriptions for ${list.length} symbols...`);
    webSocketManager.subscribe(list);

    // Monitor latency and auto-warn
    webSocketManager.onLatency(({ stream, latencyMs }) => {
      if (latencyMs >= this._latencyWarnMs) {
        logger.warn(`[BinanceMarketWatch] WS latency high: ${latencyMs}ms | stream=${stream}`);
      }
    });

    logger.info(`[BinanceMarketWatch] ✅ Started (${list.length} symbols)`);
  }

  getSymbols() {
    return this._symbols.slice();
  }
}

export const binanceMarketWatchService = new BinanceMarketWatchService();

