import crypto from 'crypto';
import logger from '../utils/logger.js';
import { configService } from './ConfigService.js';

/**
 * MexcFuturesClient (direct REST + CCXT delegate fallback)
 *
 * This project integrates MEXC Contract/Futures via:
 * - Default: delegates to CCXT for stability
 * - Optional direct mode: uses MEXC Contract REST "sign" query parameter style:
 *    - Build a sorted query string (k=v&...)
 *    - Signature = HMAC_SHA256(queryString, secret)
 *    - Call: `${path}?${queryString}&sign=${signature}`
 *    - Header: ApiKey
 *
 * NOTE:
 * Some MEXC docs also describe alternative header-based signatures. This codebase
 * standardizes on the query-string `sign=` approach because it matches the working
 * examples currently used in our bot.
 */
export class MexcFuturesClient {
  /**
   * @param {object} bot - Bot object (id, access_key, secret_key, uid, ...)
   * @param {object} ccxtExchange - Initialized CCXT mexc exchange instance (defaultType: 'swap')
   */
  constructor(bot, ccxtExchange) {
    this.bot = bot;
    this.exchange = ccxtExchange; // CCXT driver (fallback)
    this.baseURL = configService.getString('MEXC_FUTURES_REST_BASE', 'https://contract.mexc.co');
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

  /**
   * Build full URL with sorted query & sign param (query-string signature style)
   * @param {string} path - e.g. '/api/v1/private/order/submit'
   * @param {object} params - key/value object (timestamp MUST be included by caller)
   */
  buildSignedUrl(path, params = {}) {
    const accessKey = this.bot?.access_key || this.bot?.apiKey;
    if (!accessKey) throw new Error('Missing MEXC access key');
    const queryStr = this.buildQueryString(params);
    const sig = this.signString(queryStr);
    const qs = queryStr ? `${queryStr}&sign=${sig}` : `sign=${sig}`;
    return `${this.baseURL}${path}?${qs}`;
  }

  async _signedGet(path, params = {}, timeoutMs = 10000) {
    // enforce timestamp param
    if (!('timestamp' in params)) params.timestamp = Date.now();
    const url = this.buildSignedUrl(path, params);

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'ApiKey': this.bot?.access_key || this.bot?.apiKey }
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
      return json;
    } finally { clearTimeout(t); }
  }

  async _signedPost(path, params = {}, bodyObj = {}, timeoutMs = 10000) {
    if (!('timestamp' in params)) params.timestamp = Date.now();
    const url = this.buildSignedUrl(path, params);
    const body = bodyObj && Object.keys(bodyObj).length ? JSON.stringify(bodyObj) : '{}';

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'ApiKey': this.bot?.access_key || this.bot?.apiKey,
          'Content-Type': 'application/json'
        },
        body,
        signal: controller.signal
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
      return json;
    } finally { clearTimeout(t); }
  }

  buildQueryString(params) {
    // Sort alphabetically and join as k=v (null/undefined excluded); URL-encode values
    const keys = Object.keys(params || {})
      .filter(k => params[k] !== null && params[k] !== undefined)
      .sort();
    return keys.map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
  }

  signString(str) {
    const secret = this.bot?.secret_key || this.bot?.secret || '';
    return crypto.createHmac('sha256', secret).update(str).digest('hex');
  }

  /**
   * NOTE: Legacy header-signature flow removed.
   * This project uses either:
   *  - Official API key/secret mode (sign query + ApiKey header) via _signedGet/_signedPost
   *  - Testnet demo mode (mtoken + x-mxc-sign) via _testnetGet/_testnetPost
   */
  async _request(method, path, { query = {}, body = null, timeoutMs = 10000 } = {}) {
    if (String(this.baseURL).includes('futures.testnet.mexc.com')) {
      // testnet demo auth
      if (method.toUpperCase() === 'GET') return await this._testnetGet(path, query, timeoutMs);
      return await this._testnetPost(path, query, body || {}, timeoutMs);
    }

    // default: official API signing style
    if (method.toUpperCase() === 'GET') return await this._signedGet(path, query, timeoutMs);
    return await this._signedPost(path, query, body || {}, timeoutMs);
  }

  /**
   * Direct REST create order (fallback to CCXT if disabled)
   * side: 'buy' | 'sell'
   * type: 'market' | 'limit'
   * amount: notional USDT (we compute vol = amount/price)
   *
   * NOTE (Testnet demo HAR): the web demo uses a different endpoint and auth:
   *   POST /api/v1/private/order/create?mhash=...
   *   headers: mtoken + x-mxc-sign
   *   body includes additional encrypted fields (p0, k0, chash, mhash, ts)
   * Those fields are generated by web JS and are NOT derivable from API secret.
   * => Bot trading should use official API mode, not web-demo mode.
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

    // Official REST mapping (not testnet-demo mapping)
    // side: 1=open long, 2=close short, 3=open short, 4=close long (per docs you provided earlier)
    // type: 1=limit, 2=market
    const sideMap = { 'buy': 1, 'sell': 3 };
    const typeMap = { 'limit': 1, 'market': 2 };

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

    const endpoint = this.isTestnetDemo ? '/api/v1/private/order/create' : '/api/v1/private/order/submit';
    const query = this.isTestnetDemo ? (extra?.mhash ? { mhash: extra.mhash } : {}) : {};
    const json = await this._request('POST', endpoint, { query, body });

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

  /**
   * ===== Testnet demo (web) helpers =====
   *
   * From HAR we extracted that futures.testnet.mexc.com uses:
   *  - Header: mtoken (session)
   *  - Header: x-mxc-sign (opaque signature from web)
   *
   * This is NOT the official API-key signing method.
   * We can only support this mode if you provide these values via config/env.
   */
  get isTestnetDemo() {
    return String(this.baseURL).includes('futures.testnet.mexc.com');
  }

  get testnetMtoken() {
    // Put this into env/config if you really want to replay demo requests
    return configService.getString('MEXC_TESTNET_MTOKEN', '');
  }

  get testnetXSign() {
    // WARNING: In the web demo, x-mxc-sign appears to be generated per request.
    // We cannot re-generate it reliably without the web algorithm.
    // We allow a static override mainly to replay simple GETs that accept it.
    return configService.getString('MEXC_TESTNET_X_MXC_SIGN', '');
  }

  _testnetHeaders() {
    const h = {
      'Content-Type': 'application/json',
      'Origin': this.baseURL,
      'Referer': this.baseURL,
      'User-Agent': 'bot-oc'
    };
    if (this.testnetMtoken) h['mtoken'] = this.testnetMtoken;
    if (this.testnetXSign) h['x-mxc-sign'] = this.testnetXSign;
    return h;
  }

  async _testnetGet(path, query = {}, timeoutMs = 10000) {
    const qs = this.buildQueryString(query);
    const url = `${this.baseURL}${path}${qs ? `?${qs}` : ''}`;

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: this._testnetHeaders(),
        signal: controller.signal
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
      return json;
    } finally { clearTimeout(t); }
  }

  async _testnetPost(path, query = {}, bodyObj = {}, timeoutMs = 10000) {
    const qs = this.buildQueryString(query);
    const url = `${this.baseURL}${path}${qs ? `?${qs}` : ''}`;

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this._testnetHeaders(),
        body: JSON.stringify(bodyObj || {}),
        signal: controller.signal
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
      return json;
    } finally { clearTimeout(t); }
  }

  async cancelOrder(symbol, orderId) {
    if (!this.enableDirect) {
      const ccxtSym = this.toCcxtSymbol(symbol);
      return await this.exchange.cancelOrder(orderId, ccxtSym);
    }
    const params = { symbol: this.toRestSymbol(symbol), orderId: orderId };
    const json = await this._request('POST', '/api/v1/private/order/cancel', { query: params, body: {} });
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

  async getPositionsOpen() {
    // HAR: GET /api/v1/private/position/open_positions?
    const json = await this._request('GET', '/api/v1/private/position/open_positions', { query: {} });
    return json;
  }

  async getOpenOrders({ page_size = 200 } = {}) {
    // HAR: GET /api/v1/private/order/list/open_orders?page_size=200
    const json = await this._request('GET', '/api/v1/private/order/list/open_orders', { query: { page_size } });
    return json;
  }

  async cancelAllOrders({ symbol = null } = {}) {
    // Not found in HAR (web uses different flows). Keep placeholder.
    // If you provide the exact endpoint from HAR, we'll update.
    throw new Error('cancelAllOrders: endpoint not extracted from HAR yet');
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
      // HAR: leverage query endpoint exists: GET /api/v1/private/position/leverage?symbol=BTC_USDT
      // Set leverage endpoint is not present in the provided HAR. Keep old default endpoint but send params as query.
      const query = { symbol: this.toRestSymbol(symbol), leverage: Number(leverage) };
      await this._request('POST', '/api/v1/private/position/leverage', { query, body: {} });
      logger.info(`[MexcFuturesClient] REST setLeverage ${leverage} for ${symbol}`);
    } catch (e) {
      logger.warn(`[MexcFuturesClient] REST setLeverage failed for ${symbol}: ${e?.message || e}`);
    }
  }
}


