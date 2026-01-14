import logger from '../utils/logger.js';
import { webSocketManager } from './WebSocketManager.js';
import { configService } from './ConfigService.js';

export class MakerEntryService {
  constructor(exchangeService) {
    this.exchangeService = exchangeService;
    this._pending = new Map(); // key: symbol|side -> { orderId, createdAt }

    this._makerOffsetPct = Number(configService.getNumber('MAKER_ENTRY_OFFSET_PCT', 0.0005));
    this._timeoutMs = Number(configService.getNumber('MAKER_ENTRY_TIMEOUT_MS', 1200));
    this._fallbackToMarket = configService.getBoolean('MAKER_ENTRY_FALLBACK_TO_MARKET', false);
  }

  _getBook(symbol) {
    const b = webSocketManager.getBook(symbol);
    const bid = Number(b?.bid);
    const ask = Number(b?.ask);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
    return { bid, ask };
  }

  async placeMakerEntry(symbol, side, amount, { offsetPct = null, timeoutMs = null, fallbackToMarket = null, positionSide = 'BOTH' } = {}) {
    const s = String(symbol).toUpperCase();
    const sd = String(side).toLowerCase();
    if (sd !== 'buy' && sd !== 'sell') throw new Error(`Invalid side: ${side}`);

    const book = this._getBook(s);
    if (!book) {
      throw new Error(`No bookTicker data for ${s}. Ensure BinanceMarketWatchService started and subscribed.`);
    }

    const pct = Number.isFinite(Number(offsetPct)) ? Number(offsetPct) : this._makerOffsetPct;
    const tmo = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : this._timeoutMs;
    const fb = fallbackToMarket === null || fallbackToMarket === undefined ? this._fallbackToMarket : !!fallbackToMarket;

    // For BUY: place below best ask; For SELL: place above best bid.
    const rawPrice = sd === 'buy'
      ? book.ask * (1 - pct)
      : book.bid * (1 + pct);

    // Use ExchangeService for order placement (BinanceDirectClient underneath)
    const order = await this.exchangeService.createLimitOrder(s, sd, amount, rawPrice, {
      postOnly: true,
      positionSide
    });

    const orderId = String(order?.orderId || order?.id || '');
    if (!orderId) return order;

    const key = `${s}|${sd}`;
    this._pending.set(key, { orderId, createdAt: Date.now() });

    if (tmo > 0) {
      setTimeout(async () => {
        const pending = this._pending.get(key);
        if (!pending || pending.orderId !== orderId) return;

        try {
          const st = await this.exchangeService.getOrderStatus(s, orderId);
          const normalized = String(st?.status || '').toLowerCase();
          const isFilled = normalized === 'filled' || normalized === 'closed';
          if (isFilled) {
            this._pending.delete(key);
            return;
          }

          await this.exchangeService.cancelOrder(orderId, s);
          this._pending.delete(key);

          if (fb) {
            logger.warn(`[MakerEntry] Maker timeout -> fallback MARKET | symbol=${s} side=${sd} orderId=${orderId}`);
            await this.exchangeService.createMarketOrder(s, sd, amount, { positionSide });
          } else {
            logger.info(`[MakerEntry] Maker timeout -> cancelled | symbol=${s} side=${sd} orderId=${orderId}`);
          }
        } catch (e) {
          logger.warn(`[MakerEntry] Timeout handler failed | symbol=${s} orderId=${orderId} err=${e?.message || e}`);
          this._pending.delete(key);
        }
      }, tmo);
    }

    return order;
  }
}

export function createMakerEntryService(exchangeService) {
  return new MakerEntryService(exchangeService);
}

