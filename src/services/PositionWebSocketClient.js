import WebSocket from 'ws';
import logger from '../utils/logger.js';
import { configService } from './ConfigService.js';

/**
 * Binance Futures User Data Stream (Positions/Orders) WebSocket client
 * - Manages listenKey lifecycle
 * - Connects to proper WS endpoint (prod/testnet)
 * - Emits raw events via callbacks
 */
export class PositionWebSocketClient {
  constructor(restMakeRequest, isTestnet = true) {
    this.makeRequest = restMakeRequest; // (endpoint, method, params, requiresAuth)
    this.isTestnet = isTestnet;
    this.listenKey = null;
    this.ws = null;
    this.keepAliveTimer = null;
    this.reconnectTimer = null;
    this.handlers = {
      accountUpdate: null,
      orderTradeUpdate: null,
      listenKeyExpired: null,
      raw: null
    };
    this._isStopped = false;
  }

  on(event, handler) {
    if (event === 'ACCOUNT_UPDATE') this.handlers.accountUpdate = handler;
    else if (event === 'ORDER_TRADE_UPDATE') this.handlers.orderTradeUpdate = handler;
    else if (event === 'listenKeyExpired') this.handlers.listenKeyExpired = handler;
    else if (event === 'raw') this.handlers.raw = handler;
  }

  getWsBase() {
    // Binance Futures user data stream endpoints
    // prod: wss://fstream.binance.com/ws
    // testnet: wss://stream.binancefuture.com/ws
    return this.isTestnet
      ? (configService.getString('BINANCE_TESTNET_WS_BASE', 'wss://stream.binancefuture.com/ws'))
      : 'wss://fstream.binance.com/ws';
  }

  async createListenKey() {
    const res = await this.makeRequest('/fapi/v1/listenKey', 'POST', {}, true);
    this.listenKey = res.listenKey;
    logger.debug(`[WS] Created listenKey`);
  }

  async keepAlive() {
    try {
      if (!this.listenKey) return;
      await this.makeRequest('/fapi/v1/listenKey', 'PUT', { listenKey: this.listenKey }, true);
      logger.debug('[WS] listenKey keepalive sent');
    } catch (e) {
      logger.warn(`[WS] listenKey keepalive failed: ${e?.message || e}`);
    }
  }

  scheduleKeepAlive() {
    const intervalMs = Number(configService.getNumber('LISTEN_KEY_KEEPALIVE_MS', 30 * 60 * 1000));
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = setInterval(() => this.keepAlive(), Math.max(60_000, intervalMs));
  }

  async connect() {
    if (this._isStopped) return;
    if (!this.listenKey) {
      await this.createListenKey();
    }
    const url = `${this.getWsBase()}/${this.listenKey}`;
    logger.debug(`[WS] Connecting user stream: ${url}`);
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      logger.debug('[WS] User stream connected');
    });

    this.ws.on('message', (data) => {
      try {
        const evt = JSON.parse(data);
        this.handlers.raw && this.handlers.raw(evt);
        const e = evt?.e || evt?.eventType;
        if (e === 'ACCOUNT_UPDATE') {
          this.handlers.accountUpdate && this.handlers.accountUpdate(evt);
        } else if (e === 'ORDER_TRADE_UPDATE') {
          this.handlers.orderTradeUpdate && this.handlers.orderTradeUpdate(evt);
        } else if (e === 'listenKeyExpired') {
          logger.warn('[WS] listenKeyExpired received');
          this.handlers.listenKeyExpired && this.handlers.listenKeyExpired(evt);
          this.reconnect(true);
        }
      } catch (err) {
        logger.debug(`[WS] parse error: ${err?.message || err}`);
      }
    });

    this.ws.on('close', () => {
      logger.warn('[WS] User stream closed');
      this.reconnect();
    });

    this.ws.on('error', (err) => {
      logger.error('[WS] User stream error:', err);
      this.reconnect();
    });

    this.scheduleKeepAlive();
  }

  async reconnect(forceNewListenKey = false) {
    if (this._isStopped) return;
    try {
      if (this.ws) {
        this.ws.terminate();
        this.ws = null;
      }
      if (this.keepAliveTimer) {
        clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = null;
      }
    } catch (_) {}

    if (forceNewListenKey) this.listenKey = null;

    const backoff = Number(configService.getNumber('WS_RECONNECT_BACKOFF_MS', 3000));
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), backoff);
  }

  stop() {
    this._isStopped = true;
    try { if (this.ws) this.ws.terminate(); } catch (_) {}
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws = null;
    this.keepAliveTimer = null;
    this.reconnectTimer = null;
    logger.debug('[WS] User stream stopped');
  }
}

export default PositionWebSocketClient;

