import { configService } from './ConfigService.js';
import logger from '../utils/logger.js';
import { Position } from '../models/Position.js';
import { PositionAdjustment } from '../models/PositionAdjustment.js';

/**
 * Support/Resistance manager (simple swing high/low).
 * - Support  = lowest low in lookback
 * - Resistance = highest high in lookback
 *
 * Actions (toggle-driven):
 * - If price is near resistance (long) / support (short): partial close + tighten SL.
 */
export class SupportResistanceService {
  constructor(exchangeService) {
    this.exchangeService = exchangeService;
    this._cache = new Map();
  }

  async _getLevels(symbol, timeframe, lookback) {
    const key = `${symbol}|${timeframe}|${lookback}`;
    const ttlMs = Number(configService.getNumber('ADV_TPSL_SR_CACHE_MS', 60_000));
    const cached = this._cache.get(key);
    if (cached && Date.now() - cached.ts < ttlMs) return cached.value;

    const candles = await this.exchangeService.fetchOHLCV(symbol, timeframe, Math.max(lookback, 50));
    const highs = [];
    const lows = [];
    for (const c of candles || []) {
      const h = Number(Array.isArray(c) ? c[2] : c.high);
      const l = Number(Array.isArray(c) ? c[3] : c.low);
      if (Number.isFinite(h)) highs.push(h);
      if (Number.isFinite(l)) lows.push(l);
    }
    if (highs.length < 10 || lows.length < 10) return null;
    const resistance = Math.max(...highs);
    const support = Math.min(...lows);
    const value = { support, resistance };
    this._cache.set(key, { value, ts: Date.now() });
    return value;
  }

  async apply(position, settings) {
    const enabled = configService.getBoolean('ADV_TPSL_SR_ENABLED', false) && settings.sr_enabled === true;
    if (!enabled) return { changed: false };

    const symbol = position.symbol;
    const side = position.side || (Number(position.amount) > 0 ? 'long' : 'short');
    const entry = Number(position.entry_price);
    const amount = Number(position.amount);
    if (!Number.isFinite(entry) || !Number.isFinite(amount) || amount <= 0) return { changed: false };

    const current = Number(await this.exchangeService.getTickerPrice(symbol));
    if (!Number.isFinite(current)) return { changed: false };

    const tf = configService.getString('ADV_TPSL_SR_TIMEFRAME', '15m');
    const lookback = Number(settings.sr_lookback_period ?? configService.getNumber('ADV_TPSL_SR_LOOKBACK', 50));
    const levels = await this._getLevels(symbol, tf, lookback);
    if (!levels) return { changed: false };

    const { support, resistance } = levels;
    const nearPct = Number(configService.getNumber('ADV_TPSL_SR_NEAR_PCT', 0.25)); // 0.25%
    const distToResPct = resistance > 0 ? (Math.abs(resistance - current) / resistance) * 100 : Infinity;
    const distToSupPct = support > 0 ? (Math.abs(current - support) / support) * 100 : Infinity;

    // Close part when near SR on profitable side
    const partialEnabled = configService.getBoolean('ADV_TPSL_SR_PARTIAL_ENABLED', true);
    const partialClosePct = Number(configService.getNumber('ADV_TPSL_SR_PARTIAL_CLOSE_PCT', 25));
    const tightenEnabled = configService.getBoolean('ADV_TPSL_SR_TIGHTEN_SL_ENABLED', true);
    const tightenToPct = Number(configService.getNumber('ADV_TPSL_SR_TIGHTEN_TO_PCT', 0.3)); // move SL closer to entry by 0.3%

    let changed = false;

    if (side === 'long' && distToResPct <= nearPct) {
      if (partialEnabled) {
        const qty = amount * (Math.max(0, Math.min(100, partialClosePct)) / 100);
        if (qty > 0) {
          await this.exchangeService.closePositionQty(symbol, side, qty);
          await Position.update(position.id, { amount: amount - qty, tp_sl_pending: true });
          await PositionAdjustment.create({
            position_id: position.id,
            adjustment_type: 'PARTIAL_CLOSE',
            old_value: amount,
            new_value: amount - qty,
            reason: `SR partial near resistance (${tf}) res=${resistance} cur=${current}`
          });
          changed = true;
        }
      }
      if (tightenEnabled) {
        const desiredSl = entry * (1 + tightenToPct / 100);
        const prevSl = Number(position.stop_loss_price || position.sl_price || 0) || null;
        if (!Number.isFinite(prevSl) || desiredSl > prevSl) {
          await Position.update(position.id, { stop_loss_price: desiredSl, tp_sl_pending: true });
          await PositionAdjustment.create({
            position_id: position.id,
            adjustment_type: 'SL',
            old_value: prevSl,
            new_value: desiredSl,
            reason: `SR tighten SL near resistance (${tf})`
          });
          changed = true;
        }
      }
      if (changed) logger.info(`[ADV_TPSL][SR] pos=${position.id} ${symbol} long near_res distPct=${distToResPct.toFixed(3)}%`);
      return { changed, support, resistance };
    }

    if (side === 'short' && distToSupPct <= nearPct) {
      if (partialEnabled) {
        const qty = amount * (Math.max(0, Math.min(100, partialClosePct)) / 100);
        if (qty > 0) {
          await this.exchangeService.closePositionQty(symbol, side, qty);
          await Position.update(position.id, { amount: amount - qty, tp_sl_pending: true });
          await PositionAdjustment.create({
            position_id: position.id,
            adjustment_type: 'PARTIAL_CLOSE',
            old_value: amount,
            new_value: amount - qty,
            reason: `SR partial near support (${tf}) sup=${support} cur=${current}`
          });
          changed = true;
        }
      }
      if (tightenEnabled) {
        const desiredSl = entry * (1 - tightenToPct / 100);
        const prevSl = Number(position.stop_loss_price || position.sl_price || 0) || null;
        if (!Number.isFinite(prevSl) || desiredSl < prevSl) {
          await Position.update(position.id, { stop_loss_price: desiredSl, tp_sl_pending: true });
          await PositionAdjustment.create({
            position_id: position.id,
            adjustment_type: 'SL',
            old_value: prevSl,
            new_value: desiredSl,
            reason: `SR tighten SL near support (${tf})`
          });
          changed = true;
        }
      }
      if (changed) logger.info(`[ADV_TPSL][SR] pos=${position.id} ${symbol} short near_sup distPct=${distToSupPct.toFixed(3)}%`);
      return { changed, support, resistance };
    }

    return { changed: false, support, resistance };
  }
}


