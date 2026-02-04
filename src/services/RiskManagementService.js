import { configService } from './ConfigService.js';
import logger from '../utils/logger.js';
import { ATR } from '../indicators/atr.js';
import { Position } from '../models/Position.js';
import { PositionAdjustment } from '../models/PositionAdjustment.js';

export class RiskManagementService {
  constructor(exchangeService) {
    this.exchangeService = exchangeService;
    this._atrCache = new Map();
  }

  async _computeAtrPct(symbol, timeframe, period, price) {
    const key = `${symbol}|${timeframe}|${period}`;
    const cached = this._atrCache.get(key);
    const ttlMs = Number(configService.getNumber('ADV_TPSL_RISK_ATR_CACHE_MS', 60_000));
    if (cached && Date.now() - cached.ts < ttlMs) return cached.value;

    const limit = Math.max(period + 2, 100);
    const candles = await this.exchangeService.fetchOHLCV(symbol, timeframe, limit);
    const atr = new ATR(period);
    for (const c of candles) {
      if (Array.isArray(c)) atr.updateCandle({ high: c[2], low: c[3], close: c[4] });
      else atr.updateCandle({ high: c.high, low: c.low, close: c.close });
    }
    const v = atr.value;
    const pct = Number.isFinite(v) && Number.isFinite(price) && price > 0 ? (Number(v) / price) * 100 : null;
    this._atrCache.set(key, { value: pct, ts: Date.now() });
    return pct;
  }

