import { PriceAlertConfig } from '../models/PriceAlertConfig.js';
import { Strategy } from '../models/Strategy.js';
import { mexcPriceWs } from '../services/MexcWebSocketManager.js';
import { webSocketManager } from '../services/WebSocketManager.js';
import { configService } from '../services/ConfigService.js';
import { realtimeOCDetector } from '../services/RealtimeOCDetector.js';
import { webSocketOCConsumer } from '../consumers/WebSocketOCConsumer.js';
import { priceAlertSymbolTracker } from '../services/PriceAlertSymbolTracker.js';
import logger from '../utils/logger.js';

/**
 * OcAlertScanner
 * - Every N seconds, compute OC for configured symbols/intervals
 * - OC = ((currentPrice - open)/open) * 100
 * - currentPrice from WS if available (MEXC), otherwise last candle close
 * - Send Telegram alert if |OC| >= threshold with compact format
 */
export class OcAlertScanner {
  constructor() {
    this.telegramService = null;
    this.isRunning = false;
    this.timer = null;
    this.lastSent = new Map(); // legacy: key -> ts
    this.state = new Map(); // key: cfgId|exch|sym|int -> { lastAlertTime, armed, lastOc, lastPrice }
    this.scanTimeout = null; // Track active scan timeout
    this.lastScanTime = 0; // Track when last scan completed
    this.scanIndex = new Map(); // cfgId -> next start index for round-robin batching
    this.openCache = new Map(); // key: exch|sym|int|bucketStart -> open

    // Caches for configs and watch lists (refresh periodically)
    this.configsCache = null; // array of active configs
    this.configsCacheTime = 0;
    this.configsCacheTTL = 30_000; // 30s
    this.watchByExchange = new Map(); // exchange -> { symbols:Set, intervals:Set, threshold:number, chatId:string, cfgId:number }
  }

  async initialize(telegramService) {
    this.telegramService = telegramService;
    // Build initial watch list and attach WS listeners
    await this.refreshWatchlist();

    // Attach tick handlers once
    try {
      const mexcHandler = ({ symbol, price, ts }) => {
        // Log first few calls to verify handler is invoked
        if (!this._mexcHandlerCount) this._mexcHandlerCount = 0;
        this._mexcHandlerCount++;
        if (this._mexcHandlerCount <= 20 || this._mexcHandlerCount % 1000 === 0) {
          logger.info(`[OcAlertScanner] MEXC price handler called: ${symbol} = ${price} (count: ${this._mexcHandlerCount})`);
        }
        this.onTick('mexc', symbol, price, ts).catch(error => {
          logger.error(`[OcAlertScanner] Error in MEXC onTick:`, error?.message || error);
        });
      };
      mexcPriceWs.onPrice?.(mexcHandler);
      logger.info(`[OcAlertScanner] ✅ Registered MEXC price handler (handlers: ${mexcPriceWs._priceHandlers?.size || 0})`);
    } catch (error) {
      logger.error(`[OcAlertScanner] ❌ Failed to register MEXC handler:`, error?.message || error);
    }
    try {
      const binanceHandler = ({ symbol, price, ts }) => {
        this.onTick('binance', symbol, price, ts).catch(error => {
          logger.error(`[OcAlertScanner] Error in Binance onTick:`, error?.message || error);
        });
      };
      webSocketManager.onPrice?.(binanceHandler);
      logger.info(`[OcAlertScanner] ✅ Registered Binance price handler`);
    } catch (error) {
      logger.error(`[OcAlertScanner] ❌ Failed to register Binance handler:`, error?.message || error);
    }

    // Periodically refresh watchlist (symbols/intervals/thresholds)
    const ttl = Number(configService.getNumber('OC_ALERT_WATCHLIST_REFRESH_MS', 30000));
    setInterval(() => this.refreshWatchlist().catch(() => {}), Math.max(5000, ttl));
  }

