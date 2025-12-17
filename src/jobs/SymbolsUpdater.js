import cron from 'node-cron';
import { exchangeInfoService } from '../services/ExchangeInfoService.js';
import { configService } from '../services/ConfigService.js';
import logger from '../utils/logger.js';

/**
 * SymbolsUpdater Job
 * - Refreshes tradable symbols/filters for Binance & MEXC on a schedule
 * - Keeps symbol_filters table and in-memory cache up to date
 */
export class SymbolsUpdater {
  constructor() {
    this.cronTask = null;
    this.isRunning = false;
  }

  async initialize() {
    // No heavy init
    return true;
  }

  getConfig() {
    const enabled = configService.getBoolean('ENABLE_SYMBOLS_REFRESH', true);
    const cronExpr = configService.getString('SYMBOLS_REFRESH_CRON', '*/15 * * * *'); // every 15 minutes
    return { enabled, cronExpr };
  }

  async runOnce() {
    if (this.isRunning) {
      logger.debug('[SymbolsUpdater] Already running, skip.');
      return;
    }
    this.isRunning = true;

    try {
      const { enabled } = this.getConfig();
      if (!enabled) {
        logger.debug('[SymbolsUpdater] Disabled by config ENABLE_SYMBOLS_REFRESH=false');
        return;
      }

      logger.info('[SymbolsUpdater] Refreshing Binance and MEXC symbol filters...');

      // Update Binance first (futures)
      try {
        await exchangeInfoService.updateFiltersFromExchange();
        logger.info('[SymbolsUpdater] Binance symbol filters updated');
      } catch (e) {
        logger.error('[SymbolsUpdater] Binance update failed:', e?.message || e);
      }

      // Update MEXC (swap) with CCXT or fallback REST
      try {
        await exchangeInfoService.updateMexcFiltersFromExchange();
        logger.info('[SymbolsUpdater] MEXC symbol filters updated');
      } catch (e) {
        logger.error('[SymbolsUpdater] MEXC update failed:', e?.message || e);
      }

      logger.info('[SymbolsUpdater] Refresh cycle completed');
    } finally {
      this.isRunning = false;
    }
  }

  start() {
    const { enabled, cronExpr } = this.getConfig();
    if (!enabled) {
      logger.info('[SymbolsUpdater] Not starting (disabled by config)');
      return;
    }

    // Schedule job
    this.cronTask = cron.schedule(cronExpr, async () => {
      await this.runOnce();
    });

    // Kick first run non-blocking
    this.runOnce().catch((e) => logger.warn('[SymbolsUpdater] First run failed:', e?.message || e));

    logger.info(`[SymbolsUpdater] Started with cron: ${cronExpr}`);
  }

  stop() {
    if (this.cronTask) {
      this.cronTask.stop();
      this.cronTask = null;
    }
    logger.info('[SymbolsUpdater] Stopped');
  }
}

export default SymbolsUpdater;

