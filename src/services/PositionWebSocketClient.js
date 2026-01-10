import WebSocket from 'ws';
import { EventEmitter } from 'events';
import logger from '../utils/logger.js';
import { configService } from './ConfigService.js';

/**
 * Binance Futures User Data Stream (Positions/Orders) WebSocket client
 * - Manages listenKey lifecycle
 * - Connects to proper WS endpoint (prod/testnet)
 * - Emits events via EventEmitter
 * 
 * Events:
 * - 'ACCOUNT_UPDATE': Account update events
 * - 'ORDER_TRADE_UPDATE': Order and trade update events
 * - 'listenKeyExpired': ListenKey expired event
 * - 'raw': Raw WebSocket messages
 * - 'connected': WebSocket connected
 * - 'disconnected': WebSocket disconnected
 * - 'error': WebSocket errors
 */
export class PositionWebSocketClient extends EventEmitter {
  constructor(restMakeRequest, isTestnet = true) {
    super();
    this.makeRequest = restMakeRequest; // (endpoint, method, params, requiresAuth)
    this.isTestnet = isTestnet;
    this.listenKey = null;
    this.ws = null;
    this.keepAliveTimer = null;
    this.reconnectTimer = null;
    this.pingPongTimer = null;
    this._isStopped = false;
    this._isReconnecting = false;
    this.state = 'idle'; // 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped'
    this.lastPong = Date.now();
  }

  /**
   * Register event handler (for backward compatibility)
   * @deprecated Use EventEmitter methods (on, once, etc.) instead
   */
  on(event, handler) {
    // Backward compatibility: delegate to EventEmitter
    super.on(event, handler);
  }

  getWsBase() {
    // Binance Futures user data stream endpoints
    // prod: wss://fstream.binance.com/ws
    // testnet: wss://stream.binancefuture.com/ws
    return this.isTestnet
      ? (configService.getString('BINANCE_TESTNET_WS_BASE', 'wss://stream.binancefuture.com/ws'))
      : 'wss://fstream.binance.com/ws';
  }

  /**
   * Create a new listenKey from Binance
   * @throws {Error} If API call fails or no listenKey returned
   */
  async createListenKey() {
    try {
    const res = await this.makeRequest('/fapi/v1/listenKey', 'POST', {}, true);
      if (!res?.listenKey) {
        throw new Error('No listenKey returned from Binance API');
      }
    this.listenKey = res.listenKey;
      logger.debug('[WS] Created listenKey');
      return this.listenKey;
    } catch (e) {
      logger.error('[WS] createListenKey failed:', e?.message || e);
      throw e;
    }
  }

