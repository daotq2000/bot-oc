import crypto from 'crypto';
import logger from '../utils/logger.js';
import { configService } from './ConfigService.js';

/**
 * MexcFuturesClient (direct REST + CCXT delegate fallback)
 *
 * - Default: delegates to CCXT for stability
 * - When enabled and endpoint mapped, uses official REST signing per Integration Guide:
 *   GET: signature over accessKey + timestamp + parameterString (sorted)
 *   POST: signature over accessKey + timestamp + raw JSON body
 *   Headers: ApiKey, Request-Time, Signature, Recv-Window(optional)
 */
export class MexcFuturesClient {
  /**
   * @param {object} bot - Bot object (id, access_key, secret_key, uid, ...)
   * @param {object} ccxtExchange - Initialized CCXT mexc exchange instance (defaultType: 'swap')
   */
  constructor(bot, ccxtExchange) {
    this.bot = bot;
    this.exchange = ccxtExchange; // CCXT driver (fallback)
    this.baseURL = configService.getString('MEXC_FUTURES_REST_BASE', 'https://contract.mexc.com');
    this.recvWindow = Number(configService.getNumber('MEXC_RECV_WINDOW_MS', 60000));
    this.enableDirect = configService.getBoolean('MEXC_FUTURES_DIRECT', false);
    this.verbose = false; // can be enabled by script (--verbose)
  }

  /** Normalize symbol to MEXC futures REST format (BTC_USDT) */
  toRestSymbol(symbol) {
    if (!symbol) return symbol;
    const s = String(symbol).toUpperCase().replace(/[\/:_]/g, '').replace(/USD$/, 'USDT');
    const base = s.endsWith('USDT') ? s.slice(0, -4) : s;
    return `${base}_USDT`;
  }

  /** Normalize symbol to CCXT futures format (BTC/USDT:USDT) */
  toCcxtSymbol(symbol) {
    if (!symbol) return symbol;
    let s = String(symbol).toUpperCase().replace(/[\s:_]/g, '/');
    if (!s.includes('/')) {
      if (s.endsWith('USDT')) s = `${s.replace(/USDT$/, '')}/USDT`;
    }
    if (!s.includes(':')) s = `${s}:USDT`;
    return s;
  }

  nowMillis() { return Date.now().toString(); }

  buildGetParamString(params) {
    // Sort alphabetically and join as k=v (null/undefined excluded)
    const keys = Object.keys(params || {}).filter(k => params[k] !== null && params[k] !== undefined).sort();
    return keys.map(k => `${k}=${params[k]}`).join('&');
  }

  signString(str) {
    const secret = this.bot?.secret_key || this.bot?.secret || '';
    return crypto.createHmac('sha256', secret).update(str).digest('hex');
  }

