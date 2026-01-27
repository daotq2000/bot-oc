import { configService } from './ConfigService.js';
import logger from '../utils/logger.js';
import { ATR } from '../indicators/atr.js';
import { Position } from '../models/Position.js';
import { PositionAdjustment } from '../models/PositionAdjustment.js';

export class ATRTrailingService {
  constructor(exchangeService) {
    this.exchangeService = exchangeService;
    this._atrCache = new Map(); // key -> { value, ts }
  }

  async _computeAtr(symbol, timeframe, period) {
    const key = `${symbol}|${timeframe}|${period}`;
    const cached = this._atrCache.get(key);
    const ttlMs = Number(configService.getNumber('ATRTPSL_ATR_CACHE_MS', 60_000));
    if (cached && Date.now() - cached.ts < ttlMs) return cached.value;

    const limit = Math.max(period + 2, 100);
    const candles = await this.exchangeService.fetchOHLCV(symbol, timeframe, limit);
    if (!Array.isArray(candles) || candles.length < period + 1) return null;

    const atr = new ATR(period);
    for (const c of candles) {
      // ExchangeService.fetchOHLCV returns {high, low, close} for non-binance branch.
      // For binance branch it returns CCXT array [ts, open, high, low, close, volume]
      if (Array.isArray(c)) {
        atr.updateCandle({ high: c[2], low: c[3], close: c[4] });
      } else {
        atr.updateCandle({ high: c.high, low: c.low, close: c.close });
      }
    }
    const value = atr.value;
    if (!Number.isFinite(Number(value))) return null;
    this._atrCache.set(key, { value: Number(value), ts: Date.now() });
    return Number(value);
  }

  /**
   * Compute ATR-based TP/SL and trailing SL update.
   * This only updates DB fields + marks tp_sl_pending=true; PositionMonitor will place/refresh orders.
   */
  async apply(position, settings) {
    const enabled = configService.getBoolean('ADV_TPSL_ATR_ENABLED', true) && settings.atr_enabled !== false;
    if (!enabled) return { changed: false };

    const symbol = position.symbol;
    const side = position.side || (Number(position.amount) > 0 ? 'long' : 'short');
    const entry = Number(position.entry_price);
    if (!Number.isFinite(entry)) return { changed: false };

    const timeframe = settings.atr_timeframe || configService.getString('ADV_TPSL_ATR_TIMEFRAME', '1h');
    const period = Number(settings.atr_period || configService.getNumber('ADV_TPSL_ATR_PERIOD', 14));
    const atr = await this._computeAtr(symbol, timeframe, period);
    if (!Number.isFinite(atr)) return { changed: false };

    const multTp = Number(settings.atr_multiplier_tp ?? configService.getNumber('ADV_TPSL_ATR_TP_MULT', 2.5));
    const multSl = Number(settings.atr_multiplier_sl ?? configService.getNumber('ADV_TPSL_ATR_SL_MULT', 1.5));
    const dir = side === 'long' ? 1 : -1;
    const desiredTp = entry + dir * atr * multTp;
    let desiredSl = entry - dir * atr * multSl;

    // Trailing: lock-in ratio of progress toward TP (default 0.5).
    const trailingEnabled = configService.getBoolean('ADV_TPSL_TRAILING_ENABLED', true) && settings.trailing_stop_enabled !== false;
    if (trailingEnabled) {
      const current = Number(await this.exchangeService.getTickerPrice(symbol));
      if (Number.isFinite(current)) {
        const progress = (current - entry) * dir;
        const tpDist = (desiredTp - entry) * dir;
        if (tpDist > 0 && progress > 0) {
          const lockRatio = Number(settings.trailing_lock_in_ratio ?? configService.getNumber('ADV_TPSL_TRAILING_LOCK_RATIO', 0.5));
          const locked = progress * Math.max(0, Math.min(1, lockRatio));
          const trSl = entry + dir * locked;
          if (side === 'long') desiredSl = Math.max(desiredSl, trSl);
          else desiredSl = Math.min(desiredSl, trSl);
        }
      }
    }

    const tpField = position.take_profit_price ?? position.initial_tp_price ?? null;
    const slField = position.stop_loss_price ?? position.sl_price ?? null;
    const prevTp = tpField ? Number(tpField) : null;
    const prevSl = slField ? Number(slField) : null;

    const epsPct = Number(configService.getNumber('ADV_TPSL_PRICE_EPS_PCT', 0.05)); // 0.05% to avoid churn
    const changedTp = !Number.isFinite(prevTp) || Math.abs((desiredTp - prevTp) / prevTp) * 100 > epsPct;
    const changedSl = !Number.isFinite(prevSl) || Math.abs((desiredSl - prevSl) / prevSl) * 100 > epsPct;
    if (!changedTp && !changedSl) return { changed: false, atr };

    const updates = {};
    if (changedTp) updates.take_profit_price = desiredTp;
    if (changedSl) updates.stop_loss_price = desiredSl;
    updates.tp_sl_pending = true;

    await Position.update(position.id, updates);

    if (changedTp) {
      await PositionAdjustment.create({
        position_id: position.id,
        adjustment_type: 'TP',
        old_value: prevTp,
        new_value: desiredTp,
        reason: `ATR TP (${timeframe} p=${period} atr=${atr} mult=${multTp})`
      });
    }
    if (changedSl) {
      await PositionAdjustment.create({
        position_id: position.id,
        adjustment_type: trailingEnabled ? 'TRAILING' : 'SL',
        old_value: prevSl,
        new_value: desiredSl,
        reason: `ATR SL (${timeframe} p=${period} atr=${atr} mult=${multSl})${trailingEnabled ? ' + trailing' : ''}`
      });
    }

    logger.info(
      `[ADV_TPSL][ATR] pos=${position.id} ${symbol} ${side} atr=${atr.toFixed(8)} ` +
      `tp=${changedTp ? desiredTp : 'same'} sl=${changedSl ? desiredSl : 'same'}`
    );
    return { changed: true, atr, desiredTp, desiredSl };
  }
}
