import { configService } from './ConfigService.js';
import { LRUCache } from '../utils/LRUCache.js';
import logger from '../utils/logger.js';

/**
 * Market Regime Service
 * 
 * Classify market regimes based on volatility, trend, and OC patterns
 * Regimes:
 * - SIDEWAY: Low volatility, choppy price action
 * - TRENDING: Strong directional movement
 * - VOL_EXPANSION: Breakout with pullback
 * - NEWS_SPIKE: Extreme volatility (5-20% in seconds)
 */
export class MarketRegimeService {
  constructor() {
    // Cache regime per symbol (key: exchange|symbol|interval)
    this._regimeCache = new LRUCache(1000);
    this._regimeCacheTTL = 10000; // 10 seconds (reduced for faster updates)
    
    // Track OC history per symbol (last N buckets + ticks)
    this._ocHistory = new Map(); // key: exchange|symbol|interval -> Array<{bucketStart, absOC, timestamp}>
    this._ocTicks = new Map(); // key: exchange|symbol|interval -> Array<{absOC, timestamp}> (last 5 ticks)
    this._maxHistorySize = 10; // Track last 10 buckets
    this._maxTickSize = 5; // Track last 5 ticks
    
    // Regime state tracking (for hysteresis and locks)
    this._regimeState = new Map(); // key: exchange|symbol|interval -> {regime, lastSwitchTs, lockedUntil}
    this._hysteresisMs = Number(configService.getNumber('REGIME_HYSTERESIS_MS', 15000)); // 15s hysteresis
    this._regimeLockMs = Number(configService.getNumber('REGIME_LOCK_MS', 20000)); // 20s lock after fire
    
    // Hard OC cap (fail-safe)
    this.hardOCCap = Number(configService.getNumber('REGIME_HARD_OC_CAP', 8.0)); // 8% hard cap
    
    // Regime thresholds (base values, will be scaled by strategy ocThreshold)
    this.sidewayMaxOCBase = Number(configService.getNumber('REGIME_SIDEWAY_MAX_OC', 0.8)); // Base max OC in sideway
    this.trendingMinOCBase = Number(configService.getNumber('REGIME_TRENDING_MIN_OC', 1.5)); // Base min OC for trending
    this.volExpansionMinOCBase = Number(configService.getNumber('REGIME_VOL_EXPANSION_MIN_OC', 2.5)); // Base min OC for vol expansion
    this.newsSpikeMinOCBase = Number(configService.getNumber('REGIME_NEWS_SPIKE_MIN_OC', 8.0)); // Base min OC for news spike
    
    // Regime score weights
    this.maxOCWeight = Number(configService.getNumber('REGIME_MAX_OC_WEIGHT', 0.5));
    this.avgOCWeight = Number(configService.getNumber('REGIME_AVG_OC_WEIGHT', 0.3));
    this.consistencyWeight = Number(configService.getNumber('REGIME_CONSISTENCY_WEIGHT', 0.2));
    
    logger.info(
      `[MarketRegimeService] Initialized with thresholds: ` +
      `sideway=${this.sidewayMaxOCBase}%, trending=${this.trendingMinOCBase}%, ` +
      `volExp=${this.volExpansionMinOCBase}%, news=${this.newsSpikeMinOCBase}% | ` +
      `hysteresis=${this._hysteresisMs}ms, lock=${this._regimeLockMs}ms, hardCap=${this.hardOCCap}%`
    );
  }

  /**
   * Get interval bucket start time
   */
  getBucketStart(interval, timestamp = Date.now()) {
    const match = interval.match(/^(\d+)([mhd])$/);
    if (!match) return Math.floor(timestamp / 60000) * 60000; // Default 1m
    
    const value = parseInt(match[1]);
    const unit = match[2];
    let intervalMs = 60000; // Default 1m
    
    switch (unit) {
      case 'm': intervalMs = value * 60000; break;
      case 'h': intervalMs = value * 3600000; break;
      case 'd': intervalMs = value * 86400000; break;
    }
    
    return Math.floor(timestamp / intervalMs) * intervalMs;
  }