  async _request(method, path, { query = {}, body = null, timeoutMs = 10000 } = {}) {
    const accessKey = this.bot?.access_key || this.bot?.apiKey;
    if (!accessKey) throw new Error('Missing MEXC access key');

    const ts = this.nowMillis();
    let url = `${this.baseURL}${path}`;
    let signatureInput = '';
    let headers = {
      'Content-Type': 'application/json',
      'ApiKey': accessKey,
      'Request-Time': ts
    };
    if (this.recvWindow && Number.isFinite(this.recvWindow)) headers['Recv-Window'] = String(this.recvWindow);

    if (method.toUpperCase() === 'GET') {
      const paramStr = this.buildGetParamString(query);
      signatureInput = `${accessKey}${ts}${paramStr}`;
      const sig = this.signString(signatureInput);
      headers['Signature'] = sig;
      if (paramStr) url += `?${paramStr}`;
    } else {
      // POST/DELETE with JSON body
      const raw = body ? JSON.stringify(body) : '';
      signatureInput = `${accessKey}${ts}${raw}`;
      const sig = this.signString(signatureInput);
      headers['Signature'] = sig;
      body = raw;
    }

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    // Verbose (masked) logging
    if (this.verbose) {
      try {
        const maskedHeaders = { ...headers };
        if (maskedHeaders['ApiKey']) maskedHeaders['ApiKey'] = maskedHeaders['ApiKey'].slice(0, 4) + '***' + maskedHeaders['ApiKey'].slice(-3);
        if (maskedHeaders['Signature']) maskedHeaders['Signature'] = maskedHeaders['Signature'].slice(0, 8) + '…';
        logger.info(`[MEXC-REST] ${method} ${path} query=${Object.keys(query||{}).length} body=${body ? 'yes' : 'no'} base=${this.baseURL}`);
        logger.debug(`[MEXC-REST] headers=${JSON.stringify(maskedHeaders)}`);
      } catch (_) {}
    }

    try {
      const res = await fetch(url, { method, headers, body, signal: controller.signal });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      // Verbose response
      if (this.verbose) {
        logger.info(`[MEXC-REST] < ${method} ${path} status=${res.status}`);
        logger.debug(`[MEXC-REST] response=${text.substring(0, 500)}`);
      }
      return json;
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Direct REST create order (fallback to CCXT if disabled)
   * side: 'buy' | 'sell'
   * type: 'market' | 'limit'
   * amount: notional USDT (we compute vol = amount/price)
   */
  async createOrder(params) {
    const { symbol, side, type = 'limit', amount, price, extra = {} } = params || {};

    if (!Number.isFinite(Number(price)) || Number(price) <= 0) {
      throw new Error(`Invalid price for ${symbol}: ${price}`);
    }
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      throw new Error(`Invalid notional amount (USDT) for ${symbol}: ${amount}`);
    }

    const ccxtSym = this.toCcxtSymbol(symbol);
    const restSym = this.toRestSymbol(symbol);

    // If not enabled, delegate to CCXT
    if (!this.enableDirect) {
      if (!this.exchange) throw new Error('MEXC CCXT exchange not initialized');
      const qtyRaw = Number(amount) / Number(price);
      const qtyStr = this.exchange.amountToPrecision(ccxtSym, qtyRaw);
      const qty = parseFloat(qtyStr);
      const isLimit = type === 'limit';
      const priceOut = isLimit ? parseFloat(this.exchange.priceToPrecision(ccxtSym, Number(price))) : undefined;
      const order = await this.exchange.createOrder(ccxtSym, type, side, qty, priceOut, extra || {});
      return order;
    }

    // Map to REST body (based on sample): side: 1 buy, 2 sell | type: 1 market, 2 limit | openType: 1 (default)
    const sideMap = { 'buy': 1, 'sell': 2 };
    const typeMap = { 'market': 1, 'limit': 2 };
    const vol = Number(amount) / Number(price);

    // Leverage default from config if not provided via extra
    const lev = Number(extra?.leverage || configService.getNumber('MEXC_DEFAULT_LEVERAGE', 5));

    const body = {
      symbol: restSym,
      side: sideMap[String(side).toLowerCase()] || 1,
      openType: Number(extra?.openType || 1), // default isolated/cross per your account; adjust if needed
      type: typeMap[String(type).toLowerCase()] || 1,
      vol: Number(vol),
      leverage: lev
    };

    // price for limit orders
    if (type === 'limit') body.price = Number(price);

    // reduceOnly if requested (for TP/SL)
    if (extra?.reduceOnly) body.reduceOnly = true;

    const json = await this._request('POST', '/api/v1/private/order/submit', { body });

    // Normalize minimal CCXT-like response
    const orderId = json?.data?.orderId || json?.orderId || json?.data?.id || json?.id || null;
    return {
      id: orderId ? String(orderId) : undefined,
      symbol: ccxtSym,
      type,
      side,
      amount: vol,
      price: price,
      status: 'open',
      raw: json
    };
  }

  async cancelOrder(symbol, orderId) {
    if (!this.enableDirect) {
      const ccxtSym = this.toCcxtSymbol(symbol);
      return await this.exchange.cancelOrder(orderId, ccxtSym);
    }
    const body = { symbol: this.toRestSymbol(symbol), orderId: orderId };
    const json = await this._request('POST', '/api/v1/private/order/cancel', { body });
    return json;
  }

  /** Preflight call: check private access and futures availability for symbol */
  async preflight(symbol) {
    try {
      const restSym = this.toRestSymbol(symbol);
      const json = await this._request('GET', '/api/v1/private/position', { query: { symbol: restSym } });
      // MEXC may return {success:false, code:1002, message:'Contract not activated'} or code=0 on success
      if (json && (json.success === false || (typeof json.code !== 'undefined' && json.code !== 0))) {
        const code = json.code ?? -1;
        const msg = json.message || json.msg || 'unknown';
        return { ok: false, code, message: msg, raw: json };
      }
      return { ok: true, data: json };
    } catch (e) {
      return { ok: false, code: 'HTTP', message: e?.message || String(e) };
    }
  }

  async setLeverage(symbol, leverage) {
    // Try CCXT first; log if not supported
    try {
      const ccxtSym = this.toCcxtSymbol(symbol);
      if (this.exchange && typeof this.exchange.setLeverage === 'function') {
        await this.exchange.setLeverage(leverage, ccxtSym);
        logger.info(`[MexcFuturesClient] Set leverage ${leverage} for ${ccxtSym}`);
        return;
      }
    } catch (e) {
      logger.warn(`[MexcFuturesClient] CCXT setLeverage failed: ${e?.message || e}`);
    }

    if (!this.enableDirect) return;
    // If REST endpoint differs, update below accordingly per official docs
    try {
      const body = { symbol: this.toRestSymbol(symbol), leverage: Number(leverage) };
      await this._request('POST', '/api/v1/private/position/leverage', { body });
      logger.info(`[MexcFuturesClient] REST setLeverage ${leverage} for ${symbol}`);
    } catch (e) {
      logger.warn(`[MexcFuturesClient] REST setLeverage failed for ${symbol}: ${e?.message || e}`);
    }
  }
}


