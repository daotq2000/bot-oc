import cron from 'node-cron';
import pool from '../config/database.js';
import { Candle } from '../models/Candle.js';
import { configService } from '../services/ConfigService.js';
import logger from '../utils/logger.js';

/**
 * CandlesPruner Job
 * - Prunes candles table by age and/or by keeping last N per (exchange,symbol,interval)
 */
export class CandlesPruner {
  constructor() {
    this.isRunning = false;
    this.cronTask = null;
  }

  async initialize() {
    // nothing to init yet
    return true;
  }

  getConfig() {
    const mode = (configService.getString('CANDLES_PRUNE_MODE', 'age') || 'age').toLowerCase(); // 'age' | 'keep' | 'both'
    const retentionDays = Number(configService.getNumber('CANDLES_RETENTION_DAYS', 3));
    const keepLast = Number(configService.getNumber('CANDLES_KEEP_LAST_PER_INTERVAL', 0)); // 0 = disabled
    const batchLimit = Number(configService.getNumber('CANDLES_PRUNE_BATCH_LIMIT', 500)); // how many keys per run
    const cronExpr = configService.getString('CANDLES_PRUNE_CRON', '0 * * * *'); // hourly
    return { mode, retentionDays, keepLast, batchLimit, cronExpr };
  }

  async listKeys(offset = 0, limit = 1000) {
    // Avoid prepared placeholders in LIMIT to prevent ER_WRONG_ARGUMENTS (1210)
    const off = Math.max(0, Number(offset) | 0);
    const lim = Math.max(1, Number(limit) | 0);

    const sql = `SELECT exchange, symbol, \`interval\`, COUNT(*) as cnt
       FROM candles
       GROUP BY exchange, symbol, \`interval\`
       ORDER BY cnt DESC
       LIMIT ${off}, ${lim}`;

    const [rows] = await pool.query(sql);
    return rows;
  }

  async runOnce() {
    if (this.isRunning) {
      logger.debug('[CandlesPruner] Already running, skip.');
      return;
    }
    this.isRunning = true;

    const { mode, retentionDays, keepLast, batchLimit } = this.getConfig();
    const retentionMs = Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;

    let totalDeleted = 0;
    let processed = 0;
    let offset = 0;

    try {
      while (true) {
        const keys = await this.listKeys(offset, batchLimit);
        if (!keys || keys.length === 0) break;
        for (const k of keys) {
          const ex = k.exchange;
          const sym = k.symbol;
          const iv = k.interval;

          if (mode === 'age' || mode === 'both') {
            const del = await Candle.pruneByAge(ex, sym, iv, retentionMs);
            totalDeleted += del;
          }
          if ((mode === 'keep' || mode === 'both') && Number.isFinite(keepLast) && keepLast > 0) {
            const del = await Candle.pruneByLimit(ex, sym, iv, keepLast);
            totalDeleted += del;
          }
          processed += 1;
        }
        // paginate
        offset += keys.length;
        if (keys.length < batchLimit) break;
      }

      logger.info(`[CandlesPruner] Completed run: processed ${processed} keys, deleted ${totalDeleted} rows`);
      return { processed, totalDeleted };
    } catch (e) {
      logger.error('[CandlesPruner] Error during prune run:', e);
    } finally {
      this.isRunning = false;
    }
  }

  start() {
    const { cronExpr } = this.getConfig();
    this.cronTask = cron.schedule(cronExpr, async () => {
      await this.runOnce();
    });
    // kick first run (non-blocking)
    this.runOnce().catch(() => {});
    logger.info(`[CandlesPruner] Started with cron: ${cronExpr}`);
  }

  stop() {
    if (this.cronTask) {
      this.cronTask.stop();
      this.cronTask = null;
    }
    logger.info('[CandlesPruner] Stopped');
  }
}

export default CandlesPruner;



