import WebSocket from 'ws';
import logger from '../utils/logger.js';
import { configService } from './ConfigService.js';

/**
 * MexcWebSocketManager - Public ticker WebSocket for MEXC USDT-M futures (swap)
 *
 * Notes:
 * - Endpoint: wss://contract.mexc.com/ws
 * - Subscribe format (typical): {"method":"sub.ticker","param":{"symbol":"BTC_USDT"}}
 * - Push format (varies by version): may include { method: 'push.ticker', param: { symbol, lastPrice } }
 *   or { channel: 'push.ticker', data: { symbol, last, lastPrice } }
 * We parse defensively to extract last price.
 */
class MexcWebSocketManager {
  constructor() {
    this.ws = null;
    this.subscribed = new Set(); // normalized 'BTCUSDT'
    this.priceCache = new Map(); // 'BTCUSDT' -> { price, lastAccess }
    this._connecting = false;
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._endpointIndex = 0;
    this.maxPriceCacheSize = 1000; // Maximum number of symbols to cache (reduced from 5000 to save memory)
    this.priceCacheCleanupInterval = 5 * 60 * 1000; // Cleanup every 5 minutes
    this._cleanupTimer = null;
    this._startCacheCleanup();

    // Domain preference/failover tracking
    this._comFailures = 0;
    this._coFailures = 0;
    this._lastAttemptDomain = null; // 'com' | 'co'
    this._failoverThreshold = Number(configService.getNumber('MEXC_WS_COM_FAILOVER_THRESHOLD', 2));
  }

  _startCacheCleanup() {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
    this._cleanupTimer = setInterval(() => this._cleanupPriceCache(), this.priceCacheCleanupInterval);
  }

  _cleanupPriceCache() {
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // Remove entries older than 10 minutes
    let removed = 0;

    // Remove old entries
    for (const [symbol, data] of this.priceCache.entries()) {
      if (now - data.lastAccess > maxAge) {
        this.priceCache.delete(symbol);
        removed++;
      }
    }

    // If still over limit, remove least recently used
    if (this.priceCache.size > this.maxPriceCacheSize) {
      const entries = Array.from(this.priceCache.entries())
        .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
      const toRemove = entries.slice(0, this.priceCache.size - this.maxPriceCacheSize);
      for (const [symbol] of toRemove) {
        this.priceCache.delete(symbol);
        removed++;
      }
    }

    if (removed > 0) {
      logger.debug(`[MEXC-WS] Cleaned up ${removed} price cache entries. Current size: ${this.priceCache.size}`);
    }
  }

  get endpoints() {
    // Build ordered endpoints list with domain preference and de-duplication
    const primary = configService.getString('MEXC_FUTURES_WS_URL', 'wss://contract.mexc.com/edge');
    const primaryDomain = (primary || '').includes('mexc.co') ? 'co' : 'com';

    const uniq = (arr) => Array.from(new Set(arr));

    const comList = uniq([
      ...(primaryDomain === 'com' ? [primary] : []),
      'wss://contract.mexc.com/edge',
      'wss://wbs-api.mexc.com/ws'
    ]);

    const coList = uniq([
      ...(primaryDomain === 'co' ? [primary] : []),
      'wss://contract.mexc.co/edge',
      'wss://wbs.mexc.co/ws'
    ]);

    // Prefer .com if it is connecting; otherwise, fallback to .co
    const preferCo = this._comFailures >= this._failoverThreshold;
    const ordered = preferCo ? [...coList, ...comList] : [...comList, ...coList];
    return ordered;
  }

  get baseUrl() {
    const eps = this.endpoints;
    if (this._endpointIndex >= eps.length) this._endpointIndex = 0;
    const idx = Math.max(0, Math.min(this._endpointIndex, eps.length - 1));
    return eps[idx];
  }

  normalizeSymbol(symbol) {
    if (!symbol) return symbol;
    return symbol.toString().toUpperCase().replace(/[/:_]/g, '').replace(/USD$/, 'USDT');
  }

