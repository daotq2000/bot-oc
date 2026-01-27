import { configService } from './ConfigService.js';
import logger from '../utils/logger.js';
import { Position } from '../models/Position.js';
import { PositionPartial } from '../models/PositionPartial.js';
import { PositionAdjustment } from '../models/PositionAdjustment.js';

export class PartialTakeProfitService {
  constructor(exchangeService) {
    this.exchangeService = exchangeService;
  }

  async apply(position, settings) {
    const enabled = configService.getBoolean('ADV_TPSL_PARTIAL_TP_ENABLED', true) && settings.partial_tp_enabled !== false;
    if (!enabled) return { changed: false };

    const levels = Array.isArray(settings.partial_tp_levels) ? settings.partial_tp_levels : [];
    if (levels.length === 0) return { changed: false };

    const symbol = position.symbol;
    const side = position.side || (Number(position.amount) > 0 ? 'long' : 'short');
    const entry = Number(position.entry_price);
    const amount = Number(position.amount);
    if (!Number.isFinite(entry) || !Number.isFinite(amount) || amount <= 0) return { changed: false };

    const current = Number(await this.exchangeService.getTickerPrice(symbol));
    if (!Number.isFinite(current)) return { changed: false };
    const dir = side === 'long' ? 1 : -1;
    const pnlPct = ((current - entry) / entry) * 100 * dir;

    const executed = await PositionPartial.getExecutedLevels(position.id);
    const sorted = [...levels].sort((a, b) => Number(a.pct) - Number(b.pct));
    const next = sorted.find(l => pnlPct >= Number(l.pct) && !executed.includes(Number(l.pct)));
    if (!next) return { changed: false };

    const closePct = Math.max(0, Math.min(100, Number(next.close_pct)));
    const qtyToClose = amount * (closePct / 100);
    if (qtyToClose <= 0) return { changed: false };

    // Execute reduce-only partial close (requires ExchangeService.closePositionQty implementation)
    const res = await this.exchangeService.closePositionQty(symbol, side, qtyToClose);
    const fill = Number(res?.avgFillPrice ?? res?.price ?? current);

    await PositionPartial.create({
      position_id: position.id,
      close_price: fill,
      close_amount: qtyToClose,
      close_pct: closePct,
      pnl: (fill - entry) * qtyToClose * dir,
      pnl_pct: pnlPct,
      reason: `partial_tp_${next.pct}%`
    });

    await PositionAdjustment.create({
      position_id: position.id,
      adjustment_type: 'PARTIAL_CLOSE',
      old_value: amount,
      new_value: amount - qtyToClose,
      reason: `Partial close ${closePct}% at pnlPct=${pnlPct.toFixed(2)}% (lvl=${next.pct}%)`,
      metadata: { level: next, fill }
    });

    await Position.update(position.id, { amount: amount - qtyToClose, tp_sl_pending: true });
    logger.info(`[ADV_TPSL][PartialTP] pos=${position.id} ${symbol} ${side} closed=${qtyToClose} (${closePct}%) fill=${fill}`);
    return { changed: true, level: next, qtyToClose, fill };
  }
}