  start() {
    const iv = Number(configService.getNumber('OC_ALERT_SCAN_INTERVAL_MS', 30000)); // Increased from 10s to 30s
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      // Skip if a scan is already running
      if (this.isRunning) {
        logger.debug('[OcAlertScanner] Scan already in progress, skipping this interval');
        return;
      }
      this.scan().catch(e => logger.warn('[OcAlertScanner] scan error:', e?.message || e));
    }, Math.max(1000, iv));
    // also run once soon after start
    setTimeout(() => this.scan().catch(() => {}), 1000);
    logger.info(`[OcAlertScanner] Started with interval ${iv} ms`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.scanTimeout) clearTimeout(this.scanTimeout);
    this.scanTimeout = null;
    this.isRunning = false;
    logger.info('[OcAlertScanner] Stopped');
  }

  normalizeSymbol(symbol) {
    if (!symbol) return symbol;
    return symbol.toUpperCase().replace(/[/:_]/g, '').replace(/USD$/, 'USDT');
  }

  async getCurrentPrice(exchange, symbol) {
    const ex = (exchange || 'mexc').toLowerCase();
    // Try WebSocket first (real-time price)
    try {
      if (ex === 'mexc') {
        const p = mexcPriceWs.getPrice(symbol);
        if (Number.isFinite(Number(p)) && Number(p) > 0) return Number(p);
      } else if (ex === 'binance') {
        const p = webSocketManager.getPrice(symbol);
        if (Number.isFinite(Number(p)) && Number(p) > 0) return Number(p);
      }
    } catch (error) {
      logger.debug(`[OcAlertScanner] WebSocket price fetch failed for ${ex} ${symbol}:`, error?.message || error);
    }
    
    // Fallback: Try REST API if WebSocket price not available
    // For MEXC, always try REST API as WebSocket subscription may not be supported
    try {
      const { ExchangeService } = await import('../services/ExchangeService.js');
      const dummyBot = { id: `alert_${ex}`, exchange: ex };
      const exchangeService = new ExchangeService(dummyBot);
      await exchangeService.initialize();
      const price = await exchangeService.getTickerPrice(symbol);
      if (Number.isFinite(Number(price)) && Number(price) > 0) {
        logger.debug(`[OcAlertScanner] Using REST API price for ${ex} ${symbol}: ${price}`);
        return Number(price);
      }
    } catch (error) {
      logger.warn(`[OcAlertScanner] REST API price fetch failed for ${ex} ${symbol}:`, error?.message || error);
    }
    
    return null;
  }

  getIntervalMs(interval) {
    const m = interval.match(/^(\d+)m$/i);
    if (m) return Number(m[1]) * 60_000;
    const h = interval.match(/^(\d+)h$/i);
    if (h) return Number(h[1]) * 3_600_000;
    return 60_000;
  }

  getBucketStart(interval, ts = Date.now()) {
    const iv = this.getIntervalMs(interval);
    return Math.floor(ts / iv) * iv;
  }

  // Compute open price for arbitrary interval from 1m candles (current bucket)
  async getOpenFromAggregated1m(exchange, symbol, interval, currentPrice = null) {
    const ex = (exchange || 'mexc').toLowerCase();
    const now = Date.now();
    const ivMs = this.getIntervalMs(interval);
    const bucketStart = Math.floor(now / ivMs) * ivMs;
    const cacheKey = `${ex}|${symbol}|${interval}|${bucketStart}`;

    // Check if we already have open price cached for this bucket
    const cached = this.openCache.get(cacheKey);
    if (cached && Number.isFinite(cached) && cached > 0) {
      return cached;
    }

    // For real-time OC detection without database:
    // Use current price as open for new bucket, or fetch from REST API as fallback
    if (currentPrice && Number.isFinite(currentPrice) && currentPrice > 0) {
      // Use current price as open for new bucket (similar to RealtimeOCDetector)
      this.openCache.set(cacheKey, currentPrice);
      logger.debug(`[OcAlertScanner] Using current price as open for ${symbol} ${interval}: ${currentPrice} (new bucket)`);
      return currentPrice;
    }
    
    // Fallback: Try to get current price from WebSocket cache or REST API
    try {
      let price = null;
      
      // Try WebSocket price cache first
      if (ex === 'mexc') {
        const { mexcPriceWs } = await import('../services/MexcWebSocketManager.js');
        price = mexcPriceWs.priceCache.get(symbol.toUpperCase().replace(/[\/:_]/g, ''));
      } else if (ex === 'binance') {
        const { webSocketManager } = await import('../services/WebSocketManager.js');
        price = webSocketManager.getPrice(symbol);
      }

      if (price && Number.isFinite(price) && price > 0) {
        this.openCache.set(cacheKey, price);
        logger.debug(`[OcAlertScanner] Using WS price as open for ${symbol} ${interval}: ${price}`);
        return price;
    }

      // Final fallback: Use REST API to get current price
      logger.debug(`[OcAlertScanner] Fetching current price from REST API for ${symbol} on ${ex}...`);
      const { ExchangeService } = await import('../services/ExchangeService.js');
      const dummyBot = { id: `alert_${ex}`, exchange: ex };
      const exchangeService = new ExchangeService(dummyBot);
      await exchangeService.initialize();
      price = await exchangeService.getTickerPrice(symbol);
      
      if (price && Number.isFinite(price) && price > 0) {
        this.openCache.set(cacheKey, price);
        logger.debug(`[OcAlertScanner] Using REST price as open for ${symbol} ${interval}: ${price}`);
        return price;
    }
    } catch (error) {
      logger.warn(`[OcAlertScanner] Failed to get open price for ${symbol} on ${ex}:`, error?.message || error);
    }

    logger.debug(`[OcAlertScanner] No open price available for ${symbol} ${interval} on ${ex}`);
    return null;
  }

  // Build/refresh watch list from active configs and subscribe WS
  async refreshWatchlist() {
    try {
      // Refresh symbol tracker first
      await priceAlertSymbolTracker.refresh();

      // Note: PriceAlertConfig.findAll() already filters by is_active = TRUE in SQL
      const configs = await PriceAlertConfig.findAll();
      // Double-check: handle both boolean true and number 1 from MySQL
      const activeConfigs = configs.filter(cfg => cfg.is_active === true || cfg.is_active === 1 || cfg.is_active === '1');
      const watchers = [];
      const mexcSet = new Set();
      const binanceSet = new Set();

      for (const cfg of activeConfigs) {
        const exchange = (cfg.exchange || 'mexc').toLowerCase();
        
        // Get symbols from PriceAlertSymbolTracker
        const symbols = Array.from(priceAlertSymbolTracker.getSymbolsForExchange(exchange));
        
        const intervals = Array.isArray(cfg.intervals) && cfg.intervals.length ? cfg.intervals : ['1m'];
        const normalized = symbols.map(s => this.normalizeSymbol(s)).filter(s => s); // filter out empty
        const w = {
          cfgId: cfg.id,
          exchange,
          symbols: new Set(normalized),
          intervals: new Set(intervals),
          threshold: Number(cfg.threshold || 0),
          chatId: cfg.telegram_chat_id
        };
        watchers.push(w);

        for (const s of normalized) {
          if (exchange === 'mexc') mexcSet.add(s);
          else if (exchange === 'binance') binanceSet.add(s);
        }
      }

      if (mexcSet.size) mexcPriceWs.subscribe(Array.from(mexcSet));
      if (binanceSet.size) webSocketManager.subscribe(Array.from(binanceSet));

      this.watchers = watchers;
      logger.info(`[OcAlertScanner] Watchlist refreshed: ${watchers.length} configs; MEXC=${mexcSet.size}, BINANCE=${binanceSet.size}`);
    } catch (e) {
      logger.warn('[OcAlertScanner] refreshWatchlist failed:', e?.message || e);
    }
  }

  // Prime interval open cache for given key
  async primeOpen(exchange, symbol, interval, ts = Date.now(), currentPrice = null) {
    const bucketStart = this.getBucketStart(interval, ts);
    const key = `${exchange}|${symbol}|${interval}|${bucketStart}`;
    if (this.openCache.has(key)) {
      const cached = this.openCache.get(key);
      if (Number.isFinite(cached) && cached > 0) return cached;
    }
    const open = await this.getOpenFromAggregated1m(exchange, symbol, interval, currentPrice);
    if (Number.isFinite(open) && open > 0) this.openCache.set(key, open);
    return open;
  }

  // Event-driven tick handler (non-blocking send)
  async onTick(exchange, symbol, price, ts = Date.now()) {
    try {
      // Check master ENABLE_ALERTS switch first
      const alertsEnabled = configService.getBoolean('ENABLE_ALERTS', true);
      if (!alertsEnabled) {
        logger.debug(`[OcTick] Alerts disabled by ENABLE_ALERTS config, skipping tick for ${exchange} ${symbol}`);
        return;
      }

      if (!this.watchers || this.watchers.length === 0) {
        logger.debug(`[OcTick] No watchers for ${exchange} ${symbol}`);
        return;
      }
      const sym = this.normalizeSymbol(symbol);
      const p = Number(price);
      if (!Number.isFinite(p) || p <= 0) {
        logger.debug(`[OcTick] Invalid price for ${exchange} ${symbol}: ${price}`);
        return;
      }
      
      // Log first few ticks to verify handler is called
      if (this._onTickCount === undefined) this._onTickCount = new Map();
      const exchangeKey = exchange.toLowerCase();
      const count = (this._onTickCount.get(exchangeKey) || 0) + 1;
      this._onTickCount.set(exchangeKey, count);
      
      if (count <= 20 || count % 1000 === 0) {
        logger.info(`[OcTick] Received tick: ${exchange.toUpperCase()} ${sym} = ${p} (count: ${count})`);
      }

      for (const w of this.watchers) {
        if (w.exchange !== (exchange || '').toLowerCase()) continue;
        if (!w.symbols.has(sym)) continue;
        for (const interval of w.intervals) {
          const bucketStart = this.getBucketStart(interval, ts);
          const cacheKey = `${exchange}|${sym}|${interval}|${bucketStart}`;
          let open = this.openCache.get(cacheKey);
          if (!Number.isFinite(open) || open <= 0) {
            // Prime asynchronously; use current price to initialize open for new bucket
            open = await this.primeOpen(exchange, sym, interval, ts, p);
            if (!Number.isFinite(open) || open <= 0) {
              // Log first few failures to debug
              if (this._openFailCount === undefined) this._openFailCount = new Map();
              const failKey = `${exchange}|${sym}|${interval}`;
              const failCount = this._openFailCount.get(failKey) || 0;
              if (failCount < 5) {
                logger.warn(`[OcTick] ${exchange.toUpperCase()} ${sym} ${interval}: open not ready, price=${p} (fail count: ${failCount + 1})`);
                this._openFailCount.set(failKey, failCount + 1);
              }
              continue;
            }
          }

          const oc = ((p - open) / open) * 100;
          
          // Log first few ticks for debugging
          if (this._tickCount === undefined) this._tickCount = 0;
          this._tickCount++;
          if (this._tickCount <= 20 || this._tickCount % 100 === 0) {
            logger.info(`[OcTick] ${exchange.toUpperCase()} ${sym} ${interval}: open=${open} price=${p} oc=${oc.toFixed(2)}% (tick #${this._tickCount})`);
          } else {
          logger.debug(`[OcTick] ${exchange.toUpperCase()} ${sym} ${interval}: open=${open} price=${p} oc=${oc.toFixed(2)}%`);
          }
          const now = Date.now();
          const stateKey = `${w.cfgId}|${exchange}|${sym}|${interval}`;
          let state = this.state.get(stateKey);
          if (!state) {
            state = { lastAlertTime: 0, armed: true, lastOc: oc, lastPrice: p };
            this.state.set(stateKey, state);
          }
          state.lastPrice = p;
          state.lastOc = oc;

          const minIntervalMs = Number(configService.getNumber('OC_ALERT_TICK_MIN_INTERVAL_MS', configService.getNumber('PRICE_ALERT_MIN_INTERVAL_MS', 60000)));
          const rearmRatio = Number(configService.getNumber('OC_ALERT_REARM_RATIO', 0.6));
          const absOc = Math.abs(oc);
          const absThreshold = Math.abs(Number(w.threshold || 0));
          if (absThreshold <= 0) continue;

          if (absOc >= absThreshold && state.armed) {
            const elapsed = now - (state.lastAlertTime || 0);
            if (elapsed >= minIntervalMs) {
              // Use config's telegram_chat_id, don't fallback to default
              const chatId = w.chatId;
              if (!chatId) {
                logger.warn(`[OcTick] No telegram_chat_id for config ${w.cfgId} (${exchange}), skipping alert for ${sym}`);
                continue;
              }
              logger.info(`[OcTick] Sending alert for ${exchange.toUpperCase()} ${sym} ${interval} oc=${oc.toFixed(2)}% (thr=${absThreshold}%) to chat_id=${chatId} (config_id=${w.cfgId})`);
              this.telegramService.sendVolatilityAlert(chatId, {
                symbol: sym,
                interval,
                oc,
                open,
                currentPrice: p,
                direction: oc >= 0 ? 'bullish' : 'bearish'
              }).catch((error) => {
                logger.error(`[OcTick] Failed to send alert to chat_id=${chatId}:`, error?.message || error);
              });
              state.lastAlertTime = now;
              state.armed = false;
              logger.info(`[OcTick] ✅ Alert sent: ${exchange.toUpperCase()} ${sym} ${interval} oc=${oc.toFixed(2)}% to chat_id=${chatId}`);

              // Immediately match strategies and execute orders (event-driven)
              try {
                const matches = await realtimeOCDetector.detectOC(exchange, sym, p, ts || Date.now(), 'OcAlertScanner.onTick');
                if (Array.isArray(matches) && matches.length > 0) {
                  logger.info(`[OcTick] 🎯 Strategy matches found after alert: ${matches.length} for ${exchange.toUpperCase()} ${sym}`);
                  for (const match of matches) {
                    try {
                      // Send an additional alert using the matched interval and OC (to avoid interval mismatch with watcher)
                      // Use config's telegram_chat_id, don't fallback to default
                      const matchChatId = w.chatId;
                      if (!matchChatId) {
                        logger.debug(`[OcTick] No telegram_chat_id for config ${w.cfgId}, skipping match alert`);
                        continue;
                      }
                      const mOC = Number(match.oc || match.absOC || 0);
                      const mOpen = Number(match.openPrice || open);
                      const mCur = Number(match.currentPrice || p);
                      const mInt = match.interval || interval;
                      const mDir = match.direction || (mCur >= mOpen ? 'bullish' : 'bearish');
                      await this.telegramService.sendVolatilityAlert(matchChatId, {
                        symbol: sym,
                        interval: mInt,
                        oc: mOC,
                        open: mOpen,
                        currentPrice: mCur,
                        direction: mDir
                      }).catch(() => {});

                      // Continue to execute order immediately
                      await webSocketOCConsumer.processMatch(match);
                    } catch (procErr) {
                      logger.error(`[OcTick] Error processing match for strategy ${match?.strategy?.id}:`, procErr?.message || procErr);
                    }
                  }
                } else {
                  logger.debug(`[OcTick] No strategy matches for ${exchange.toUpperCase()} ${sym} right after alert`);
                }
              } catch (detErr) {
                logger.error('[OcTick] Error during immediate strategy match after alert:', detErr?.message || detErr);
              }
            }
          } else if (absOc < absThreshold * rearmRatio) {
            state.armed = true;
          }
        }
      }
    } catch (e) {
      logger.debug('[OcAlertScanner] onTick error:', e?.message || e);
    }
  }

  async scan() {
    // Check master ENABLE_ALERTS switch first
    const alertsEnabled = configService.getBoolean('ENABLE_ALERTS', true);
    if (!alertsEnabled) {
      logger.debug('[OcAlertScanner] Alerts disabled by ENABLE_ALERTS config, skipping scan');
      return;
    }

    if (this.isRunning) {
      logger.debug('[OcAlertScanner] Scan already in progress, skipping');
      return; // avoid overlap
    }
    
    this.isRunning = true;
    const scanStartTime = Date.now();
    const maxScanDurationMs = Number(configService.getNumber('OC_ALERT_MAX_SCAN_DURATION_MS', 30000)); // 30 second timeout
    
    try {
      const configs = await PriceAlertConfig.findAll();
      if (!configs || configs.length === 0) {
        logger.debug('[OcAlertScanner] No alert configs found');
        return;
      }

      logger.info(`[OcAlertScanner] Scan started: Found ${configs.length} alert configs`);
      
      // Ensure WebSocket subscriptions are up-to-date
      const allSymbols = new Set();
      const mexcSymbols = new Set();
      const binanceSymbols = new Set();
      
      for (const cfg of configs) {
        if (!cfg.is_active) continue;
        const exchange = (cfg.exchange || 'mexc').toLowerCase();
        let symbols = typeof cfg.symbols === 'string' ? JSON.parse(cfg.symbols) : (cfg.symbols || []);
        
        // Get symbols from PriceAlertSymbolTracker (handles fallback to symbol_filters)
        if (!Array.isArray(symbols) || symbols.length === 0) {
          // Refresh symbol tracker to ensure we have latest symbols
          await priceAlertSymbolTracker.refresh();
          symbols = Array.from(priceAlertSymbolTracker.getSymbolsForExchange(exchange));
          logger.debug(`[OcAlertScanner] Config ${cfg.id}: Loaded ${symbols.length} symbols from PriceAlertSymbolTracker for ${exchange} (in scan)`);
        }
        
        if (Array.isArray(symbols)) {
          for (const sym of symbols) {
            const norm = this.normalizeSymbol(sym);
            if (norm) {
            allSymbols.add(norm);
            if (exchange === 'mexc') {
              mexcSymbols.add(norm);
            } else if (exchange === 'binance') {
              binanceSymbols.add(norm);
              }
            }
          }
        }
        
        logger.debug(`[OcAlertScanner] Config ${cfg.id}: exchange=${cfg.exchange}, symbols_count=${Array.isArray(symbols) ? symbols.length : 0}, intervals=${JSON.stringify(cfg.intervals)}, threshold=${cfg.threshold}, active=${cfg.is_active}`);
      }
      
      // Subscribe WebSockets
      if (mexcSymbols.size > 0) {
        logger.debug(`[OcAlertScanner] Subscribing MEXC WS to ${mexcSymbols.size} symbols`);
        mexcPriceWs.subscribe(Array.from(mexcSymbols));
      }
      if (binanceSymbols.size > 0) {
        logger.debug(`[OcAlertScanner] Subscribing Binance WS to ${binanceSymbols.size} symbols`);
        webSocketManager.subscribe(Array.from(binanceSymbols));
      }

      const thresholdByConfig = (cfg) => Number(cfg.threshold || 0);
      const minIntervalMs = Number(configService.getNumber('PRICE_ALERT_MIN_INTERVAL_MS', 60000));
      const rearmRatio = Number(configService.getNumber('OC_ALERT_REARM_RATIO', 0.6)); // re-arm when oc falls below ratio*threshold
      const now = Date.now();

      for (const cfg of configs) {
        // Check if scan has exceeded max duration
        if (Date.now() - scanStartTime > maxScanDurationMs) {
          logger.warn(`[OcAlertScanner] Scan exceeded max duration (${maxScanDurationMs}ms), stopping early`);
          break;
        }

        if (!cfg.is_active) continue;
        const exchange = (cfg.exchange || 'mexc').toLowerCase();
        let symbols = typeof cfg.symbols === 'string' ? JSON.parse(cfg.symbols) : (cfg.symbols || []);
        
        // Get symbols from PriceAlertSymbolTracker (handles fallback to symbol_filters)
        if (!Array.isArray(symbols) || symbols.length === 0) {
          // Refresh symbol tracker to ensure we have latest symbols
          await priceAlertSymbolTracker.refresh();
          symbols = Array.from(priceAlertSymbolTracker.getSymbolsForExchange(exchange));
          logger.debug(`[OcAlertScanner] Config ${cfg.id}: Loaded ${symbols.length} symbols from PriceAlertSymbolTracker for ${exchange}`);
        }
        
        const intervals = typeof cfg.intervals === 'string' ? JSON.parse(cfg.intervals) : (cfg.intervals || ['1m']);
        const cfgThreshold = thresholdByConfig(cfg);
        const minThresholdCfg = Number(configService.getNumber('OC_ALERT_MIN_THRESHOLD_PERCENT', NaN));
        const threshold = Number.isFinite(minThresholdCfg) ? Math.max(cfgThreshold, minThresholdCfg) : cfgThreshold;
        if (threshold !== cfgThreshold) {
          logger.debug(`[OcAlertScanner] Threshold bumped by config: cfg=${cfgThreshold}% -> effective=${threshold}%`);
        }
        if (!Array.isArray(symbols) || symbols.length === 0) continue;
        if (!Array.isArray(intervals) || intervals.length === 0) continue;

        for (const s of symbols) {
          const sym = this.normalizeSymbol(s);
          let currentPrice = await this.getCurrentPrice(exchange, sym);
          
          if (!Number.isFinite(Number(currentPrice))) {
            logger.debug(`[OcAlertScanner] Skipping ${sym}: invalid current price (${currentPrice})`);
            continue;
          }

          for (const interval of intervals) {
            // Determine open price of current interval bucket (real-time, no database)
            const open = await this.getOpenFromAggregated1m(exchange, sym, interval, Number(currentPrice));
            
            if (!Number.isFinite(open) || open <= 0) {
              logger.debug(`[OcAlertScanner] Skipping ${sym} ${interval}: invalid open price (${open})`);
              continue;
            }

            const oc = ((Number(currentPrice) - open) / open) * 100; // signed
            const key = `${cfg.id}|${exchange}|${sym}|${interval}`;
            const stateKey = key;
            
            let state = this.state.get(stateKey);
            if (!state) {
              state = { lastAlertTime: 0, armed: true, lastOc: oc, lastPrice: Number(currentPrice) };
              this.state.set(stateKey, state);
              logger.debug(`[OcAlertScanner] New state for ${sym} ${interval}: oc=${oc.toFixed(2)}%, armed=true`);
            }

            // Update last price and OC
            state.lastPrice = Number(currentPrice);
            state.lastOc = oc;

            // Check if we should send an alert
            const absOc = Math.abs(oc);
            const absThreshold = Math.abs(threshold);
            
            // Log at info level when OC is close to threshold to help debug
            if (absOc >= absThreshold * 0.7) {
              logger.info(`[OcAlertScanner] ${sym} ${interval}: oc=${oc.toFixed(2)}% vs threshold=${absThreshold}%, armed=${state.armed}`);
            } else {
            logger.debug(`[OcAlertScanner] ${sym} ${interval}: oc=${oc.toFixed(2)}% vs threshold=${absThreshold}%, armed=${state.armed}`);
            }
            
            if (absOc >= absThreshold && state.armed) {
              const last = state.lastAlertTime || 0;
              const timeSinceLastAlert = now - last;
              logger.info(`[OcAlertScanner] ${sym} ${interval}: Alert condition met! oc=${oc.toFixed(2)}% >= ${absThreshold}%, timeSinceLastAlert=${timeSinceLastAlert}ms, minInterval=${minIntervalMs}ms`);
              
              if (timeSinceLastAlert >= minIntervalMs) {
                // Use config's telegram_chat_id, don't fallback to default
                const chatId = cfg.telegram_chat_id;
                if (!chatId) {
                  logger.warn(`[OcAlertScanner] No telegram_chat_id for config ${cfg.id} (${exchange}), skipping alert for ${sym}`);
                  continue;
                }
                logger.info(`[OcAlertScanner] Sending alert for ${exchange.toUpperCase()} ${sym} ${interval} oc=${oc.toFixed(2)}% to chat_id=${chatId} (config_id=${cfg.id})`);
                await this.telegramService.sendVolatilityAlert(chatId, {
                  symbol: sym,
                  interval,
                  oc,
                  open,
                  currentPrice: Number(currentPrice),
                  direction: oc >= 0 ? 'bullish' : 'bearish'
                }).catch((error) => {
                  logger.error(`[OcAlertScanner] Failed to send alert to chat_id=${chatId}:`, error?.message || error);
                });
                state.lastAlertTime = now;
                state.armed = false; // Disarm after alert
                logger.info(`[OcAlertScanner] ✅ Alert sent: ${exchange.toUpperCase()} ${sym} ${interval} oc=${oc.toFixed(2)}% >= ${absThreshold}% to chat_id=${chatId}`);
              } else {
                logger.debug(`[OcAlertScanner] Alert condition met but rate-limited (${timeSinceLastAlert}ms < ${minIntervalMs}ms)`);
              }
            } else if (absOc < absThreshold * rearmRatio) {
              // Re-arm when OC falls below re-arm threshold
              if (!state.armed) {
                logger.debug(`[OcAlertScanner] Re-arming ${sym} ${interval} (oc=${oc.toFixed(2)}% < ${(absThreshold * rearmRatio).toFixed(2)}%)`);
                state.armed = true;
              }
            }
          }
        }
      }
      
      const scanDuration = Date.now() - scanStartTime;
      logger.info(`[OcAlertScanner] Scan completed in ${scanDuration}ms (scanned ${configs.length} configs)`);
    } catch (e) {
      logger.error('[OcAlertScanner] scan failed:', e);
    } finally {
      this.isRunning = false;
      this.lastScanTime = Date.now();
    }
  }
}

