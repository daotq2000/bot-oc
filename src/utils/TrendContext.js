import logger from './logger.js';
import { configService } from '../services/ConfigService.js';

/**
 * TrendContext (in-memory)
 *
 * HARD RULES:
 * - No DB candles
 * - Tick-driven only for realtime updates (currentPrice / openPrice from match)
 * - Optional + backward compatible
 * - Only applied to trend-following (is_reverse_strategy=false)
 *
 * Add-ons:
 * - OHLCV seeding via ExchangeService.fetchOHLCV (REST) to warm-up EMA fast
 * - Binance-only REST ticker warmup polling (short TTL) when WS misses ticks
 */
export class TrendContext {
  /**
   * Get config value from botConfig (priority) or fallback to global config
   * @param {Object|null} botConfig - Bot's config_filter object
   * @param {string} key - Config key (e.g., 'TREND_FILTER_SEED_TIMEFRAME')
   * @param {Function} getter - ConfigService getter function (getString, getNumber, getBoolean)
   * @param {*} defaultValue - Default value if not found
   * @returns {*} Config value
   */
  _getConfigValue(botConfig, key, getter, defaultValue) {
    if (botConfig && botConfig[key] !== undefined && botConfig[key] !== null) {
      return getter === configService.getString ? String(botConfig[key]) :
             getter === configService.getNumber ? Number(botConfig[key]) :
             getter === configService.getBoolean ? Boolean(botConfig[key]) :
             botConfig[key];
    }
    return getter(key, defaultValue);
  }

  _getWarmupCfg(botConfig = null) {
    return {
      enabled: this._getConfigValue(botConfig, 'TREND_FILTER_WARMUP_TICKER_ENABLED', configService.getBoolean, false),
      intervalMs: this._getConfigValue(botConfig, 'TREND_FILTER_WARMUP_TICKER_INTERVAL_MS', configService.getNumber, 400),
      ttlMs: this._getConfigValue(botConfig, 'TREND_FILTER_WARMUP_TICKER_TTL_MS', configService.getNumber, 15000),
      maxSymbols: this._getConfigValue(botConfig, 'TREND_FILTER_WARMUP_TICKER_MAX_SYMBOLS', configService.getNumber, 5)
    };
  }

  /**
   * Get seeding config from botConfig or global config
   * @param {Object|null} botConfig - Bot's config_filter object
   * @returns {Object} Seeding config
   */
  _getSeedingConfig(botConfig = null) {
    return {
      enabled: this._getConfigValue(botConfig, 'TREND_FILTER_SEED_ENABLED', configService.getBoolean, true),
      timeframe: this._getConfigValue(botConfig, 'TREND_FILTER_SEED_TIMEFRAME', configService.getString, '1m'),
      limit: this._getConfigValue(botConfig, 'TREND_FILTER_SEED_LIMIT', configService.getNumber, 120),
      ttlMs: this._getConfigValue(botConfig, 'TREND_FILTER_SEED_TTL_MS', configService.getNumber, 10 * 60 * 1000)
    };
  }

  constructor(opts = {}) {
    this.emaPeriod = Number(opts.emaPeriod ?? configService.getNumber('TREND_FILTER_EMA_PERIOD', 50));
    this.slopeLookback = Number(opts.slopeLookback ?? configService.getNumber('TREND_FILTER_SLOPE_LOOKBACK', 10));

    // slope threshold in percent (e.g. 0.02 means 0.02%)
    this.slopeThresholdPct = Number(
      opts.slopeThresholdPct ?? configService.getNumber('TREND_FILTER_EMA_SLOPE_THRESHOLD_PCT', 0.02)
    );

    // OC continuity
    this.continuityWindow = Number(opts.continuityWindow ?? configService.getNumber('TREND_FILTER_OC_WINDOW', 5));
    this.prevOcRatio = Number(opts.prevOcRatio ?? configService.getNumber('TREND_FILTER_OC_PREV_RATIO', 0.6));

    // Seeding (warm-up) from OHLCV (NO DB candles)
    this.enableSeeding = Boolean(opts.enableSeeding ?? configService.getBoolean('TREND_FILTER_SEED_ENABLED', true));
    this.seedTimeframe = String(opts.seedTimeframe ?? configService.getString('TREND_FILTER_SEED_TIMEFRAME', '1m'));
    this.seedLimit = Number(opts.seedLimit ?? configService.getNumber('TREND_FILTER_SEED_LIMIT', 120));
    this.seedTtlMs = Number(opts.seedTtlMs ?? configService.getNumber('TREND_FILTER_SEED_TTL_MS', 10 * 60 * 1000));

    // memory
    this.maxSymbols = Number(opts.maxSymbols ?? configService.getNumber('TREND_FILTER_MAX_SYMBOLS', 500));
    this._state = new Map(); // symbol -> { ema, emaHistory: number[], ocHistory: {oc,dir,ts}[], _tickCount }
    this._seedInFlight = new Map(); // symbol -> Promise<boolean>
    this._seededAt = new Map(); // symbol -> timestamp

    // Warmup ticker polling (Binance-only for now)
    this._warmupTimers = new Map(); // symbol -> { timer, endsAt }
    this._warmupRunning = new Set(); // active symbols
    this._warmupQueue = []; // pending symbols
  }

