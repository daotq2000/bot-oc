import cron from 'node-cron';
import { exchangeInfoService } from '../services/ExchangeInfoService.js';
import { configService } from '../services/ConfigService.js';
import logger from '../utils/logger.js';

/**
 * SymbolsUpdater Job
 * - Refreshes tradable symbols/filters for Binance & MEXC on a schedule
 * - Keeps symbol_filters table and in-memory cache up to date
 * 
 * Features:
 * - Watchdog timeout to prevent isRunning lock
 * - Parallel exchange updates for better performance
 * - Per-exchange failure tracking with backoff
 * - Cron expression validation
 * - UTC timezone for consistent scheduling
 */
export class SymbolsUpdater {
  constructor() {
    this.cronTask = null;
    this.isRunning = false;
    this._watchdogTimer = null; // Timeout guard for isRunning
    
    // CRITICAL FIX: Track failures per exchange for backoff
    this._exchangeFailures = {
      binance: { count: 0, lastFailure: 0 },
      mexc: { count: 0, lastFailure: 0 }
    };
    this._maxFailuresBeforeBackoff = Number(configService.getNumber('SYMBOLS_UPDATE_MAX_FAILURES', 3));
    this._backoffDurationMs = Number(configService.getNumber('SYMBOLS_UPDATE_BACKOFF_MS', 30 * 60 * 1000)); // 30 minutes
  }

  async initialize() {
    // No heavy init
    return true;
  }

  getConfig() {
    const enabled = configService.getBoolean('ENABLE_SYMBOLS_REFRESH', true);
    const cronExpr = configService.getString('SYMBOLS_REFRESH_CRON', '*/15 * * * *'); // every 15 minutes
    const timezone = configService.getString('SYMBOLS_REFRESH_TIMEZONE', 'UTC');
    const watchdogTimeoutMs = Number(configService.getNumber('SYMBOLS_UPDATE_WATCHDOG_TIMEOUT_MS', 10 * 60 * 1000)); // 10 minutes
    
    // CRITICAL FIX: Validate cron expression
    if (!cron.validate(cronExpr)) {
      logger.error(`[SymbolsUpdater] Invalid cron expression: ${cronExpr}. Using default: */15 * * * *`);
      return { enabled, cronExpr: '*/15 * * * *', timezone, watchdogTimeoutMs };
    }
    
    return { enabled, cronExpr, timezone, watchdogTimeoutMs };
  }
  
  /**
   * CRITICAL FIX: Check if exchange should be skipped due to backoff
   * @param {string} exchange - Exchange name (binance, mexc)
   * @returns {boolean} True if exchange should be skipped
   */
  _shouldSkipExchange(exchange) {
    const failures = this._exchangeFailures[exchange];
    if (!failures) return false;
    
    const now = Date.now();
    const timeSinceLastFailure = now - failures.lastFailure;
    
    // If failures exceed threshold and still in backoff period, skip
    if (failures.count >= this._maxFailuresBeforeBackoff && 
        timeSinceLastFailure < this._backoffDurationMs) {
      const remainingMinutes = Math.ceil((this._backoffDurationMs - timeSinceLastFailure) / 60000);
      logger.warn(`[SymbolsUpdater] Skipping ${exchange} update (backoff: ${remainingMinutes} minutes remaining)`);
      return true;
    }
    
    // Reset failure count if backoff period has passed
    if (timeSinceLastFailure >= this._backoffDurationMs) {
      failures.count = 0;
      failures.lastFailure = 0;
    }
    
    return false;
  }
  
  /**
   * CRITICAL FIX: Record exchange failure for backoff tracking
   * @param {string} exchange - Exchange name (binance, mexc)
   */
  _recordExchangeFailure(exchange) {
    if (!this._exchangeFailures[exchange]) {
      this._exchangeFailures[exchange] = { count: 0, lastFailure: 0 };
    }
    this._exchangeFailures[exchange].count++;
    this._exchangeFailures[exchange].lastFailure = Date.now();
  }
  
