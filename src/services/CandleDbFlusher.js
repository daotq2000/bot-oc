import logger from '../utils/logger.js';
import { Candle } from '../models/Candle.js';
import { configService } from './ConfigService.js';
import { webSocketManager } from './WebSocketManager.js';
import { watchdogService } from './WatchdogService.js';

/**
 * CandleDbFlusher
 * - Periodically drains closed candles from CandleAggregator and persists to DB (candles table)
 * - Batch + yield to avoid event loop blocking
 * - Skips or slows down in watchdog degrade mode
 */
class CandleDbFlusher {
  constructor() {
    this._timer = null;
    this._pruneTimer = null;
    this.isRunning = false;
    this._touchedKeys = new Set(); // exchange|symbol|interval
    this.stats = {
      lastFlushAt: 0,
      lastInserted: 0,
      totalInserted: 0,
      totalFlushes: 0,
      lastPruneAt: 0,
      lastPrunedKeys: 0,
      lastPrunedRows: 0,
      totalPrunedRows: 0,
      totalPrunes: 0,
      totalErrors: 0,
      lastErrorAt: 0,
      lastError: null
    };
  }

  _enabled() {
    return configService.getBoolean('CANDLE_DB_FLUSH_ENABLED', true);
  }

  _intervalMs() {
    return Math.max(1000, Number(configService.getNumber('CANDLE_DB_FLUSH_INTERVAL_MS', 10000)) || 10000);
  }

  _batchSize() {
    return Math.max(50, Number(configService.getNumber('CANDLE_DB_FLUSH_BATCH_SIZE', 500)) || 500);
  }

  _maxPerCycle() {
    return Math.max(100, Number(configService.getNumber('CANDLE_DB_FLUSH_MAX_PER_CYCLE', 5000)) || 5000);
  }

  _yieldEveryBatches() {
    return Math.max(1, Number(configService.getNumber('CANDLE_DB_FLUSH_YIELD_EVERY_BATCHES', 1)) || 1);
  }

  _pruneEnabled() {
    return configService.getBoolean('CANDLE_DB_PRUNE_ENABLED', true);
  }

  _pruneIntervalMs() {
    // default: 30 minutes; pruning by LIMIT is cheap and bounded, but still avoid running too frequently
    return Math.max(60_000, Number(configService.getNumber('CANDLE_DB_PRUNE_INTERVAL_MS', 30 * 60_000)) || 30 * 60_000);
  }

  _keepLast(interval) {
    const itv = String(interval || '').toLowerCase();
    if (itv === '1m') return Math.max(50, Number(configService.getNumber('CANDLE_DB_KEEP_LAST_1M', 600)) || 600);
    if (itv === '5m') return Math.max(50, Number(configService.getNumber('CANDLE_DB_KEEP_LAST_5M', 400)) || 400);
    // if other intervals appear, keep a tiny default
    return Math.max(50, Number(configService.getNumber('CANDLE_DB_KEEP_LAST_DEFAULT', 300)) || 300);
  }

  start() {
    if (this.isRunning) return;
    if (!this._enabled()) {
      logger.info('[CandleDbFlusher] Disabled by env CANDLE_DB_FLUSH_ENABLED=false');
      return;
    }

    this.isRunning = true;
    const interval = this._intervalMs();
    this._timer = setInterval(() => {
      this.flushOnce().catch(e => {
        this.stats.totalErrors++;
        this.stats.lastErrorAt = Date.now();
        this.stats.lastError = e?.message || String(e);
        logger.warn(`[CandleDbFlusher] flushOnce error: ${this.stats.lastError}`);
      });
    }, interval);

    // Prune timer (retention by LIMIT) to keep DB bounded over time
    if (this._pruneEnabled()) {
      const pruneInterval = this._pruneIntervalMs();
      this._pruneTimer = setInterval(() => {
        this.pruneOnce().catch(e => {
          this.stats.totalErrors++;
          this.stats.lastErrorAt = Date.now();
          this.stats.lastError = e?.message || String(e);
          logger.warn(`[CandleDbFlusher] pruneOnce error: ${this.stats.lastError}`);
        });
      }, pruneInterval);
      logger.info(
        `[CandleDbFlusher] Prune enabled | interval=${pruneInterval}ms keepLast(1m)=${this._keepLast('1m')} keepLast(5m)=${this._keepLast('5m')}`
      );
    } else {
      logger.info('[CandleDbFlusher] Prune disabled by env CANDLE_DB_PRUNE_ENABLED=false');
    }

    logger.info(
      `[CandleDbFlusher] Started | interval=${interval}ms batch=${this._batchSize()} maxPerCycle=${this._maxPerCycle()}`
    );
  }

