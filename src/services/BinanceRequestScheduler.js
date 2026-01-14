import logger from '../utils/logger.js';
import { configService } from './ConfigService.js';

class BinanceRequestScheduler {
  constructor() {
    this._mainnetQueue = [];
    this._testnetQueue = [];
    this._processing = false;

    // Weighted priority: process N mainnet tasks then 1 testnet task (when available)
    this._mainnetBurst = Number(configService.getNumber('BINANCE_SCHED_MAINNET_BURST', 5));
    this._burstCounter = 0;

    // Separate limiter for signed requests (stricter)
    this._unsignedInterval = Number(configService.getNumber('BINANCE_REQUEST_INTERVAL_MS', 125));
    this._signedInterval = Number(configService.getNumber('BINANCE_SIGNED_REQUEST_INTERVAL_MS', 150));
    this._lastUnsignedAt = 0;
    this._lastSignedAt = 0;

    this._maxQueue = Number(configService.getNumber('BINANCE_SCHED_MAX_QUEUE', 5000));

    // Stats
    this._stats = {
      totalEnqueued: 0,
      totalProcessed: 0,
      mainnetProcessed: 0,
      testnetProcessed: 0,
      signedProcessed: 0,
      unsignedProcessed: 0,
      lastSampleAt: 0
    };

    const statsInterval = Number(configService.getNumber('BINANCE_SCHED_STATS_INTERVAL_MS', 10000));
    if (statsInterval > 0) {
      setInterval(() => this._logStats(), statsInterval).unref?.();
    }
  }

  enqueue({ isMainnet, requiresAuth, fn, label }) {
    return new Promise((resolve, reject) => {
      const item = {
        isMainnet: !!isMainnet,
        requiresAuth: !!requiresAuth,
        fn,
        label: label || 'request',
        resolve,
        reject,
        enqueuedAt: Date.now()
      };

      const q = item.isMainnet ? this._mainnetQueue : this._testnetQueue;
      q.push(item);
      this._stats.totalEnqueued += 1;

      // Basic backpressure: drop oldest testnet requests if queue explodes
      if (this._mainnetQueue.length + this._testnetQueue.length > this._maxQueue) {
        // Prefer dropping testnet first
        if (this._testnetQueue.length > 0) {
          const dropped = this._testnetQueue.shift();
          dropped?.reject?.(new Error('BINANCE_SCHED_QUEUE_OVERFLOW_TESTNET_DROPPED'));
        } else {
          const dropped = this._mainnetQueue.shift();
          dropped?.reject?.(new Error('BINANCE_SCHED_QUEUE_OVERFLOW_MAINNET_DROPPED'));
        }
      }

      this._drain();
    });
  }

  _pickNext() {
    const hasMain = this._mainnetQueue.length > 0;
    const hasTest = this._testnetQueue.length > 0;
    if (!hasMain && !hasTest) return null;

    // If only one side has tasks
    if (hasMain && !hasTest) return this._mainnetQueue.shift();
    if (!hasMain && hasTest) return this._testnetQueue.shift();

    // Both available: weighted priority for mainnet
    if (this._burstCounter < this._mainnetBurst) {
      this._burstCounter += 1;
      return this._mainnetQueue.shift();
    }

    // Give 1 slot to testnet then reset
    this._burstCounter = 0;
    return this._testnetQueue.shift();
  }

  async _rateLimitWait(requiresAuth) {
    const now = Date.now();
    if (requiresAuth) {
      const dt = now - this._lastSignedAt;
      if (dt < this._signedInterval) {
        await new Promise(r => setTimeout(r, this._signedInterval - dt));
      }
      this._lastSignedAt = Date.now();
      return;
    }

    const dt = now - this._lastUnsignedAt;
    if (dt < this._unsignedInterval) {
      await new Promise(r => setTimeout(r, this._unsignedInterval - dt));
    }
    this._lastUnsignedAt = Date.now();
  }

  _logStats() {
    const enable = configService.getBoolean('BINANCE_SCHED_STATS_ENABLED', true);
    if (!enable) return;

    const now = Date.now();
    const elapsed = this._stats.lastSampleAt ? (now - this._stats.lastSampleAt) : 0;
    this._stats.lastSampleAt = now;

    logger.info(
      `[BinanceScheduler] qMain=${this._mainnetQueue.length} qTest=${this._testnetQueue.length} ` +
      `processed=${this._stats.totalProcessed} (main=${this._stats.mainnetProcessed}, test=${this._stats.testnetProcessed}) ` +
      `signed=${this._stats.signedProcessed} unsigned=${this._stats.unsignedProcessed}` +
      (elapsed ? ` sampleMs=${elapsed}` : '')
    );
  }

  async _drain() {
    if (this._processing) return;
    this._processing = true;

    try {
      while (true) {
        const next = this._pickNext();
        if (!next) break;

        try {
          await this._rateLimitWait(next.requiresAuth);
          const res = await next.fn();
          next.resolve(res);
        } catch (e) {
          next.reject(e);
        } finally {
          this._stats.totalProcessed += 1;
          if (next.isMainnet) this._stats.mainnetProcessed += 1; else this._stats.testnetProcessed += 1;
          if (next.requiresAuth) this._stats.signedProcessed += 1; else this._stats.unsignedProcessed += 1;
        }

        const debug = configService.getBoolean('BINANCE_SCHED_DEBUG', false);
        if (debug) {
          const waitMs = Date.now() - (next.enqueuedAt || Date.now());
          logger.debug(
            `[BinanceScheduler] done label=${next.label} waitMs=${waitMs} mainQ=${this._mainnetQueue.length} testQ=${this._testnetQueue.length}`
          );
        }
      }
    } finally {
      this._processing = false;
      if (this._mainnetQueue.length + this._testnetQueue.length > 0) {
        setImmediate(() => this._drain());
      }
    }
  }
}

export const binanceRequestScheduler = new BinanceRequestScheduler();