  toMexcWsSymbol(symbol) {
    const norm = this.normalizeSymbol(symbol);
    if (!norm.endsWith('USDT')) return norm.replace('USDT', '') + '_USDT';
    const base = norm.replace(/USDT$/, '');
    return `${base}_USDT`;
  }

  onPrice(handler) {
    try {
      if (!this._priceHandlers) this._priceHandlers = new Set();
      if (typeof handler === 'function') this._priceHandlers.add(handler);
    } catch (_) {}
  }

  _emitPrice(tick) {
    if (!this._priceHandlers || this._priceHandlers.size === 0) {
      // Log first few times to debug
      if (!this._emitPriceWarnCount) this._emitPriceWarnCount = 0;
      if (this._emitPriceWarnCount < 5) {
        logger.warn(`[MEXC-WS] _emitPrice called but no handlers registered (count: ${this._emitPriceWarnCount + 1})`);
        this._emitPriceWarnCount++;
      }
      return;
    }
    
    // Log first few emits to verify it's being called
    if (!this._emitCount) this._emitCount = 0;
    this._emitCount++;
    if (this._emitCount <= 20 || this._emitCount % 1000 === 0) {
      logger.info(`[MEXC-WS] _emitPrice: ${tick.symbol} = ${tick.price} (emit #${this._emitCount}, handlers: ${this._priceHandlers.size})`);
    }
    
    for (const h of Array.from(this._priceHandlers)) {
      try { 
        h(tick); 
      } catch (error) {
        logger.error(`[MEXC-WS] Error in price handler:`, error?.message || error);
      }
    }
  }

  _domainOf(url) {
    try { return (url || '').includes('.mexc.co') ? 'co' : 'com'; } catch (_) { return 'com'; }
  }

  _recordSuccess(domain) {
    if (domain === 'com') this._comFailures = 0;
    if (domain === 'co') this._coFailures = 0;
  }

  _recordFailure(domain) {
    if (domain === 'com') this._comFailures++; else this._coFailures++;
  }

