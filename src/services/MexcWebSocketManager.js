import WebSocket from 'ws';
import logger from '../utils/logger.js';
import { configService } from './ConfigService.js';

/**
 * MexcWebSocketManager - Pure WebSocket implementation (no SDK dependency)
 *
 * This version uses native WebSocket for reliable ticker data and implements its own open-price caching.
 * It completely avoids REST API calls for OC detection, ensuring speed and data consistency.
 */
class MexcWebSocketManager {
  constructor() {
    this.ws = null; // Native WebSocket connection
    this._connecting = false;
    this._reconnectAttempts = 0;
    this.subscribed = new Set(); // Stores normalized symbols (e.g., BTCUSDT)
    this.priceCache = new Map(); // Caches the latest price for each symbol
    this.maxPriceCacheSize = Number(configService.getNumber('MEXC_WS_MAX_PRICE_CACHE', 5000));
    this.openCache = new Map(); // Caches the open price for each symbol|interval|bucket
    this.maxOpenCacheSize = Number(configService.getNumber('MEXC_WS_MAX_OPEN_CACHE', 20000));
    this.klineOpenCache = new Map(); // Caches kline open prices
    this.klineCloseCache = new Map(); // Caches kline close prices
    this.maxKlineCacheSize = Number(configService.getNumber('MEXC_WS_MAX_KLINE_CACHE', 50000));
    this._priceHandlers = new Set();
    this.openTtlMs = 5 * 60 * 1000; // 5 minutes for open price cache
    this.cleanupIntervalMs = 60 * 1000; // 1 minute
    this.klineTtlMs = Number(configService.getNumber('MEXC_WS_KLINE_TTL_MS', 15 * 60 * 1000));
    this._cleanupTimer = null;
    this._reconnectTimer = null;
    this.baseUrl = configService.getString('MEXC_FUTURES_WS_URL', 'wss://contract.mexc.co/edge');
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000; // 5 seconds
    this.pingInterval = 15000; // 15 seconds
    this._pingTimer = null;
    this._startCleanup();
  }

  // --- Utility Methods ---

  normalizeSymbol(symbol) {
    if (!symbol) return null;
    return symbol.toString().toUpperCase().replace(/[/:_]/g, '').replace(/USD$/, 'USDT');
  }

  toMexcWsSymbol(symbol) {
    const base = this.normalizeSymbol(symbol).replace(/USDT$/, '');
    return `${base}_USDT`;
  }

  _getIntervalMs(interval) {
    const match = interval.match(/^(\d+)([mhd])$/);
    if (!match) return 60000; // Default to 1m
    const value = parseInt(match[1]);
    const unit = match[2];
    if (unit === 'm') return value * 60000;
    if (unit === 'h') return value * 3600000;
    return 60000;
  }

  _getBucketStart(ts, interval) {
    const intervalMs = this._getIntervalMs(interval);
    return Math.floor(ts / intervalMs) * intervalMs;
  }

  // --- Public API ---

  onPrice(handler) {
    if (typeof handler === 'function') this._priceHandlers.add(handler);
  }

  getPrice(symbol) {
    const norm = this.normalizeSymbol(symbol);
    return this.priceCache.get(norm)?.price || null;
  }

  getOpen(symbol, interval, ts, currentPrice) {
    const norm = this.normalizeSymbol(symbol);
    const bucket = this._getBucketStart(ts, interval);
    const key = `${norm}|${interval}|${bucket}`;
    let cached = this.openCache.get(key);
    if (!cached) {
      cached = { open: currentPrice, ts };
      if (this.openCache.size >= this.maxOpenCacheSize && !this.openCache.has(key)) {
        // Evict ~5% oldest by insertion order
        const keys = Array.from(this.openCache.keys());
        const drop = Math.max(1, Math.floor(this.maxOpenCacheSize * 0.05));
        for (let i = 0; i < Math.min(drop, keys.length); i++) {
          this.openCache.delete(keys[i]);
        }
        logger.warn(`[MEXC-WS] Open cache overflow (>${this.maxOpenCacheSize}). Evicted ${Math.min(drop, keys.length)} entries.`);
      }
      this.openCache.set(key, cached);
      logger.info(`[MEXC-WS] Primed OPEN for ${norm} ${interval} at ${currentPrice} (bucket: ${bucket})`);
    }
    return cached.open;
  }

  // --- WebSocket Core ---