  stop() {
    this.isRunning = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._pruneTimer) {
      clearInterval(this._pruneTimer);
      this._pruneTimer = null;
    }
  }

  getStats() {
    const qSize =
      webSocketManager?.candleAggregator && typeof webSocketManager.candleAggregator.getClosedQueueSize === 'function'
        ? webSocketManager.candleAggregator.getClosedQueueSize()
        : null;
    return { ...this.stats, queueSize: qSize, isRunning: this.isRunning };
  }

  async flushOnce() {
    if (!this._enabled()) return 0;
    if (!webSocketManager?.candleAggregator) return 0;
    if (typeof webSocketManager.candleAggregator.drainClosedCandles !== 'function') return 0;

    // In degrade mode, we still allow flushing, but reduce max work per cycle to avoid DB/CPU spikes.
    const degraded = typeof watchdogService?.isDegraded === 'function' ? watchdogService.isDegraded() : false;
    const batchSize = this._batchSize();
    const maxPerCycle = degraded ? Math.min(500, this._maxPerCycle()) : this._maxPerCycle();
    const yieldEvery = this._yieldEveryBatches();

    let inserted = 0;
    let drainedTotal = 0;
    let batchCount = 0;

    while (drainedTotal < maxPerCycle) {
      const remaining = maxPerCycle - drainedTotal;
      const toDrain = Math.min(batchSize, remaining);
      const items = webSocketManager.candleAggregator.drainClosedCandles(toDrain);
      if (!items || items.length === 0) break;

      drainedTotal += items.length;
      batchCount += 1;

      // Map to DB shape. Exchange is currently Binance-only for the aggregator.
      const rows = items.map(c => ({
        exchange: 'binance',
        symbol: String(c.symbol).toUpperCase(),
        interval: String(c.interval).toLowerCase(),
        open_time: Number(c.startTime),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume ?? 0),
        close_time: Number(c.closeTime || 0) || undefined
      }));

      try {
        const affected = await Candle.bulkInsert(rows);
        inserted += Number(affected) || 0;
        // track keys that were updated so prune doesn't have to scan all symbols
        for (const r of rows) {
          this._touchedKeys.add(`${r.exchange}|${r.symbol}|${r.interval}`);
          if (this._touchedKeys.size > 5000) {
            // soft-cap to avoid memory growth; drop oldest by recreating Set from last N insertion order
            this._touchedKeys = new Set(Array.from(this._touchedKeys).slice(-3000));
          }
        }
      } catch (e) {
        this.stats.totalErrors++;
        this.stats.lastErrorAt = Date.now();
        this.stats.lastError = e?.message || String(e);
        logger.warn(`[CandleDbFlusher] bulkInsert failed: ${this.stats.lastError}`);
      }

      if (batchCount % yieldEvery === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    this.stats.lastFlushAt = Date.now();
    this.stats.lastInserted = inserted;
    this.stats.totalInserted += inserted;
    this.stats.totalFlushes += 1;

    // Log very lightly, only if we actually did work.
    if (drainedTotal > 0) {
      logger.debug(
        `[CandleDbFlusher] flushOnce ok | drained=${drainedTotal} inserted=${inserted} degraded=${degraded}`
      );
    }

    return inserted;
  }

  /**
   * Prune DB candles by LIMIT (keep last N) for keys recently updated.
   * This keeps DB bounded without heavy "scan whole DB" queries.
   */
  async pruneOnce() {
    if (!this._enabled()) return 0;
    if (!this._pruneEnabled()) return 0;

    // In degrade mode, skip prune entirely (non-critical).
    const degraded = typeof watchdogService?.isDegraded === 'function' ? watchdogService.isDegraded() : false;
    if (degraded) return 0;

    const keys = Array.from(this._touchedKeys);
    if (keys.length === 0) return 0;

    // Work budget per prune cycle
    const maxKeys = Math.max(10, Number(configService.getNumber('CANDLE_DB_PRUNE_MAX_KEYS_PER_CYCLE', 200)) || 200);
    const yieldEvery = Math.max(1, Number(configService.getNumber('CANDLE_DB_PRUNE_YIELD_EVERY_KEYS', 10)) || 10);

    let prunedRows = 0;
    let processedKeys = 0;

    // Process from newest to oldest (Set insertion order: older -> newer, so slice(-N))
    const batchKeys = keys.slice(-maxKeys);
    for (const key of batchKeys) {
      processedKeys++;
      const [exchange, symbol, interval] = String(key).split('|');
      const keepLast = this._keepLast(interval);

      try {
        const deleted = await Candle.pruneByLimit(exchange, symbol, interval, keepLast);
        prunedRows += Number(deleted) || 0;
      } catch (e) {
        this.stats.totalErrors++;
        this.stats.lastErrorAt = Date.now();
        this.stats.lastError = e?.message || String(e);
        logger.warn(`[CandleDbFlusher] pruneByLimit failed for ${key}: ${this.stats.lastError}`);
      }

      if (processedKeys % yieldEvery === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    // Remove processed keys from touched set to gradually cover all active keys
    for (const key of batchKeys) this._touchedKeys.delete(key);

    this.stats.lastPruneAt = Date.now();
    this.stats.lastPrunedKeys = processedKeys;
    this.stats.lastPrunedRows = prunedRows;
    this.stats.totalPrunedRows += prunedRows;
    this.stats.totalPrunes += 1;

    if (processedKeys > 0) {
      logger.debug(
        `[CandleDbFlusher] pruneOnce ok | keys=${processedKeys} prunedRows=${prunedRows} keepLast(1m)=${this._keepLast('1m')} keepLast(5m)=${this._keepLast('5m')}`
      );
    }

    return prunedRows;
  }
}

export const candleDbFlusher = new CandleDbFlusher();