  /**
   * Update OC history for a symbol (buckets + ticks)
   */
  updateOCHistory(exchange, symbol, interval, absOC, timestamp = Date.now()) {
    const key = `${exchange}|${symbol}|${interval}`;
    const bucketStart = this.getBucketStart(interval, timestamp);
    
    // Update bucket history
    if (!this._ocHistory.has(key)) {
      this._ocHistory.set(key, []);
    }
    
    const history = this._ocHistory.get(key);
    
    // Remove old entries (keep only last N buckets)
    const cutoff = bucketStart - (this._maxHistorySize * this.getIntervalMs(interval));
    while (history.length > 0 && history[0].bucketStart < cutoff) {
      history.shift();
    }
    
    // Add new entry (or update if same bucket)
    const existing = history.find(h => h.bucketStart === bucketStart);
    if (existing) {
      existing.absOC = absOC;
      existing.timestamp = timestamp;
    } else {
      history.push({ bucketStart, absOC, timestamp });
    }
    
    // Keep only last N entries
    if (history.length > this._maxHistorySize) {
      history.shift();
    }
    
    // Update tick history (for spikeFactor calculation)
    if (!this._ocTicks.has(key)) {
      this._ocTicks.set(key, []);
    }
    
    const ticks = this._ocTicks.get(key);
    ticks.push({ absOC, timestamp });
    
    // Remove old ticks (keep only last N)
    const tickCutoff = timestamp - 30000; // 30s window
    while (ticks.length > 0 && ticks[0].timestamp < tickCutoff) {
      ticks.shift();
    }
    
    // Keep only last N ticks
    if (ticks.length > this._maxTickSize) {
      ticks.shift();
    }
  }

  /**
   * Get interval in milliseconds
   */
  getIntervalMs(interval) {
    const match = interval.match(/^(\d+)([mhd])$/);
    if (!match) return 60000;
    
    const value = parseInt(match[1]);
    const unit = match[2];
    
    switch (unit) {
      case 'm': return value * 60000;
      case 'h': return value * 3600000;
      case 'd': return value * 86400000;
      default: return 60000;
    }
  }

  /**
   * Calculate volatility score from OC history (improved with spikeFactor)
   * @param {string} exchange - Exchange name
   * @param {string} symbol - Symbol
   * @param {string} interval - Interval
   * @param {number} currentAbsOC - Current absolute OC
   * @param {number} ocThreshold - Strategy OC threshold (for spikeFactor calculation)
   * @returns {number} Volatility score
   */
  calculateVolatilityScore(exchange, symbol, interval, currentAbsOC, ocThreshold = 2.0) {
    const key = `${exchange}|${symbol}|${interval}`;
    const history = this._ocHistory.get(key) || [];
    const ticks = this._ocTicks.get(key) || [];
    
    if (history.length === 0) {
      return 0; // No history = assume sideway
    }
    
    // Calculate metrics
    const maxOC = Math.max(...history.map(h => h.absOC));
    const avgOC = history.reduce((sum, h) => sum + h.absOC, 0) / history.length;
    
    // Spike factor: if current OC >= threshold * 2, add 1.5 to score
    const spikeFactor = currentAbsOC >= ocThreshold * 2 ? 1.5 : 0;
    
    // Consistency: std deviation (lower = more consistent/trending, higher = choppy/sideway)
    const variance = history.reduce((sum, h) => sum + Math.pow(h.absOC - avgOC, 2), 0) / history.length;
    const stdDev = Math.sqrt(variance);
    const consistency = 1 / (1 + stdDev); // Higher = more consistent
    
    // Weighted score with spikeFactor
    const score = (maxOC * this.maxOCWeight) + 
                  (avgOC * this.avgOCWeight) + 
                  (consistency * 10 * this.consistencyWeight) +
                  spikeFactor;
    
    return score;
  }

