import logger from '../utils/logger.js';
import { monitorEventLoopDelay } from 'perf_hooks';

/**
 * WatchdogService
 * - Monitors event loop delay to detect CPU/IO saturation.
 * - Enters "degrade mode" when delay exceeds threshold consecutively.
 * - Provides overrides for ADV_TPSL limits to avoid API/CPU storms.
 */
class WatchdogService {
  constructor() {
    this.interval = null;
    this.delayMonitor = null;
    this.degradeActive = false;
    this.degradeUntil = 0;
    this.config = {
      sampleIntervalMs: 10000,
      thresholdMs: 400, // event loop delay warn threshold
      consecutiveTriggers: 3,
      degradeDurationMs: 10 * 60 * 1000 // 10 minutes
    };
    this._consecutiveHigh = 0;
  }

  start(options = {}) {
    if (this.interval) return;
    this.config = { ...this.config, ...options };
    this.delayMonitor = monitorEventLoopDelay({ resolution: 10 });
    this.delayMonitor.enable();

    this.interval = setInterval(() => {
      try {
        const mean = this.delayMonitor.mean / 1e6; // ns -> ms
        const max = this.delayMonitor.max / 1e6;
        this.delayMonitor.reset();

        const now = Date.now();
        if (this.degradeActive && now >= this.degradeUntil) {
          this.degradeActive = false;
          this._consecutiveHigh = 0;
          logger.warn('[Watchdog] ✅ Exiting degrade mode (event loop delay recovered)');
        }

        if (mean >= this.config.thresholdMs || max >= this.config.thresholdMs) {
          this._consecutiveHigh += 1;
          logger.warn(`[Watchdog] ⚠️ High event loop delay detected: mean=${mean.toFixed(1)}ms max=${max.toFixed(1)}ms (streak=${this._consecutiveHigh}/${this.config.consecutiveTriggers})`);
          if (!this.degradeActive && this._consecutiveHigh >= this.config.consecutiveTriggers) {
            this.degradeActive = true;
            this.degradeUntil = now + this.config.degradeDurationMs;
            logger.error(`[Watchdog] 🚨 Entering degrade mode for ${this.config.degradeDurationMs / 60000} minutes to protect WS`);
          }
        } else {
          this._consecutiveHigh = 0;
        }
      } catch (e) {
        logger.warn(`[Watchdog] error: ${e?.message || e}`);
      }
    }, this.config.sampleIntervalMs);

    logger.info('[Watchdog] Started event loop monitor');
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    if (this.delayMonitor) this.delayMonitor.disable();
    this.delayMonitor = null;
  }

  isDegraded() {
    return this.degradeActive && Date.now() < this.degradeUntil;
  }

  /**
   * Overrides for ADV_TPSL when degraded.
   * When degraded: effectively disable ADV_TPSL heavy processing.
   */
  getAdvLimits() {
    if (!this.isDegraded()) return null;
    return {
      maxPerCycle: 0,
      maxConcurrent: 0,
      cooldownMs: Number.MAX_SAFE_INTEGER
    };
  }

  /**
   * CRITICAL: Check if a job type should be degraded
   * TP/SL placement is NEVER degraded (safety layer)
   * @param {string} jobType - Job type: 'ADV_TPSL', 'INDICATOR_WARMUP', 'SYMBOL_UPDATE', 'TP_PLACEMENT', 'SL_PLACEMENT', 'FORCE_CLOSE'
   * @returns {boolean} True if job should be degraded
   */
  shouldDegradeJob(jobType) {
    if (!this.isDegraded()) return false;
    
    // CRITICAL: Safety-critical jobs are NEVER degraded
    const safetyCriticalJobs = ['TP_PLACEMENT', 'SL_PLACEMENT', 'FORCE_CLOSE'];
    if (safetyCriticalJobs.includes(jobType)) {
      return false; // Never degrade safety-critical jobs
    }
    
    // Degrade non-critical jobs
    const degradableJobs = ['ADV_TPSL', 'INDICATOR_WARMUP', 'SYMBOL_UPDATE', 'CACHE_REFRESH'];
    return degradableJobs.includes(jobType);
  }

  /**
   * Get current event loop delay metrics
   * @returns {Object} { mean, max } in milliseconds
   */
  getMetrics() {
    if (!this.delayMonitor) {
      return { mean: 0, max: 0 };
    }
    return {
      mean: this.delayMonitor.mean / 1e6, // ns -> ms
      max: this.delayMonitor.max / 1e6
    };
  }
}

export const watchdogService = new WatchdogService();