  ensureConnected() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this._connecting) return;
    this._connecting = true;

    try {
      const url = this.baseUrl;
      const domain = this._domainOf(url);
      this._lastAttemptDomain = domain;
      logger.info(`[MEXC-WS] Connecting ${url} (domain=${domain}, comFailures=${this._comFailures}, coFailures=${this._coFailures})`);
      this.ws = new WebSocket(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Origin': 'https://www.mexc.com'
        }
      });

      // Connection timeout guard (e.g., firewall blocks) - rotate endpoint if not open in time
      let openGuard = setTimeout(() => {
        try { this.ws?.terminate(); } catch (_) {}
        logger.warn('[MEXC-WS] Open timeout, rotating endpoint');
        this._cleanup();
        this._recordFailure(domain);
        this._endpointIndex = (this._endpointIndex + 1) % this.endpoints.length;
        this._scheduleReconnect();
      }, 7000);

      this.ws.on('open', async () => {
        if (openGuard) { clearTimeout(openGuard); openGuard = null; }
        logger.info('[MEXC-WS] Connected');
        this._connecting = false;
        this._recordSuccess(domain);
        
        // For futures endpoint (/edge), send ping first
        if (this.baseUrl.includes('/edge')) {
          const pingMsg = JSON.stringify({ method: 'ping' });
          try {
            this.ws.send(pingMsg);
            logger.debug('[MEXC-WS] Sent initial ping');
          } catch (e) {
            logger.warn('[MEXC-WS] Failed to send initial ping:', e?.message);
          }
          // Wait a bit before subscribing
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        // Resubscribe all (batched)
        await this._resubscribeAllBatched();
        this._startPing();
      });

      // Handle HTTP upgrade failures (e.g., 30x/403)
      this.ws.on('unexpected-response', (req, res) => {
        const code = res?.statusCode;
        logger.error(`[MEXC-WS] unexpected-response: ${code}`);
        try { this.ws?.terminate(); } catch (_) {}
        this._cleanup();
        this._recordFailure(domain);
        // rotate endpoint and reconnect quickly
        this._endpointIndex = (this._endpointIndex + 1) % this.endpoints.length;
        setTimeout(() => this.ensureConnected(), 500);
      });

      this.ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw);
          // Handle pong or heartbeats
          if (msg?.pong || msg === 'pong' || msg?.method === 'pong') return;

          // Log first few messages to debug
          if (!this._messageCount) this._messageCount = 0;
          this._messageCount++;
          if (this._messageCount <= 10) {
            logger.info(`[MEXC-WS] Received message #${this._messageCount}:`, JSON.stringify(msg).substring(0, 200));
          }

          // Handle pong responses
          if (msg?.channel === 'pong' || msg?.method === 'pong') {
            logger.debug('[MEXC-WS] Received pong');
            return;
          }
          
          // Handle subscription success responses
          if (msg?.channel?.startsWith('rs.') && msg?.data === 'success') {
            logger.debug(`[MEXC-WS] Subscription confirmed: ${msg.channel}`);
            return;
          }
          
          // Check for error messages
          if (msg?.code !== undefined && msg?.code !== 0) {
            const errorMsg = msg?.msg || msg?.message || '';
            logger.warn(`[MEXC-WS] Error message: code=${msg.code}, msg=${errorMsg}`);
            return;
          }
          
          // Handle ticker messages (push.ticker format from futures endpoint)
          const channel = msg?.channel || msg?.method || '';
          
          if (channel === 'push.ticker' || (typeof channel === 'string' && channel.includes('ticker'))) {
            const data = msg?.data || msg?.param || {};
            const sym = data?.symbol || msg?.symbol;
            const last = data?.lastPrice ?? data?.last ?? data?.p ?? data?.price;
            
            if (this._messageCount <= 10) {
              logger.info(`[MEXC-WS] Ticker message: symbol=${sym}, lastPrice=${last}, channel=${channel}`);
            }
            
            if (last !== undefined && Number.isFinite(Number(last)) && Number(last) > 0) {
              // If we have symbol, use it; otherwise try to get from subscription
              let normSymbol = sym ? this.normalizeSymbol(sym) : null;
              
              // If no symbol in message, try to match from subscribed symbols
              if (!normSymbol) {
                // For futures endpoint, symbol might not be in message, use first subscribed symbol
                // or we need to track which symbol this ticker is for
                // For now, we'll try to infer from the subscription
                normSymbol = Array.from(this.subscribed)[0];
              }
              
              if (normSymbol) {
              const price = Number(last);
                // Enforce max cache size (LRU eviction)
                if (this.priceCache.size >= this.maxPriceCacheSize && !this.priceCache.has(normSymbol)) {
                  const oldest = Array.from(this.priceCache.entries())
                    .sort((a, b) => a[1].lastAccess - b[1].lastAccess)[0];
                  if (oldest) this.priceCache.delete(oldest[0]);
                }
                this.priceCache.set(normSymbol, { price, lastAccess: Date.now() });
                // Emit to listeners
                this._emitPrice({ symbol: normSymbol, price, ts: Date.now() });
              } else {
                if (this._messageCount <= 10) {
                  logger.warn(`[MEXC-WS] Ticker message but no symbol found: ${JSON.stringify(msg).substring(0, 200)}`);
                }
              }
            } else {
              if (this._messageCount <= 10) {
                logger.warn(`[MEXC-WS] Invalid price in ticker: ${last}`);
              }
            }
          } else {
            // Log other messages for debugging (first 10 only)
            if (this._messageCount <= 10) {
              logger.debug(`[MEXC-WS] Other message: channel=${channel}, keys=${Object.keys(msg).join(',')}`);
            }
          }
        } catch (e) {
          // Log parse errors for first few messages
          if (!this._parseErrorCount) this._parseErrorCount = 0;
          this._parseErrorCount++;
          if (this._parseErrorCount <= 5) {
            logger.warn(`[MEXC-WS] Parse error (count: ${this._parseErrorCount}):`, e?.message || e);
          }
        }
      });

      this.ws.on('close', () => {
        logger.warn('[MEXC-WS] Closed');
        this._cleanup();
        this._recordFailure(domain);
        this._scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        logger.error('[MEXC-WS] Error:', err?.message || err);
        try { this.ws?.terminate(); } catch (_) {}
        this._cleanup();
        this._recordFailure(domain);
        // rotate endpoint on error as well
        this._endpointIndex = (this._endpointIndex + 1) % this.endpoints.length;
        this._scheduleReconnect();
      });
    } catch (e) {
      logger.error('[MEXC-WS] Connect threw:', e?.message || e);
      this._connecting = false;
      this._scheduleReconnect();
    }
  }

  _cleanup() {
    this._connecting = false;
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  _scheduleReconnect() {
    const backoff = Number(configService.getNumber('WS_RECONNECT_BACKOFF_MS', 3000));
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this.ensureConnected(), backoff);
  }

  _startPing() {
    // MEXC Futures requires ping every 10-20 seconds (use 15 seconds)
    // If no ping within 60 seconds, server will disconnect
    const interval = 15000;
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._pingTimer = setInterval(() => {
      try {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          const pingMsg = JSON.stringify({ method: 'ping' });
          this.ws.send(pingMsg);
          logger.debug('[MEXC-WS] Sent ping');
        }
      } catch (e) {
        logger.warn('[MEXC-WS] Failed to send ping:', e?.message);
      }
    }, interval);
  }

  _sendSub(normalizedSymbol) {
    try {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const s = this.toMexcWsSymbol(normalizedSymbol);
      
      // Try different subscription formats based on endpoint
      // Format 1: {"method":"sub.ticker","param":{"symbol":"BTC_USDT"}}
      // Format 2: {"method":"sub.ticker","param":{"symbol":"BTC_USDT"},"id":"1"}
      // Format 3: {"op":"sub.ticker","args":["BTC_USDT"]}
      // Format 4: {"action":"sub","channel":"ticker","symbol":"BTC_USDT"}
      
      // Use official futures format (no id needed for /edge endpoint)
      const msg = JSON.stringify({ 
        method: 'sub.ticker', 
        param: { symbol: s }
      });
      this.ws.send(msg);
      logger.info(`MEXC-WS Subscribed ${s}`);
    } catch (e) {
      logger.warn(`[MEXC-WS] Subscribe failed for ${normalizedSymbol}: ${e?.message || e}`);
    }
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async _subscribeListBatched(list) {
    if (!list || list.length === 0) return;
    const size = Number(configService.getNumber('WS_SUB_BATCH_SIZE', 150));
    const delay = Number(configService.getNumber('WS_SUB_BATCH_DELAY_MS', 50));
    for (let i = 0; i < list.length; i += size) {
      const batch = list.slice(i, i + size);
      for (const sym of batch) this._sendSub(sym);
      if (i + size < list.length && delay > 0) await this._sleep(delay);
    }
  }

  async _resubscribeAllBatched() {
    const all = Array.from(this.subscribed);
    await this._subscribeListBatched(all);
    logger.info(`[MEXC-WS] Resubscribed ${all.length} symbols in batches.`);
  }

  async subscribe(symbols) {
    if (!Array.isArray(symbols)) return;
    const newly = [];
    for (const sym of symbols) {
      const norm = this.normalizeSymbol(sym);
      if (!this.subscribed.has(norm)) {
        this.subscribed.add(norm);
        newly.push(norm);
      }
    }
    this.ensureConnected();
    if (this.ws && this.ws.readyState === WebSocket.OPEN && newly.length) {
      await this._subscribeListBatched(newly);
      logger.info(`[MEXC-WS] Subscribed new ${newly.length} symbols in batches.`);
    }
  }

  getPrice(symbol) {
    const norm = this.normalizeSymbol(symbol);
    const cached = this.priceCache.get(norm);
    if (cached) {
      cached.lastAccess = Date.now();
      return cached.price;
    }
    return null;
  }

  /**
   * Disconnect and cleanup all resources
   */
  disconnect() {
    this._cleanup();
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch (_) {}
      this.ws = null;
    }
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this.subscribed.clear();
    this.priceCache.clear();
    logger.info('[MEXC-WS] Disconnected and cleaned up all resources');
  }
}

const _instance = new MexcWebSocketManager();
export const mexcPriceWs = _instance;