  async apply(position, settings) {
    const enabled = configService.getBoolean('ADV_TPSL_RISK_ENABLED', true);
    if (!enabled) return { changed: false };

    const symbol = position.symbol;
    const side = position.side || (Number(position.amount) > 0 ? 'long' : 'short');
    const entry = Number(position.entry_price);
    if (!Number.isFinite(entry)) return { changed: false };
    const current = Number(await this.exchangeService.getTickerPrice(symbol));
    if (!Number.isFinite(current)) return { changed: false };
    const dir = side === 'long' ? 1 : -1;
    const pnlPct = ((current - entry) / entry) * 100 * dir;

    let changed = false;

    // 2) Break-even
    const beEnabled = configService.getBoolean('ADV_TPSL_BREAK_EVEN_ENABLED', true) && settings.break_even_enabled !== false;
    if (beEnabled) {
      const bePct = Number(settings.break_even_pct ?? configService.getNumber('ADV_TPSL_BREAK_EVEN_PCT', 1.5));
      const bufPct = Number(settings.break_even_buffer_pct ?? configService.getNumber('ADV_TPSL_BREAK_EVEN_BUFFER_PCT', 0.1));
      if (pnlPct >= bePct) {
        const desiredSl = side === 'long' ? entry * (1 + bufPct / 100) : entry * (1 - bufPct / 100);
        const prevSl = Number(position.stop_loss_price || position.sl_price || 0) || null;
        const better =
          !Number.isFinite(prevSl) ||
          (side === 'long' ? desiredSl > prevSl : desiredSl < prevSl);
        if (better) {
          await Position.update(position.id, { stop_loss_price: desiredSl, tp_sl_pending: true });
          await PositionAdjustment.create({
            position_id: position.id,
            adjustment_type: 'BREAKEVEN',
            old_value: prevSl,
            new_value: desiredSl,
            reason: `Break-even at pnlPct=${pnlPct.toFixed(2)}%`
          });
          changed = true;
        }
      }
    }

    // 4) Risk/Reward adjust TP if RR < min
    const rrEnabled = configService.getBoolean('ADV_TPSL_RR_ENABLED', true) && settings.rr_enabled !== false;
    if (rrEnabled) {
      const minRR = Number(settings.min_rr_ratio ?? configService.getNumber('ADV_TPSL_MIN_RR', 2.0));
      const tp = Number(position.take_profit_price || position.initial_tp_price || 0) || null;
      const sl = Number(position.stop_loss_price || position.sl_price || 0) || null;
      if (Number.isFinite(tp) && Number.isFinite(sl) && sl !== entry) {
        const profitDist = Math.abs(tp - entry);
        const lossDist = Math.abs(entry - sl);
        if (lossDist > 0) {
          const rr = profitDist / lossDist;
          if (rr < minRR) {
            const needProfit = lossDist * minRR;
            const desiredTp = side === 'long' ? entry + needProfit : entry - needProfit;
            const better = side === 'long' ? desiredTp > tp : desiredTp < tp;
            if (better) {
              await Position.update(position.id, { take_profit_price: desiredTp, tp_sl_pending: true });
              await PositionAdjustment.create({
                position_id: position.id,
                adjustment_type: 'RR_ADJUST',
                old_value: tp,
                new_value: desiredTp,
                reason: `RR adjust rr=${rr.toFixed(2)} < ${minRR}`
              });
              changed = true;
            }
          }
        }
      }
      }

    // 7) Low-volatility exit (optional; default off)
    const lowVolEnabled =
      configService.getBoolean('ADV_TPSL_LOW_VOL_EXIT_ENABLED', false) && settings.low_volatility_exit_enabled === true;
    if (lowVolEnabled) {
      const tf = configService.getString('ADV_TPSL_LOW_VOL_TIMEFRAME', '1h');
      const period = Number(configService.getNumber('ADV_TPSL_LOW_VOL_ATR_PERIOD', 14));
      const atrPct = await this._computeAtrPct(symbol, tf, period, current);
      const thr = Number(settings.atr_low_threshold_pct ?? configService.getNumber('ADV_TPSL_LOW_VOL_ATR_PCT', 0.25));
      if (Number.isFinite(atrPct) && atrPct < thr) {
        // Close position to avoid ranging dead-zone
        await this.exchangeService.closePosition(symbol, side, position.amount);
        logger.warn(`[ADV_TPSL][LowVolExit] pos=${position.id} ${symbol} atrPct=${atrPct.toFixed(4)} < ${thr}`);
        changed = true;
      }
    }

    // 5) Volume profile (alert-only for now, safe, doesn't change orders)
    const volEnabled = configService.getBoolean('ADV_TPSL_VOLUME_PROFILE_ENABLED', true) && settings.volume_profile_enabled !== false;
    if (volEnabled) {
      try {
        const tf = configService.getString('ADV_TPSL_VOLUME_TIMEFRAME', '1m');
        const n = Number(settings.volume_ma_period ?? configService.getNumber('ADV_TPSL_VOLUME_MA_PERIOD', 20));
        const candles = await this.exchangeService.fetchOHLCV(symbol, tf, Math.max(n + 2, 50));
        const vols = (candles || []).map(c => Number(Array.isArray(c) ? c[5] : c.volume)).filter(v => Number.isFinite(v));
        if (vols.length >= n + 1) {
          const last = vols[vols.length - 1];
          const ma = vols.slice(vols.length - 1 - n, vols.length - 1).reduce((a, b) => a + b, 0) / n;
          const spikeMul = Number(settings.volume_spike_multiplier ?? configService.getNumber('ADV_TPSL_VOLUME_SPIKE_MULT', 2.0));
          const dropMul = Number(settings.volume_drop_multiplier ?? configService.getNumber('ADV_TPSL_VOLUME_DROP_MULT', 0.5));
          if (ma > 0 && last > ma * spikeMul) {
            logger.warn(`[ADV_TPSL][Volume] spike ${symbol} last=${last} ma=${ma.toFixed(2)} x${(last/ma).toFixed(2)}`);
          } else if (ma > 0 && last < ma * dropMul) {
            logger.info(`[ADV_TPSL][Volume] drop ${symbol} last=${last} ma=${ma.toFixed(2)} x${(last/ma).toFixed(2)}`);
          }
        }
      } catch (e) {
        logger.debug(`[ADV_TPSL][Volume] error ${symbol}: ${e?.message || e}`);
      }
      }
      
    // 6) Support/Resistance & 8) MTF & 9) loss streak & 10) optimize
    // Implemented as toggles + no-op placeholders here to keep safe; executed by separate modules/scripts later.
    // (We log that they are enabled but not yet acting, so you can test toggle plumbing without risking trades.)
    const srEnabled = configService.getBoolean('ADV_TPSL_SR_ENABLED', false) && settings.sr_enabled === true;
    if (srEnabled) logger.debug(`[ADV_TPSL][SR] enabled (no-op) pos=${position.id}`);

    const mtfEnabled = configService.getBoolean('ADV_TPSL_MTF_ENABLED', false) && settings.multi_timeframe_enabled === true;
    if (mtfEnabled) logger.debug(`[ADV_TPSL][MTF] enabled (no-op) pos=${position.id}`);

    const lossEnabled = configService.getBoolean('ADV_TPSL_LOSS_STREAK_ENABLED', false) && settings.loss_streak_enabled === true;
    if (lossEnabled) logger.debug(`[ADV_TPSL][LossStreak] enabled (no-op) pos=${position.id}`);

    const optEnabled = configService.getBoolean('ADV_TPSL_AUTO_OPTIMIZE_ENABLED', false) && settings.auto_optimize_enabled === true;
    if (optEnabled) logger.debug(`[ADV_TPSL][AutoOptimize] enabled (no-op) pos=${position.id}`);

    return { changed, pnlPct };
  }
}

/**
 * Backward-compatible singleton API used by PositionService (older risk module).
 * These are lightweight calculations only (no exchange calls).
 */
