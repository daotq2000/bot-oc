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
    // CRITICAL FIX: Increased intervals to prevent -1007 timeout errors
    // Default: 200ms for unsigned (~5 req/sec), 250ms for signed (~4 req/sec)
    this._baseUnsignedInterval = Number(configService.getNumber('BINANCE_REQUEST_INTERVAL_MS', 200));
    this._baseSignedInterval = Number(configService.getNumber('BINANCE_SIGNED_REQUEST_INTERVAL_MS', 250));
    this._unsignedInterval = this._baseUnsignedInterval;
    this._signedInterval = this._baseSignedInterval;
    this._lastUnsignedAt = 0;
    this._lastSignedAt = 0;

    this._maxQueue = Number(configService.getNumber('BINANCE_SCHED_MAX_QUEUE', 5000));

    // CRITICAL FIX: Adaptive throttling for -1007 timeout errors
    // When Binance backend is overloaded, we need to slow down
    this._timeoutErrorCount = 0;
    this._timeoutErrorWindow = []; // timestamps of recent timeout errors
    this._timeoutWindowMs = Number(configService.getNumber('BINANCE_TIMEOUT_WINDOW_MS', 60000)); // 1 minute window
    this._timeoutThreshold = Number(configService.getNumber('BINANCE_TIMEOUT_THRESHOLD', 3)); // 3 errors in window triggers throttle
    this._throttleMultiplier = 1; // Current throttle multiplier (1 = normal, 2 = 2x slower, etc.)
    this._maxThrottleMultiplier = Number(configService.getNumber('BINANCE_MAX_THROTTLE_MULTIPLIER', 4)); // Max 4x slower
    this._throttleDecayMs = Number(configService.getNumber('BINANCE_THROTTLE_DECAY_MS', 30000)); // Decay throttle after 30s of no errors
    this._lastErrorAt = 0;

    // CRITICAL FIX: Timeout circuit breaker - block all requests when too many timeouts
    this._timeoutCircuitOpen = false;
    this._timeoutCircuitOpenedAt = 0;
    this._timeoutCircuitCooldownMs = Number(configService.getNumber('BINANCE_TIMEOUT_CIRCUIT_COOLDOWN_MS', 15000)); // 15s cooldown

    // Stats
    this._stats = {
      totalEnqueued: 0,
      totalProcessed: 0,
      mainnetProcessed: 0,
      testnetProcessed: 0,
      signedProcessed: 0,
      unsignedProcessed: 0,
      timeoutErrors: 0,
      throttledRequests: 0,
      circuitBreakerTrips: 0,
      lastSampleAt: 0
    };

    const statsInterval = Number(configService.getNumber('BINANCE_SCHED_STATS_INTERVAL_MS', 10000));
    if (statsInterval > 0) {
      setInterval(() => this._logStats(), statsInterval).unref?.();
    }

    // CRITICAL FIX: Periodic throttle decay check
    setInterval(() => this._decayThrottle(), 5000).unref?.();
  }

  /**
   * CRITICAL FIX: Record timeout error and adjust throttling
   * Called by BinanceDirectClient when -1007 or network timeout occurs
   */
  recordTimeoutError() {
    const now = Date.now();
    this._lastErrorAt = now;
    this._stats.timeoutErrors++;
    
    // Add to sliding window
    this._timeoutErrorWindow.push(now);
    
    // Remove old entries outside window
    this._timeoutErrorWindow = this._timeoutErrorWindow.filter(t => now - t < this._timeoutWindowMs);
    
    // Check if threshold exceeded
    if (this._timeoutErrorWindow.length >= this._timeoutThreshold) {
      // Increase throttle multiplier
      const prevMultiplier = this._throttleMultiplier;
      this._throttleMultiplier = Math.min(this._throttleMultiplier * 1.5, this._maxThrottleMultiplier);
      
      // Update intervals
      this._unsignedInterval = Math.round(this._baseUnsignedInterval * this._throttleMultiplier);
      this._signedInterval = Math.round(this._baseSignedInterval * this._throttleMultiplier);
      
      logger.warn(
        `[BinanceScheduler] ⚠️ Timeout errors detected (${this._timeoutErrorWindow.length}/${this._timeoutThreshold} in ${this._timeoutWindowMs}ms), ` +
        `increasing throttle: ${prevMultiplier.toFixed(1)}x → ${this._throttleMultiplier.toFixed(1)}x ` +
        `(unsigned=${this._unsignedInterval}ms, signed=${this._signedInterval}ms)`
      );
      
      // If throttle is at max, open circuit breaker
      if (this._throttleMultiplier >= this._maxThrottleMultiplier && !this._timeoutCircuitOpen) {
        this._openTimeoutCircuit();
      }
    }
  }

  /**
   * CRITICAL FIX: Open timeout circuit breaker
   */
  _openTimeoutCircuit() {
    if (this._timeoutCircuitOpen) return;
    
    this._timeoutCircuitOpen = true;
    this._timeoutCircuitOpenedAt = Date.now();
    this._stats.circuitBreakerTrips++;
    
    logger.error(
      `[BinanceScheduler] 🚫 TIMEOUT CIRCUIT BREAKER OPENED! ` +
      `Too many -1007 timeout errors. Blocking requests for ${this._timeoutCircuitCooldownMs}ms ` +
      `to let Binance backend recover.`
    );
    
    // Schedule circuit close
    setTimeout(() => this._closeTimeoutCircuit(), this._timeoutCircuitCooldownMs);
  }

  /**
   * CRITICAL FIX: Close timeout circuit breaker
   */
  _closeTimeoutCircuit() {
    if (!this._timeoutCircuitOpen) return;
    
    this._timeoutCircuitOpen = false;
    this._timeoutErrorWindow = []; // Clear error window
    this._throttleMultiplier = 1.5; // Start with slight throttle after circuit closes
    this._unsignedInterval = Math.round(this._baseUnsignedInterval * this._throttleMultiplier);
    this._signedInterval = Math.round(this._baseSignedInterval * this._throttleMultiplier);
    
    logger.info(
      `[BinanceScheduler] ✅ Timeout circuit breaker CLOSED. ` +
      `Resuming with conservative throttle: ${this._throttleMultiplier.toFixed(1)}x ` +
      `(unsigned=${this._unsignedInterval}ms, signed=${this._signedInterval}ms)`
    );
  }

  /**
   * CRITICAL FIX: Check if timeout circuit breaker is open
   */
  isTimeoutCircuitOpen() {
    if (!this._timeoutCircuitOpen) return false;
    
    // Check if cooldown has passed
    const now = Date.now();
    if (now - this._timeoutCircuitOpenedAt >= this._timeoutCircuitCooldownMs) {
      this._closeTimeoutCircuit();
      return false;
    }
    
    return true;
  }

  /**
   * CRITICAL FIX: Decay throttle over time when no errors
   */
  _decayThrottle() {
    const now = Date.now();
    
    // Don't decay if circuit is open
    if (this._timeoutCircuitOpen) return;
    
    // Don't decay if recent error
    if (now - this._lastErrorAt < this._throttleDecayMs) return;
    
    // Don't decay if already at base
    if (this._throttleMultiplier <= 1) return;
    
    // Gradually reduce throttle
    const prevMultiplier = this._throttleMultiplier;
    this._throttleMultiplier = Math.max(1, this._throttleMultiplier * 0.8);
    this._unsignedInterval = Math.round(this._baseUnsignedInterval * this._throttleMultiplier);
    this._signedInterval = Math.round(this._baseSignedInterval * this._throttleMultiplier);
    
    if (prevMultiplier !== this._throttleMultiplier) {
      logger.debug(
        `[BinanceScheduler] ⬇️ Throttle decay: ${prevMultiplier.toFixed(1)}x → ${this._throttleMultiplier.toFixed(1)}x ` +
        `(no errors for ${Math.round((now - this._lastErrorAt) / 1000)}s)`
      );
    }
  }

  enqueue({ isMainnet, requiresAuth, fn, label }) {
    return new Promise((resolve, reject) => {
      // CRITICAL FIX: Check timeout circuit breaker before enqueueing
      if (this.isTimeoutCircuitOpen()) {
        const remainingMs = Math.max(0, this._timeoutCircuitCooldownMs - (Date.now() - this._timeoutCircuitOpenedAt));
        const error = new Error(
          `Timeout circuit breaker is OPEN - Binance backend is overloaded. ` +
          `Requests blocked for ${Math.ceil(remainingMs / 1000)}s to prevent further timeouts.`
        );
        error.code = 'TIMEOUT_CIRCUIT_OPEN';
        error.retryAfterMs = remainingMs;
        reject(error);
        return;
      }

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
      `signed=${this._stats.signedProcessed} unsigned=${this._stats.unsignedProcessed} ` +
      `timeouts=${this._stats.timeoutErrors} throttle=${this._throttleMultiplier.toFixed(1)}x ` +
      `circuit=${this._timeoutCircuitOpen ? 'OPEN' : 'closed'}` +
      (elapsed ? ` sampleMs=${elapsed}` : '')
    );
  }

  async _drain() {
    if (this._processing) return;
    this._processing = true;

    try {
      while (true) {
        // CRITICAL FIX: Check circuit breaker before processing
        if (this.isTimeoutCircuitOpen()) {
          // Circuit is open, pause processing
          logger.debug(`[BinanceScheduler] Circuit breaker open, pausing queue processing`);
          break;
        }

        const next = this._pickNext();
        if (!next) break;

        try {
          await this._rateLimitWait(next.requiresAuth);
          
          // Track if this is a throttled request
          if (this._throttleMultiplier > 1) {
            this._stats.throttledRequests++;
          }
          
          const res = await next.fn();
          next.resolve(res);
        } catch (e) {
          // CRITICAL FIX: Check for timeout errors and record them
          const errorMsg = e?.message || String(e);
          const errorCode = e?.code;
          if (errorCode === -1007 || 
              errorMsg.includes('-1007') || 
              errorMsg.includes('Timeout waiting for response') ||
              errorMsg.includes('timeout') ||
              errorMsg.includes('ETIMEDOUT') ||
              errorMsg.includes('ECONNRESET')) {
            this.recordTimeoutError();
          }
          
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
            `[BinanceScheduler] done label=${next.label} waitMs=${waitMs} mainQ=${this._mainnetQueue.length} testQ=${this._testnetQueue.length} throttle=${this._throttleMultiplier.toFixed(1)}x`
          );
        }
      }
    } finally {
      this._processing = false;
      if (this._mainnetQueue.length + this._testnetQueue.length > 0) {
        // CRITICAL FIX: Add small delay before next drain to prevent tight loop
        const drainDelay = this._timeoutCircuitOpen ? 1000 : 10;
        setTimeout(() => this._drain(), drainDelay);
      }
    }
  }
}

export const binanceRequestScheduler = new BinanceRequestScheduler();