  isEnabled() {
    return Boolean(configService.getBoolean('ENABLE_TREND_FILTER', true));
  }

  _get(symbol) {
    if (!this._state.has(symbol)) {
      // Simple eviction when map grows too large
      if (this._state.size >= this.maxSymbols) {
        const firstKey = this._state.keys().next().value;
        if (firstKey) this._state.delete(firstKey);
      }
      this._state.set(symbol, { ema: null, emaHistory: [], ocHistory: [], _tickCount: 0 });
    }
    return this._state.get(symbol);
  }

  _updateEma(prevEma, price) {
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) return prevEma;

    // Seed EMA with first price
    if (!Number.isFinite(prevEma) || prevEma === null) return p;

    const k = 2 / (this.emaPeriod + 1);
    return (p * k) + (prevEma * (1 - k));
  }

  /**
   * Seed EMA history from recent OHLCV close prices.
   * - Uses ExchangeService.fetchOHLCV (REST) (NO DB candles)
   * - Per-symbol TTL to avoid repeated REST calls
   * @param {string} symbol - Trading symbol
   * @param {Object} exchangeService - Exchange service instance
   * @param {Object|null} botConfig - Bot's config_filter object (optional)
   */
  async ensureSeeded(symbol, exchangeService, botConfig = null) {
    const seedingConfig = this._getSeedingConfig(botConfig);
    if (!seedingConfig.enabled) return false;
    if (!symbol || !exchangeService) return false;

    // Use symbol+botId as key if botConfig provided to separate state per bot
    const stateKey = botConfig ? `${symbol}_bot_${botConfig._botId || 'default'}` : symbol;
    const now = Date.now();
    const lastSeeded = this._seededAt.get(stateKey) || 0;
    if (lastSeeded && (now - lastSeeded) < seedingConfig.ttlMs) {
      return true;
    }

    // de-dupe concurrent seeding
    if (this._seedInFlight.has(stateKey)) {
      return await this._seedInFlight.get(stateKey);
    }

    const seedPromise = (async () => {
      try {
        logger.info(`[TREND-SEED-START] symbol=${symbol} tf=${seedingConfig.timeframe} limit=${seedingConfig.limit} botConfig=${botConfig ? 'yes' : 'no'}`);

        const candles = await exchangeService.fetchOHLCV(symbol, seedingConfig.timeframe, seedingConfig.limit);
        if (!Array.isArray(candles) || candles.length === 0) {
          logger.warn(`[TREND-SEED-EMPTY] symbol=${symbol} tf=${seedingConfig.timeframe} limit=${seedingConfig.limit}`);
          return false;
        }

        // Convert to a stream of close prices.
        // ExchangeService.fetchOHLCV may return:
        // - Binance direct: array of arrays [openTime, open, high, low, close, volume]
        // - CCXT converted: array of objects {close: ...}
        const closes = [];
        for (const c of candles) {
          const close = Array.isArray(c) ? Number(c[4]) : Number(c?.close);
          if (Number.isFinite(close) && close > 0) closes.push(close);
        }

        if (closes.length === 0) {
          logger.warn(`[TREND-SEED-NO_CLOSES] symbol=${symbol}`);
          return false;
        }

        // Build EMA series from oldest -> newest
        const s = this._get(symbol);
        s.emaHistory = [];
        let ema = null;
        for (const close of closes) {
          ema = this._updateEma(ema, close);
          if (Number.isFinite(ema)) s.emaHistory.push(ema);
        }

        const maxHist = Math.max(this.slopeLookback + 5, 50);
        if (s.emaHistory.length > maxHist) {
          s.emaHistory.splice(0, s.emaHistory.length - maxHist);
        }

        s.ema = s.emaHistory.length ? s.emaHistory[s.emaHistory.length - 1] : s.ema;
        this._seededAt.set(stateKey, now);

        logger.info(
          `[TREND-SEED-DONE] symbol=${symbol} closes=${closes.length} emaHist=${s.emaHistory.length} ` +
          `emaReady=${s.emaHistory.length >= (this.slopeLookback + 1)} ema=${Number.isFinite(Number(s.ema)) ? Number(s.ema).toFixed(8) : 'n/a'} ` +
          `tf=${seedingConfig.timeframe} botConfig=${botConfig ? 'yes' : 'no'}`
        );

        return true;
      } catch (e) {
        logger.warn(`[TREND-SEED-FAIL] symbol=${symbol} err=${e?.message || e}`);
        return false;
      } finally {
        this._seedInFlight.delete(stateKey);
      }
    })();

    this._seedInFlight.set(stateKey, seedPromise);
    return await seedPromise;
  }

  /**
   * Update EMA from tick data
   * @param {Object} params - { symbol, currentPrice, ocAbs, direction, timestamp, botConfig? }
   */
  updateFromTick({ symbol, currentPrice, ocAbs, direction, timestamp, botConfig = null }) {
    if (!symbol) return;
    // Use symbol+botId as key if botConfig provided to separate state per bot
    const stateKey = botConfig ? `${symbol}_bot_${botConfig._botId || 'default'}` : symbol;
    const s = this._get(stateKey);

    // EMA update
    s.ema = this._updateEma(s.ema, currentPrice);
    if (Number.isFinite(s.ema)) {
      s.emaHistory.push(s.ema);
      const maxHist = Math.max(this.slopeLookback + 5, 50);
      if (s.emaHistory.length > maxHist) s.emaHistory.splice(0, s.emaHistory.length - maxHist);
    }

    // OC history update (store abs oc + direction)
    const ts = Number(timestamp || Date.now());
    const ocVal = Number(ocAbs);
    if (Number.isFinite(ocVal) && ocVal >= 0 && (direction === 'bullish' || direction === 'bearish')) {
      s.ocHistory.push({ oc: ocVal, dir: direction, ts });
      if (s.ocHistory.length > this.continuityWindow) {
        s.ocHistory.splice(0, s.ocHistory.length - this.continuityWindow);
      }
    }

    // Optional debug: log warm-up / data collection state (rate-limited)
    const debug = Boolean(configService.getBoolean('TREND_FILTER_DEBUG', false));
    const debugEvery = Number(configService.getNumber('TREND_FILTER_DEBUG_EVERY_N_TICKS', 50));
    s._tickCount = Number(s._tickCount || 0) + 1;
    if (debug && s._tickCount % Math.max(1, debugEvery) === 0) {
      const emaHistLen = s.emaHistory?.length || 0;
      const ocHistLen = s.ocHistory?.length || 0;
      const emaReady = emaHistLen >= (this.slopeLookback + 1);
      const ocReady = ocHistLen >= 2;

      logger.info(
        `[TREND-FILTER-DATA] symbol=${symbol} ticks=${s._tickCount} ` +
        `emaReady=${emaReady} emaHist=${emaHistLen} slopeLookback=${this.slopeLookback} ` +
        `ocReady=${ocReady} ocHist=${ocHistLen} ` +
        `ema=${Number.isFinite(Number(s.ema)) ? Number(s.ema).toFixed(8) : 'n/a'}`
      );
    }
  }

  getEma(symbol, botConfig = null) {
    const stateKey = botConfig ? `${symbol}_bot_${botConfig._botId || 'default'}` : symbol;
    const s = this._get(stateKey);
    return Number.isFinite(s?.ema) ? s.ema : null;
  }

  getEmaSlopePct(symbol, botConfig = null) {
    const stateKey = botConfig ? `${symbol}_bot_${botConfig._botId || 'default'}` : symbol;
    const s = this._get(stateKey);
    const hist = s?.emaHistory || [];
    const lookback = this.slopeLookback;

    if (hist.length < lookback + 1) return null;

    const emaNow = hist[hist.length - 1];
    const emaThen = hist[hist.length - 1 - lookback];
    if (!Number.isFinite(emaNow) || !Number.isFinite(emaThen) || emaThen === 0) return null;

    // slope in percent
    return ((emaNow - emaThen) / emaThen) * 100;
  }

  _checkEmaSlope({ symbol, direction, botConfig = null }) {
    const slopePct = this.getEmaSlopePct(symbol, botConfig);
    if (slopePct === null) {
      const stateKey = botConfig ? `${symbol}_bot_${botConfig._botId || 'default'}` : symbol;
      const s = this._get(stateKey);
      return {
        ok: false,
        reason: 'ema_slope_insufficient_data',
        meta: {
          slopePct: null,
          emaHist: s.emaHistory?.length || 0,
          need: this.slopeLookback + 1,
          slopeLookback: this.slopeLookback
        }
      };
    }

    const thr = this.slopeThresholdPct;
    if (direction === 'bullish') {
      return slopePct > thr
        ? { ok: true, reason: null, meta: { slopePct, thr } }
        : { ok: false, reason: 'ema_slope', meta: { slopePct, thr } };
    }

    // bearish
    return slopePct < -thr
      ? { ok: true, reason: null, meta: { slopePct, thr } }
      : { ok: false, reason: 'ema_slope', meta: { slopePct, thr } };
  }

  _checkOcContinuity({ symbol, direction, ocAbs, threshold, botConfig = null }) {
    const stateKey = botConfig ? `${symbol}_bot_${botConfig._botId || 'default'}` : symbol;
    const s = this._get(stateKey);
    const hist = s.ocHistory || [];

    // Need at least previous point in same direction
    if (hist.length < 2) {
      return { ok: false, reason: 'oc_continuity_insufficient_data', meta: { have: hist.length } };
    }

    const prev = hist[hist.length - 2];
    const prevOk = prev?.dir === direction && Number(prev?.oc) >= Number(threshold) * this.prevOcRatio;

    const curOk = Number(ocAbs) >= Number(threshold);
    if (curOk && prevOk) return { ok: true, reason: null, meta: { prevOc: prev.oc, prevRatio: this.prevOcRatio } };

    return {
      ok: false,
      reason: 'oc_continuity',
      meta: {
        prevDir: prev?.dir,
        prevOc: prev?.oc,
        needPrevOcAtLeast: Number(threshold) * this.prevOcRatio,
        curOc: ocAbs,
        threshold
      }
    };
  }

  _checkPricePosition({ symbol, direction, currentPrice, openPrice, botConfig = null }) {
    const ema = this.getEma(symbol, botConfig);
    if (ema === null) {
      return { ok: false, reason: 'price_position_insufficient_data', meta: { ema: null } };
    }

    const cur = Number(currentPrice);
    const open = Number(openPrice);

    if (direction === 'bullish') {
      const ok = cur > ema && open > ema;
      return ok
        ? { ok: true, reason: null, meta: { ema } }
        : { ok: false, reason: 'price_position', meta: { ema, cur, open } };
    }

    const ok = cur < ema && open < ema;
    return ok
      ? { ok: true, reason: null, meta: { ema } }
      : { ok: false, reason: 'price_position', meta: { ema, cur, open } };
  }

  async _startWarmupForSymbol({ symbol, exchangeService, directionHint = null, botConfig = null }) {
    const cfg = this._getWarmupCfg(botConfig);
    if (!cfg.enabled) return false;
    if (!symbol || !exchangeService) return false;

    // Binance-only for now (per requirement)
    const exName = String(exchangeService?.bot?.exchange || exchangeService?.bot?.exchangeName || '').toLowerCase();
    if (exName && exName !== 'binance') return false;

    // Use stateKey for warmup tracking to separate per bot
    const stateKey = botConfig ? `${symbol}_bot_${botConfig._botId || 'default'}` : symbol;
    
    // Already running
    if (this._warmupRunning.has(stateKey)) return true;

    // Concurrency limit
    if (this._warmupRunning.size >= cfg.maxSymbols) {
      if (!this._warmupQueue.includes(stateKey)) {
        this._warmupQueue.push(stateKey);
        logger.info(`[TREND-WARMUP-QUEUE] symbol=${symbol} stateKey=${stateKey} running=${this._warmupRunning.size}/${cfg.maxSymbols}`);
      }
      return false;
    }

    const s = this._get(stateKey);
    const endsAt = Date.now() + cfg.ttlMs;
    this._warmupRunning.add(stateKey);

    logger.info(`[TREND-WARMUP-START] symbol=${symbol} stateKey=${stateKey} intervalMs=${cfg.intervalMs} ttlMs=${cfg.ttlMs} botConfig=${botConfig ? 'yes' : 'no'}`);

    const tick = async () => {
      try {
        // Stop if TTL reached
        if (Date.now() >= endsAt) {
          this._stopWarmup(stateKey, 'ttl');
          return;
        }

        // Stop early if EMA slope is ready
        const emaHistLen = s.emaHistory?.length || 0;
        if (emaHistLen >= (this.slopeLookback + 1)) {
          this._stopWarmup(stateKey, 'ema_ready');
          return;
        }

        const price = await exchangeService.getTickerPrice(symbol);
        if (Number.isFinite(Number(price)) && Number(price) > 0) {
          // Update EMA from warmup tick.
          this.updateFromTick({
            symbol,
            currentPrice: Number(price),
            ocAbs: 0,
            direction: directionHint || 'bullish',
            timestamp: Date.now(),
            botConfig
          });
        }
      } catch (e) {
        logger.debug(`[TREND-WARMUP] tick error symbol=${symbol}: ${e?.message || e}`);
      }
    };

    // Kick once immediately, then interval
    await tick();
    const timer = setInterval(tick, Math.max(100, cfg.intervalMs));
    this._warmupTimers.set(stateKey, { timer, endsAt });

    return true;
  }

  _stopWarmup(stateKey, reason) {
    const t = this._warmupTimers.get(stateKey);
    if (t?.timer) {
      try { clearInterval(t.timer); } catch (_) {}
    }
    this._warmupTimers.delete(stateKey);

    if (this._warmupRunning.has(stateKey)) {
      this._warmupRunning.delete(stateKey);
      logger.info(`[TREND-WARMUP-STOP] stateKey=${stateKey} reason=${reason} running=${this._warmupRunning.size}`);
    }

    // Note: we don't auto-start queued symbol here because we don't have exchangeService reference.
    // It will be triggered again on next insufficient-data block.
  }

  /**
   * Called when filter can't evaluate due to missing EMA slope data.
   * Strategy:
   * 1) Try OHLCV seed first (fast, fewer REST calls)
   * 2) If still not enough, start short REST ticker warmup polling (Binance-only)
   * @param {Object} params - { symbol, exchangeService, direction, botConfig? }
   */
  async maybeWarmupOnInsufficientData({ symbol, exchangeService, direction, botConfig = null }) {
    const cfg = this._getWarmupCfg(botConfig);
    const seedingConfig = this._getSeedingConfig(botConfig);

    const stateKey = botConfig ? `${symbol}_bot_${botConfig._botId || 'default'}` : symbol;
    const s = this._get(stateKey);
    const need = this.slopeLookback + 1;

    // If already ready, nothing to do
    if ((s.emaHistory?.length || 0) >= need) return false;

    // Try seed first
    if (seedingConfig.enabled) {
      await this.ensureSeeded(symbol, exchangeService, botConfig);
    }

    // After seeding, check again
    if ((s.emaHistory?.length || 0) >= need) return true;

    // If warmup disabled, stop here
    if (!cfg.enabled) return false;

    return await this._startWarmupForSymbol({ symbol, exchangeService, directionHint: direction, botConfig });
  }

  /**
   * Validate trend for trend-following only.
   * Returns { ok, reason, meta }
   * @param {Object} params - { symbol, currentPrice, openPrice, direction, ocAbs, ocThreshold, botConfig? }
   */
  isValidTrend({ symbol, currentPrice, openPrice, direction, ocAbs, ocThreshold, botConfig = null }) {
    if (!this.isEnabled()) return { ok: true, reason: null, meta: { disabled: true } };

    const checks = [
      this._checkEmaSlope({ symbol, direction, botConfig }),
      this._checkOcContinuity({ symbol, direction, ocAbs, threshold: ocThreshold, botConfig }),
      this._checkPricePosition({ symbol, direction, currentPrice, openPrice, botConfig })
    ];

    const fail = checks.find(c => !c.ok);
    if (!fail) return { ok: true, reason: null, meta: { ema: this.getEma(symbol, botConfig), slopePct: this.getEmaSlopePct(symbol, botConfig) } };

    return fail;
  }

  logBlock({ reason, symbol, direction, meta }) {
    try {
      logger.info(
        `[TREND-FILTER-BLOCK] reason=${reason} symbol=${symbol} direction=${direction} meta=${JSON.stringify(meta || {})}`
      );
    } catch (_) {
      logger.info(`[TREND-FILTER-BLOCK] reason=${reason} symbol=${symbol} direction=${direction}`);
    }
  }
}

// Singleton
export const trendContext = new TrendContext();