export const riskManagementService = {
  /**
   * Decide whether to move SL to break-even (pure check).
   * @returns {{shouldMove:boolean,newStopLoss:number,reason:string}|{shouldMove:false}}
   */
  shouldMoveSLToBreakeven(position, currentPrice) {
    const beEnabled = configService.getBoolean('ADV_TPSL_BREAK_EVEN_ENABLED', true);
    if (!beEnabled) return { shouldMove: false };
    const entry = Number(position?.entry_price);
    const cur = Number(currentPrice);
    const side = position?.side;
    if (!Number.isFinite(entry) || !Number.isFinite(cur) || (side !== 'long' && side !== 'short')) return { shouldMove: false };
    const dir = side === 'long' ? 1 : -1;
    const pnlPct = ((cur - entry) / entry) * 100 * dir;
    const trigger = Number(configService.getNumber('ADV_TPSL_BREAK_EVEN_PCT', 1.5));
    const bufferPct = Number(configService.getNumber('ADV_TPSL_BREAK_EVEN_BUFFER_PCT', 0.1));
    if (pnlPct < trigger) return { shouldMove: false };
    const newStopLoss = side === 'long' ? entry * (1 + bufferPct / 100) : entry * (1 - bufferPct / 100);
    return { shouldMove: true, newStopLoss, reason: `breakeven pnlPct=${pnlPct.toFixed(2)}>=${trigger}` };
  },

  /**
   * Advanced trailing SL with profit lock levels.
   * Implements tiered profit protection:
   * - Level 1: When profit >= 1%, move SL to breakeven + small buffer
   * - Level 2: When profit >= 2%, lock 30% of profit
   * - Level 3: When profit >= 3%, lock 50% of profit
   * - Level 4: When profit >= 5%, lock 70% of profit
   * @returns {{shouldTrail:boolean,newStopLoss:number,reason:string}|{shouldTrail:false}}
   */
  calculateTrailingSL(position, currentPrice) {
    const trailingEnabled = configService.getBoolean('ADV_TPSL_TRAILING_ENABLED', true);
    if (!trailingEnabled) return { shouldTrail: false };
    
    const entry = Number(position?.entry_price);
    const cur = Number(currentPrice);
    const side = position?.side;
    const prevSL = Number(position?.stop_loss_price || 0);
    
    if (!Number.isFinite(entry) || !Number.isFinite(cur) || (side !== 'long' && side !== 'short')) {
      return { shouldTrail: false };
    }
    
    const dir = side === 'long' ? 1 : -1;
    const progress = (cur - entry) * dir; // Profit in price terms
    const pnlPct = (progress / entry) * 100; // Profit percentage
    
    if (progress <= 0) return { shouldTrail: false };
    
    // Define profit lock levels (configurable)
    // Format: [profitPct, lockRatio] - when profit >= profitPct%, lock lockRatio% of profit
    const defaultLevels = [
      [1.0, 0.0],   // Level 1: >= 1% profit → breakeven (lock 0%, just protect capital)
      [2.0, 0.30],  // Level 2: >= 2% profit → lock 30% of profit
      [3.0, 0.50],  // Level 3: >= 3% profit → lock 50% of profit
      [5.0, 0.70],  // Level 4: >= 5% profit → lock 70% of profit
      [8.0, 0.80],  // Level 5: >= 8% profit → lock 80% of profit
    ];
    
    // Allow custom levels via config (JSON array)
    let levels = defaultLevels;
    try {
      const customLevels = configService.getString('ADV_TPSL_PROFIT_LOCK_LEVELS', '');
      if (customLevels) {
        const parsed = JSON.parse(customLevels);
        if (Array.isArray(parsed) && parsed.length > 0) {
          levels = parsed;
        }
      }
    } catch (_) {
      // Use default levels if parsing fails
    }
    
    // Sort levels by profit threshold (ascending)
    levels.sort((a, b) => a[0] - b[0]);
    
    // Find the highest applicable level
    let applicableLevel = null;
    for (const level of levels) {
      if (pnlPct >= level[0]) {
        applicableLevel = level;
      }
    }
    
    if (!applicableLevel) {
      return { shouldTrail: false };
    }
    
    const [triggerPct, lockRatio] = applicableLevel;
    const bufferPct = Number(configService.getNumber('ADV_TPSL_TRAILING_BUFFER_PCT', 0.1)); // Small buffer to avoid slippage
    
    // Calculate new SL: entry + (profit * lockRatio) + buffer
    const locked = progress * lockRatio;
    const buffer = entry * (bufferPct / 100) * dir;
    let newStopLoss = entry + dir * locked + buffer;
    
    // Ensure SL only moves in favorable direction (never worse than current SL)
    if (prevSL > 0) {
      if (side === 'long' && newStopLoss <= prevSL) {
        return { shouldTrail: false }; // Don't move SL backwards for LONG
      }
      if (side === 'short' && newStopLoss >= prevSL) {
        return { shouldTrail: false }; // Don't move SL backwards for SHORT
      }
    }
    
    const reason = `profitLock level=${triggerPct}% lockRatio=${(lockRatio*100).toFixed(0)}% pnl=${pnlPct.toFixed(2)}%`;
    return { shouldTrail: true, newStopLoss, reason };
  }
};