  /**
   * Classify market regime with hysteresis and lock support
   * @param {string} exchange - Exchange name
   * @param {string} symbol - Symbol
   * @param {string} interval - Time interval
   * @param {number} currentAbsOC - Current absolute OC
   * @param {number} timestamp - Current timestamp
   * @param {number} ocThreshold - Strategy OC threshold (for scaling thresholds)
   * @returns {string} Regime: 'SIDEWAY' | 'TRENDING' | 'VOL_EXPANSION' | 'NEWS_SPIKE'
   */
  getRegime(exchange, symbol, interval, currentAbsOC, timestamp = Date.now(), ocThreshold = 2.0) {
    const ex = (exchange || '').toLowerCase();
    const sym = String(symbol || '').toUpperCase().replace(/[\/:_]/g, '');
    const key = `${ex}|${sym}|${interval}`;
    
    // Update history
    this.updateOCHistory(ex, sym, interval, currentAbsOC, timestamp);
    
    // Get current regime state
    let state = this._regimeState.get(key);
    if (!state) {
      state = { regime: 'SIDEWAY', lastSwitchTs: 0, lockedUntil: 0 };
      this._regimeState.set(key, state);
    }
    
    // Check if regime is locked (after fire)
    if (timestamp < state.lockedUntil) {
      return state.regime; // Return locked regime
    }
    
    // Scale thresholds by strategy ocThreshold (relative to base 2.0%)
    const scaleFactor = ocThreshold / 2.0;
    const sidewayMaxOC = this.sidewayMaxOCBase * scaleFactor;
    const trendingMinOC = this.trendingMinOCBase * scaleFactor;
    const volExpansionMinOC = this.volExpansionMinOCBase * scaleFactor;
    const newsSpikeMinOC = this.newsSpikeMinOCBase * scaleFactor;
    
    // Classify based on current OC and history
    let newRegime = 'SIDEWAY'; // Default
    
    // NEWS_SPIKE: Extreme volatility (hard cap check)
    if (currentAbsOC >= this.hardOCCap || currentAbsOC >= newsSpikeMinOC) {
      newRegime = 'NEWS_SPIKE';
    }
    // VOL_EXPANSION: Strong breakout
    else if (currentAbsOC >= volExpansionMinOC) {
      newRegime = 'VOL_EXPANSION';
    }
    // TRENDING: Consistent directional movement
    else if (currentAbsOC >= trendingMinOC) {
      const volatilityScore = this.calculateVolatilityScore(ex, sym, interval, currentAbsOC, ocThreshold);
      // High consistency + high OC = trending
      if (volatilityScore > 1.8) {
        newRegime = 'TRENDING';
      } else {
        newRegime = 'VOL_EXPANSION';
      }
    }
    // SIDEWAY: Low volatility
    else if (currentAbsOC <= sidewayMaxOC) {
      newRegime = 'SIDEWAY';
    }
    // Between sideway and trending = check history
    else {
      const volatilityScore = this.calculateVolatilityScore(ex, sym, interval, currentAbsOC, ocThreshold);
      if (volatilityScore > 0.8) {
        newRegime = 'TRENDING';
      } else {
        newRegime = 'SIDEWAY';
      }
    }
    
    // HYSTERESIS: Prevent rapid regime switching
    if (newRegime !== state.regime) {
      const timeSinceLastSwitch = timestamp - state.lastSwitchTs;
      if (timeSinceLastSwitch < this._hysteresisMs) {
        // Keep previous regime if switch too soon
        return state.regime;
      }
      
      // Update regime
      state.regime = newRegime;
      state.lastSwitchTs = timestamp;
      logger.debug(
        `[MarketRegimeService] Regime switched: ${key} → ${newRegime} ` +
        `(OC=${currentAbsOC.toFixed(2)}%, threshold=${ocThreshold.toFixed(2)}%)`
      );
    }
    
    // Cache result
    this._regimeCache.set(key, { regime: state.regime, timestamp });
    
    return state.regime;
  }
  
