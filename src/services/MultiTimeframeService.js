import { configService } from './ConfigService.js';
import logger from '../utils/logger.js';
import { EMA } from '../indicators/ema.js';
import { RSI } from '../indicators/rsi.js';
import { Position } from '../models/Position.js';
import { PositionAdjustment } from '../models/PositionAdjustment.js';

/**
 * MultiTimeframeService (MTF)
 * Uses EMA20/EMA50 alignment + RSI regime on higher timeframes to decide if we should:
 * - tighten SL
 * - optionally take partial profit
 */
export class MultiTimeframeService {
  constructor(exchangeService) {
    this.exchangeService = exchangeService;
    this._cache = new Map();
  }

  async _snapshot(symbol, timeframe, emaFast = 20, emaSlow = 50, rsiPeriod = 14) {
    const key = `${symbol}|${timeframe}|${emaFast}|${emaSlow}|${rsiPeriod}`;
    const ttlMs = Number(configService.getNumber('ADV_TPSL_MTF_CACHE_MS', 60_000));
    const cached = this._cache.get(key);
    if (cached && Date.now() - cached.ts < ttlMs) return cached.value;

    const limit = Math.max(emaSlow + rsiPeriod + 10, 120);
    const candles = await this.exchangeService.fetchOHLCV(symbol, timeframe, limit);
    const ema20 = new EMA(emaFast);
    const ema50 = new EMA(emaSlow);
    const rsi14 = new RSI(rsiPeriod);
    let lastClose = null;
    for (const c of candles || []) {
      const close = Number(Array.isArray(c) ? c[4] : c.close);
      if (!Number.isFinite(close)) continue;
      lastClose = close;
      ema20.update(close);
      ema50.update(close);
      rsi14.update(close);
    }
    const value = { close: lastClose, ema20: ema20.value, ema50: ema50.value, rsi14: rsi14.value, ema20Slope: ema20.slope() };
    this._cache.set(key, { value, ts: Date.now() });
    return value;
  }

  async apply(position, settings) {
    const enabled = configService.getBoolean('ADV_TPSL_MTF_ENABLED', false) && settings.multi_timeframe_enabled === true;
    if (!enabled) return { changed: false };

    const symbol = position.symbol;
    const side = position.side || (Number(position.amount) > 0 ? 'long' : 'short');
    const entry = Number(position.entry_price);
    const amount = Number(position.amount);
    if (!Number.isFinite(entry) || !Number.isFinite(amount) || amount <= 0) return { changed: false };

    const tfs = Array.isArray(settings.mtf_timeframes) ? settings.mtf_timeframes : configService.getString('ADV_TPSL_MTF_TIMEFRAMES', '1h,4h').split(',').map(s => s.trim()).filter(Boolean);
    if (tfs.length === 0) return { changed: false };

    const current = Number(await this.exchangeService.getTickerPrice(symbol));
    if (!Number.isFinite(current)) return { changed: false };
    const dir = side === 'long' ? 1 : -1;
    const pnlPct = ((current - entry) / entry) * 100 * dir;

    // Determine if higher TF is against our position
    let againstCount = 0;
    const snaps = [];
    for (const tf of tfs) {
      const s = await this._snapshot(symbol, tf);
      snaps.push({ tf, ...s });
      const emaOk = side === 'long' ? (s.close > s.ema20 && s.ema20 > s.ema50 && s.ema20Slope >= 0) : (s.close < s.ema20 && s.ema20 < s.ema50 && s.ema20Slope <= 0);
      const rsiOk = side === 'long' ? (Number(s.rsi14) >= 50) : (Number(s.rsi14) <= 50);
      if (!emaOk || !rsiOk) againstCount += 1;
    }

    const againstMin = Number(configService.getNumber('ADV_TPSL_MTF_AGAINST_MIN', 1));
    const isAgainst = againstCount >= againstMin;
    if (!isAgainst) return { changed: false, pnlPct, snaps };

    // Actions
    const tightenEnabled = configService.getBoolean('ADV_TPSL_MTF_TIGHTEN_SL_ENABLED', true);
    const tightenToPct = Number(configService.getNumber('ADV_TPSL_MTF_TIGHTEN_TO_PCT', 0.15)); // tighten to entry ± 0.15%
    const partialEnabled = configService.getBoolean('ADV_TPSL_MTF_PARTIAL_ENABLED', true);
    const partialClosePct = Number(configService.getNumber('ADV_TPSL_MTF_PARTIAL_CLOSE_PCT', 30));
    const partialMinPnlPct = Number(configService.getNumber('ADV_TPSL_MTF_PARTIAL_MIN_PNL_PCT', 0.5));

    let changed = false;

    if (partialEnabled && pnlPct >= partialMinPnlPct) {
      const qty = amount * (Math.max(0, Math.min(100, partialClosePct)) / 100);
      if (qty > 0) {
        await this.exchangeService.closePositionQty(symbol, side, qty);
        await Position.update(position.id, { amount: amount - qty, tp_sl_pending: true });
        await PositionAdjustment.create({
          position_id: position.id,
          adjustment_type: 'PARTIAL_CLOSE',
          old_value: amount,
          new_value: amount - qty,
          reason: `MTF partial (against ${againstCount}/${tfs.length}) pnlPct=${pnlPct.toFixed(2)}%`,
          metadata: { snaps }
        });
        changed = true;
      }
    }

    if (tightenEnabled) {
      const desiredSl = side === 'long' ? entry * (1 + tightenToPct / 100) : entry * (1 - tightenToPct / 100);
      const prevSl = Number(position.stop_loss_price || position.sl_price || 0) || null;
      const better = !Number.isFinite(prevSl) || (side === 'long' ? desiredSl > prevSl : desiredSl < prevSl);
      if (better) {
        await Position.update(position.id, { stop_loss_price: desiredSl, tp_sl_pending: true });
        await PositionAdjustment.create({
          position_id: position.id,
          adjustment_type: 'SL',
          old_value: prevSl,
          new_value: desiredSl,
          reason: `MTF tighten SL (against ${againstCount}/${tfs.length})`,
          metadata: { snaps }
        });
        changed = true;
      }
    }

    if (changed) {
      logger.warn(`[ADV_TPSL][MTF] pos=${position.id} ${symbol} ${side} against=${againstCount}/${tfs.length} pnlPct=${pnlPct.toFixed(2)}%`);
    }
    return { changed, pnlPct, snaps };
  }
}