  ensureConnected() {
    if (this.ws?.readyState === WebSocket.OPEN || this._connecting) return;
    this._connect();
  }

  _connect() {
    if (this._connecting) return;
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this._connecting = true;
    logger.info(`[MEXC-WS] Connecting to ${this.baseUrl}...`);

    try {
      this.ws = new WebSocket(this.baseUrl);
    } catch (e) {
      logger.error('[MEXC-WS] Failed to create WebSocket:', e?.message || e);
      this._connecting = false;
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      logger.info('[MEXC-WS] ✅ WebSocket connected');
      this._connecting = false;
      this._reconnectAttempts = 0;
      this._startPing();
      this._resubscribeAll();
    });

    this.ws.on('message', (raw) => {
      try {
        this._handleMessage(raw);
      } catch (e) {
        logger.error('[MEXC-WS] Message handle error:', e?.message || e);
      }
    });

    this.ws.on('close', (code, reason) => {
      logger.warn(`[MEXC-WS] WebSocket disconnected (code: ${code}, reason: ${reason?.toString() || 'none'})`);
      this._stopPing();
      this._connecting = false;
      this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      logger.error('[MEXC-WS] WebSocket error:', err?.message || err, err?.code || '');
      this._connecting = false;
    });
  }

  _handleMessage(raw) {
    try {
      // MEXC WebSocket can send both JSON and binary (protobuf) messages
      // Try JSON first
      let data;
      if (Buffer.isBuffer(raw)) {
        const text = raw.toString('utf8');
        try {
          data = JSON.parse(text);
        } catch (_) {
          // Might be protobuf or other format, skip for now
          logger.debug(`[MEXC-WS] Received binary/non-JSON message (length: ${raw.length})`);
          return;
        }
      } else if (typeof raw === 'string') {
        data = JSON.parse(raw);
      } else {
        return;
      }

      // Log first few messages for debugging
      if (this._debugMessageCount === undefined) {
        this._debugMessageCount = 0;
      }
      if (this._debugMessageCount < 5) {
        const msgPreview = JSON.stringify(data).substring(0, 200);
        logger.info(`[MEXC-WS] Received message #${this._debugMessageCount + 1}: ${msgPreview}`);
        this._debugMessageCount++;
      }

      // Handle subscription response/error
      // MEXC format: { "channel": "rs.sub.ticker", "data": "success", "ts": ... }
      if (data && data.channel && (data.channel.includes('sub.ticker') || data.channel.includes('sub.kline'))) {
        if (data.data === 'success' || data.code === 0) {
          logger.info(`[MEXC-WS] ✅ Subscription success: ${data.channel}`);
        } else {
          logger.error(`[MEXC-WS] ❌ Subscription failed: ${data.channel}`, JSON.stringify(data));
        }
        return;
      }

      // Also check for method-based format (backward compatibility)
      if (data && (data.method === 'sub.ticker' || data.method === 'sub.kline')) {
        if (data.code === 0 || data.status === 'ok') {
          logger.info(`[MEXC-WS] ✅ Subscription success: ${data.method} ${JSON.stringify(data.param || {})}`);
        } else {
          logger.error(`[MEXC-WS] ❌ Subscription failed: ${data.method}`, JSON.stringify(data));
        }
        return;
      }

      // Handle ticker data
      // MEXC format options:
      // 1. Direct: { symbol, lastPrice, ... }
      // 2. Wrapped in 'd': { d: { symbol, lastPrice, ... } }
      // 3. Channel-based: { channel: "push.ticker", data: { symbol, lastPrice, ... } }
      
      let tickerData = null;
      
      // Check channel-based format first
      if (data && data.channel && data.channel.includes('ticker') && data.data) {
        tickerData = data.data;
      }
      // Check direct format
      else if (data && data.symbol && data.lastPrice !== undefined) {
        tickerData = data;
      }
      // Check wrapped format
      else if (data && data.d && data.d.symbol && data.d.lastPrice !== undefined) {
        tickerData = data.d;
      }
      
      if (tickerData) {
        this._handleTicker(tickerData);
        // Log first few ticker updates for debugging
        if (this._debugTickerCount === undefined) {
          this._debugTickerCount = 0;
        }
        if (this._debugTickerCount < 3) {
          logger.info(`[MEXC-WS] 📊 Ticker update #${this._debugTickerCount + 1}: ${tickerData.symbol} = ${tickerData.lastPrice}`);
          this._debugTickerCount++;
        }
      }

      // Handle kline data if available
      if (data && data.c && data.k) {
        this._handleKline(data);
      }
      
      // Handle kline in channel format
      if (data && data.channel && data.channel.includes('kline') && data.data && data.data.c && data.data.k) {
        this._handleKline(data.data);
      }
    } catch (e) {
      logger.debug(`[MEXC-WS] Message parse error:`, e?.message || e);
    }
  }

  _handleKline(data) {
    try {
      const symbol = this.normalizeSymbol(data.c); // contract name
      const k = data.k;
      if (!symbol || !k) return;

      const interval = String(k.i || '').toLowerCase(); // interval
      const startTime = Number(k.t); // candle start time (ms)
      const open = parseFloat(k.o);
      const close = parseFloat(k.c);
      const isClosed = Boolean(k.x);

      if (Number.isFinite(open) && open > 0 && startTime > 0 && (interval === '1m' || interval === '5m')) {
        this._storeKlineOpen(symbol, interval, open, startTime);
      }

      if (isClosed && Number.isFinite(close) && close > 0 && startTime > 0 && (interval === '1m' || interval === '5m')) {
        this._storeKlineClose(symbol, interval, close, startTime);
      }
    } catch (e) {
      logger.error('[MEXC-WS] Kline handle error:', e?.message || e);
    }
  }

  _storeKlineOpen(symbol, interval, open, startTime) {
    if (!Number.isFinite(open) || open <= 0 || !startTime) return;
    const sym = String(symbol).toUpperCase();
    const key = `${sym}|${interval}|${startTime}`;
    this.klineOpenCache.set(key, {
      open,
      lastUpdate: Date.now()
    });
  }

  _storeKlineClose(symbol, interval, close, startTime) {
    if (!Number.isFinite(close) || close <= 0 || !startTime) return;
    const sym = String(symbol).toUpperCase();
    const key = `${sym}|${interval}|${startTime}`;
    this.klineCloseCache.set(key, {
      close,
      lastUpdate: Date.now()
    });
  }

  getKlineOpen(symbol, interval, bucketStart) {
    const sym = String(symbol).toUpperCase();
    const key = `${sym}|${interval}|${bucketStart}`;
    const cached = this.klineOpenCache.get(key);
    if (!cached || !Number.isFinite(cached.open) || cached.open <= 0) {
      return null;
    }
    cached.lastUpdate = Date.now();
    return cached.open;
  }

  getKlineClose(symbol, interval, bucketStart) {
    const sym = String(symbol).toUpperCase();
    const key = `${sym}|${interval}|${bucketStart}`;
    const cached = this.klineCloseCache.get(key);
    if (!cached || !Number.isFinite(cached.close) || cached.close <= 0) {
      return null;
    }
    cached.lastUpdate = Date.now();
    return cached.close;
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          // MEXC WebSocket ping format: {"method":"ping"}
          this.ws.send(JSON.stringify({ method: 'ping' }));
        } catch (e) {
          logger.debug('[MEXC-WS] Ping failed:', e?.message || e);
        }
      }
    }, this.pingInterval);
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    if (this._reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('[MEXC-WS] Max reconnect attempts reached');
      return;
    }
    this._reconnectAttempts += 1;
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 15000);
    logger.info(`[MEXC-WS] Scheduling reconnect in ${delay}ms (attempt ${this._reconnectAttempts}/${this.maxReconnectAttempts})`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, delay);
  }

  _emitPrice(tick) {
    for (const h of this._priceHandlers) {
      try { h(tick); } catch (e) { logger.error('[MEXC-WS] Price handler error', { message: e?.message }); }
    }
  }

  _handleTicker(data) {
    try {
      const sym = data?.symbol;
      const priceRaw = data?.lastPrice;
      if (!sym || priceRaw == null) return;
      const price = Number(priceRaw);
      if (!Number.isFinite(price) || price <= 0) return;
      const norm = this.normalizeSymbol(sym);
      const ts = Date.now();
      this.priceCache.set(norm, { price, ts });
      this._emitPrice({ symbol: norm, price, ts });
    } catch (e) {
      logger.error('[MEXC-WS] Ticker handle error', { message: e?.message });
    }
  }

  // --- Subscription ---

  async subscribe(symbols) {
    if (!Array.isArray(symbols) || symbols.length === 0) return;
    const newly = new Set();
    for (const s of symbols) {
      const norm = this.normalizeSymbol(s);
      if (norm && !this.subscribed.has(norm)) {
        this.subscribed.add(norm);
        newly.add(norm);
      }
    }
    this.ensureConnected();
    if (this.ws?.readyState === WebSocket.OPEN && newly.size > 0) {
      logger.info(`[MEXC-WS] Subscribing to ${newly.size} new symbols...`);
      for (const sym of newly) {
        this._subscribeToTicker(sym);
      }
    }
  }

  _subscribeToTicker(symbol) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      logger.warn(`[MEXC-WS] Cannot subscribe to ${symbol}: WebSocket not open (state: ${this.ws?.readyState})`);
      return;
    }
    try {
      const mexcSymbol = this.toMexcWsSymbol(symbol);
      
      // MEXC WebSocket subscription format (based on official API docs)
      // Format: {"method":"sub.ticker","param":{"symbol":"BTC_USDT"}}
      // Note: MEXC uses underscore format (BTC_USDT) not slash format
      const subMsg = {
        method: 'sub.ticker',
        param: {
          symbol: mexcSymbol
        }
      };
      
      const msgStr = JSON.stringify(subMsg);
      this.ws.send(msgStr);
      
      // Only log first few subscriptions to avoid spam
      if (!this._subscriptionLogCount) this._subscriptionLogCount = 0;
      if (this._subscriptionLogCount < 5) {
        logger.info(`[MEXC-WS] 📤 Sent subscription #${this._subscriptionLogCount + 1}: ${msgStr} (${symbol} -> ${mexcSymbol})`);
        this._subscriptionLogCount++;
      } else if (this._subscriptionLogCount === 5) {
        logger.info(`[MEXC-WS] 📤 Subscribing to remaining symbols (will log errors only)...`);
        this._subscriptionLogCount++;
      }
    } catch (e) {
      logger.error(`[MEXC-WS] Failed to subscribe to ${symbol}:`, e?.message || e);
    }
  }

  _resubscribeAll() {
    if (this.subscribed.size > 0 && this.ws?.readyState === WebSocket.OPEN) {
      logger.info(`[MEXC-WS] Resubscribing to ${this.subscribed.size} symbols...`);
      let count = 0;
      for (const sym of this.subscribed) {
        this._subscribeToTicker(sym);
        count++;
        // Add small delay to avoid overwhelming the connection
        if (count % 10 === 0) {
          // Log progress every 10 symbols
          logger.debug(`[MEXC-WS] Subscription progress: ${count}/${this.subscribed.size}`);
        }
      }
      logger.info(`[MEXC-WS] ✅ Finished sending ${count} subscription requests`);
    } else {
      logger.warn(`[MEXC-WS] Cannot resubscribe: subscribed=${this.subscribed.size}, wsState=${this.ws?.readyState}`);
    }
  }

  // --- Cleanup ---

  _startCleanup() {
    this._cleanupTimer = setInterval(() => {
      const now = Date.now();
      const maxAge = this.openTtlMs;
      
      // Cleanup openCache
      for (const [k, v] of this.openCache) {
        if (now - v.ts > maxAge) this.openCache.delete(k);
      }
      
      // Cleanup priceCache
      for (const [k, v] of this.priceCache) {
        if (now - v.ts > maxAge) this.priceCache.delete(k);
      }
      
      // Cleanup klineOpenCache
      for (const [k, v] of this.klineOpenCache) {
        if (now - v.lastUpdate > maxAge) this.klineOpenCache.delete(k);
      }
      
      // Cleanup klineCloseCache
      for (const [k, v] of this.klineCloseCache) {
        if (now - v.lastUpdate > maxAge) this.klineCloseCache.delete(k);
      }
    }, this.cleanupIntervalMs);
  }

  disconnect() {
    this._stopPing();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    clearInterval(this._cleanupTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
    this.subscribed.clear();
    this.priceCache.clear();
    this.openCache.clear();
    this.klineOpenCache.clear();
    this.klineCloseCache.clear();
    this._connecting = false;
    this._reconnectAttempts = 0;
    logger.info('[MEXC-WS] Disconnected');
  }

  getStatus() {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      readyState: this.ws?.readyState || 'null',
      subscribedSymbols: this.subscribed.size,
      reconnectAttempts: this._reconnectAttempts
    };
  }
}

export const mexcPriceWs = new MexcWebSocketManager();