  /**
   * Lock regime for a symbol (after fire) to prevent immediate flip
   * @param {string} exchange - Exchange name
   * @param {string} symbol - Symbol
   * @param {string} interval - Interval
   * @param {number} timestamp - Current timestamp
   */
  lockRegime(exchange, symbol, interval, timestamp = Date.now()) {
    const ex = (exchange || '').toLowerCase();
    const sym = String(symbol || '').toUpperCase().replace(/[\/:_]/g, '');
    const key = `${ex}|${sym}|${interval}`;
    
    let state = this._regimeState.get(key);
    if (!state) {
      state = { regime: 'SIDEWAY', lastSwitchTs: 0, lockedUntil: 0 };
      this._regimeState.set(key, state);
    }
    
    state.lockedUntil = timestamp + this._regimeLockMs;
    logger.debug(`[MarketRegimeService] Regime locked for ${key} until ${new Date(state.lockedUntil).toISOString()}`);
  }

  /**
   * Get regime-specific parameters
   * @param {string} regime - Market regime
   * @param {Object} baseParams - Base parameters
   * @param {boolean} isReverse - Is reverse strategy (for size multiplier adjustment)
   * @returns {Object} Adjusted parameters
   */
  getRegimeParams(regime, baseParams, isReverse = false) {
    const {
      ocThreshold = 2.0,
      retraceRatio = 0.2,
      stallMs = 4000,
      sizeMultiplier = 1.0
    } = baseParams;
    
    switch (regime) {
      case 'SIDEWAY':
        return {
          ocThreshold: ocThreshold * 1.4, // +40% threshold
          retraceRatio: 0.4, // 40% retrace (from 20%) - more conservative
          stallMs: 3000, // Reduce to 3s (from 4s base)
          sizeMultiplier: sizeMultiplier * 1.0, // Keep size for reverse
          disableTrendFollow: true, // Disable trend-follow in sideway
          disableReverse: false
        };
        
      case 'TRENDING':
        return {
          ocThreshold: ocThreshold, // Keep same
          retraceRatio: retraceRatio, // Keep same
          stallMs: stallMs * 2, // Double stall time (4s → 8s)
          sizeMultiplier: sizeMultiplier, // Keep same
          disableTrendFollow: false,
          disableReverse: true, // Disable reverse in trending
          requireRetraceOnly: true // Disable stall fire
        };
        
      case 'VOL_EXPANSION':
        return {
          ocThreshold: ocThreshold * 1.2, // +20% threshold
          retraceRatio: 0.3, // 30% retrace (from 20%)
          stallMs: 0, // Disable stall fire
          sizeMultiplier: isReverse 
            ? sizeMultiplier * 0.6  // Reduce size 40% for reverse
            : sizeMultiplier * 0.7, // Reduce size 30% for trend-follow
          disableTrendFollow: false,
          disableReverse: false,
          requireRetraceOnly: true, // Disable stall fire
          delayFire: 300 // 300ms delay for trend-follow
        };
        
      case 'NEWS_SPIKE':
        return {
          ocThreshold: ocThreshold * 1.5, // +50% threshold (not double, too aggressive)
          retraceRatio: retraceRatio, // Keep same
          stallMs: 0, // Disable stall fire
          sizeMultiplier: sizeMultiplier * 0.4, // Reduce size 60%
          disableTrendFollow: false,
          disableReverse: true, // Disable reverse in news spike
          delayFire: 1000 // Delay fire 1s
        };
        
      default:
        return {
          ocThreshold,
          retraceRatio,
          stallMs,
          sizeMultiplier,
          disableTrendFollow: false,
          disableReverse: false
        };
    }
  }

  /**
   * Check if strategy should be skipped based on regime
   * @param {string} regime - Market regime
   * @param {boolean} isReverse - Is reverse strategy
   * @returns {boolean} True if should skip
   */
  shouldSkipStrategy(regime, isReverse) {
    const params = this.getRegimeParams(regime, {});
    
    if (isReverse && params.disableReverse) {
      return true;
    }
    
    if (!isReverse && params.disableTrendFollow) {
      return true;
    }
    
    return false;
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      regimeCacheSize: this._regimeCache.size,
      ocHistorySize: this._ocHistory.size,
      thresholds: {
        sideway: this.sidewayMaxOC,
        trending: this.trendingMinOC,
        volExpansion: this.volExpansionMinOC,
        newsSpike: this.newsSpikeMinOC
      }
    };
  }
}

// Export singleton instance
export const marketRegimeService = new MarketRegimeService();