  /**
   * CRITICAL FIX: Record exchange success (reset failure count)
   * @param {string} exchange - Exchange name (binance, mexc)
   */
  _recordExchangeSuccess(exchange) {
    if (this._exchangeFailures[exchange]) {
      this._exchangeFailures[exchange].count = 0;
      this._exchangeFailures[exchange].lastFailure = 0;
    }
  }

  async runOnce() {
    if (this.isRunning) {
      logger.debug('[SymbolsUpdater] Already running, skip.');
      return;
    }
    this.isRunning = true;

    // CRITICAL FIX: Watchdog timeout to prevent isRunning lock forever
    const { enabled, watchdogTimeoutMs } = this.getConfig();
    this._watchdogTimer = setTimeout(() => {
      logger.error(`[SymbolsUpdater] Watchdog timeout after ${watchdogTimeoutMs}ms, forcing unlock`);
      this.isRunning = false;
      if (this._watchdogTimer) {
        clearTimeout(this._watchdogTimer);
        this._watchdogTimer = null;
      }
    }, watchdogTimeoutMs);

    try {
      if (!enabled) {
        logger.debug('[SymbolsUpdater] Disabled by config ENABLE_SYMBOLS_REFRESH=false');
        return;
      }

      logger.info('[SymbolsUpdater] Refreshing Binance and MEXC symbol filters...');

      // CRITICAL FIX: Check backoff before updating
      const shouldSkipBinance = this._shouldSkipExchange('binance');
      const shouldSkipMexc = this._shouldSkipExchange('mexc');

      // CRITICAL FIX: Run updates in parallel for better performance
      const updatePromises = [];
      
      if (!shouldSkipBinance) {
        updatePromises.push(
          exchangeInfoService.updateFiltersFromExchange()
            .then(() => {
              this._recordExchangeSuccess('binance');
        logger.info('[SymbolsUpdater] Binance symbol filters updated');
            })
            .catch((e) => {
              this._recordExchangeFailure('binance');
        logger.error('[SymbolsUpdater] Binance update failed:', e?.message || e);
            })
        );
      }

      if (!shouldSkipMexc) {
        updatePromises.push(
          exchangeInfoService.updateMexcFiltersFromExchange()
            .then(() => {
              this._recordExchangeSuccess('mexc');
        logger.info('[SymbolsUpdater] MEXC symbol filters updated');
            })
            .catch((e) => {
              this._recordExchangeFailure('mexc');
        logger.error('[SymbolsUpdater] MEXC update failed:', e?.message || e);
            })
        );
      }

      // Wait for all updates to complete (or fail)
      await Promise.allSettled(updatePromises);

      logger.info('[SymbolsUpdater] Refresh cycle completed');
    } catch (error) {
      // This should rarely happen, but catch any unexpected errors
      logger.error('[SymbolsUpdater] Unexpected error in runOnce:', error?.message || error);
    } finally {
      // CRITICAL FIX: Always clear watchdog and reset isRunning
      if (this._watchdogTimer) {
        clearTimeout(this._watchdogTimer);
        this._watchdogTimer = null;
      }
      this.isRunning = false;
    }
  }

  start() {
    const { enabled, cronExpr, timezone } = this.getConfig();
    if (!enabled) {
      logger.info('[SymbolsUpdater] Not starting (disabled by config)');
      return;
    }

    // CRITICAL FIX: Schedule job with timezone (default UTC for consistency)
    this.cronTask = cron.schedule(cronExpr, async () => {
      await this.runOnce();
    }, {
      scheduled: true,
      timezone: timezone
    });

    // Kick first run non-blocking
    this.runOnce().catch((e) => logger.warn('[SymbolsUpdater] First run failed:', e?.message || e));

    logger.info(`[SymbolsUpdater] Started with cron: ${cronExpr} (timezone: ${timezone})`);
  }

  stop() {
    // CRITICAL FIX: Clear watchdog timer if running
    if (this._watchdogTimer) {
      clearTimeout(this._watchdogTimer);
      this._watchdogTimer = null;
    }
    
    // CRITICAL FIX: Reset isRunning state
    this.isRunning = false;
    
    if (this.cronTask) {
      this.cronTask.stop();
      this.cronTask = null;
    }
    logger.info('[SymbolsUpdater] Stopped');
  }
}

export default SymbolsUpdater;