  /**
   * Expire/delete the current listenKey
   * Should be called when listenKey expires or before creating a new one
   */
  async expireListenKey() {
    if (!this.listenKey) return;
    try {
      await this.makeRequest('/fapi/v1/listenKey', 'DELETE', { listenKey: this.listenKey }, true);
      logger.debug('[WS] Expired listenKey');
    } catch (e) {
      // Ignore errors (listenKey may already be expired)
      logger.debug(`[WS] expireListenKey failed (may already be expired): ${e?.message || e}`);
    } finally {
      this.listenKey = null;
    }
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
    if (this._isStopped) {
      logger.debug('[WS] Cannot connect: client is stopped');
      return;
    }

    if (this.state === 'connecting' || this.state === 'connected') {
      logger.debug('[WS] Already connecting or connected, skipping');
      return;
    }

    this.state = 'connecting';

    // Create listenKey if needed
    if (!this.listenKey) {
      try {
      await this.createListenKey();
      } catch (e) {
        const isInvalidKeyError = e?.code === -2015 || (e?.message || '').includes('-2015');

        if (isInvalidKeyError) {
          logger.error(`[WS] PERMANENT ERROR: Invalid API key (code ${e?.code || -2015}). Disabling user-data WebSocket for this bot to prevent retry storms.`);
          // Stop this client instance permanently. It will not try to reconnect.
          await this.stop();
        } else {
          // For temporary errors, log and schedule a reconnect
        logger.error('[WS] Failed to create listenKey, will retry:', e?.message || e);
        this.state = 'idle';
        this.reconnect(true);
        }
        return; // Exit the connect attempt
      }
    }

    const url = `${this.getWsBase()}/${this.listenKey}`;
    logger.debug('[WS] Connecting user stream');
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.state = 'connected';
      this.lastPong = Date.now(); // Reset pong timestamp on connect
      logger.debug('[WS] User stream connected');
      this.emit('connected');
      this.scheduleKeepAlive();
      this.schedulePingPongCheck();
    });

    this.ws.on('message', (data) => {
      try {
        const evt = JSON.parse(data);
        // Emit raw event first
        this.emit('raw', evt);
        
        const e = evt?.e || evt?.eventType;
        if (e === 'ACCOUNT_UPDATE') {
          this.emit('ACCOUNT_UPDATE', evt);
        } else if (e === 'ORDER_TRADE_UPDATE') {
          this.emit('ORDER_TRADE_UPDATE', evt);
        } else if (e === 'listenKeyExpired') {
          logger.warn('[WS] listenKeyExpired received');
          this.emit('listenKeyExpired', evt);
          // Expire old listenKey and reconnect with new one
          this.expireListenKey().then(() => {
            this.reconnect(true);
          }).catch((err) => {
            logger.error('[WS] Error expiring listenKey:', err?.message || err);
          this.reconnect(true);
          });
        }
      } catch (err) {
        logger.debug(`[WS] parse error: ${err?.message || err}`);
      }
    });

    this.ws.on('pong', () => {
      this.lastPong = Date.now();
      logger.debug('[WS] Received pong');
    });

    this.ws.on('close', () => {
      this.state = 'idle';
      logger.warn('[WS] User stream closed');
      this.emit('disconnected');
      this.clearTimers();
      // Only reconnect if not stopped and not already reconnecting
      if (!this._isStopped && !this._isReconnecting) {
      this.reconnect();
      }
    });

    this.ws.on('error', (err) => {
      logger.error('[WS] User stream error:', err);
      this.emit('error', err);
      // Only reconnect if not stopped and not already reconnecting
      if (!this._isStopped && !this._isReconnecting) {
      this.reconnect();
      }
    });
  }

  /**
   * Schedule ping/pong timeout check
   * If no pong received within 2 minutes, terminate connection
   */
  schedulePingPongCheck() {
    if (this.pingPongTimer) clearInterval(this.pingPongTimer);
    this.pingPongTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      
      const timeSinceLastPong = Date.now() - this.lastPong;
      const timeoutMs = 2 * 60 * 1000; // 2 minutes
      
      if (timeSinceLastPong > timeoutMs) {
        logger.warn(`[WS] No pong received for ${Math.floor(timeSinceLastPong / 1000)}s, terminating connection`);
        this.ws.terminate();
      } else {
        // Send ping if connection is open
        try {
          if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.ping();
          }
        } catch (e) {
          logger.debug(`[WS] Ping failed: ${e?.message || e}`);
        }
      }
    }, 60_000); // Check every minute
  }

  /**
   * Clear all timers
   */
  clearTimers() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    if (this.pingPongTimer) {
      clearInterval(this.pingPongTimer);
      this.pingPongTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async reconnect(forceNewListenKey = false) {
    // CRITICAL FIX: Prevent reconnect storm
    if (this._isStopped || this._isReconnecting) {
      logger.debug('[WS] Reconnect skipped: stopped or already reconnecting');
      return;
    }

    this._isReconnecting = true;
    this.state = 'reconnecting';

    try {
      // Clean up existing connection
      if (this.ws) {
        try {
        this.ws.terminate();
        } catch (_) {}
        this.ws = null;
      }
      
      this.clearTimers();

      // Expire old listenKey if requested
      if (forceNewListenKey) {
        await this.expireListenKey();
      }
    } catch (e) {
      logger.debug(`[WS] Error during reconnect cleanup: ${e?.message || e}`);
    }

    // Calculate backoff with jitter to prevent thundering herd
    const baseBackoff = Number(configService.getNumber('WS_RECONNECT_BACKOFF_MS', 3000));
    const jitter = Math.random() * 1000; // 0-1000ms jitter
    const backoff = baseBackoff + jitter;

    logger.debug(`[WS] Reconnecting in ${Math.floor(backoff)}ms...`);
    
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      this._isReconnecting = false;
      await this.connect();
    }, backoff);
  }

  /**
   * Stop the WebSocket client and clean up resources
   * After calling stop(), the client will not reconnect
   */
  async stop() {
    this._isStopped = true;
    this.state = 'stopped';
    
    // Expire listenKey before stopping
    await this.expireListenKey();
    
    // Clean up WebSocket
    try {
      if (this.ws) {
        this.ws.terminate();
      }
    } catch (_) {}
    this.ws = null;
    
    // Clear all timers
    this.clearTimers();
    
    logger.debug('[WS] User stream stopped');
    this.emit('stopped');
  }

  /**
   * Get current state of the WebSocket client
   * @returns {string} Current state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped'
   */
  getState() {
    return this.state;
  }

  /**
   * Check if WebSocket is connected
   * @returns {boolean}
   */
  isConnected() {
    return this.state === 'connected' && this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}

export default PositionWebSocketClient;

