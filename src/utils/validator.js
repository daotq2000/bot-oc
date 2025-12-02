/**
 * Input validation utilities
 */

/**
 * Validate proxy format: IP:PORT:USER:PASS
 * @param {string} proxy - Proxy string
 * @returns {boolean}
 */
export function validateProxy(proxy) {
  if (!proxy) return true; // Optional
  const parts = proxy.split(':');
  return parts.length === 4;
}

/**
 * Validate exchange name
 * @param {string} exchange - Exchange name
 * @returns {boolean}
 */
export function validateExchange(exchange) {
  return ['mexc', 'gate', 'binance'].includes(exchange?.toLowerCase());
}

/**
 * Validate symbol format
 * @param {string} symbol - Trading symbol (e.g., BTC/USDT)
 * @returns {boolean}
 */
export function validateSymbol(symbol) {
  if (!symbol) return false;
  const parts = symbol.split('/');
  return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;
}

/**
 * Validate interval
 * @param {string} interval - Time interval
 * @returns {boolean}
 */
export function validateInterval(interval) {
  return ['1m', '3m', '5m', '15m', '30m', '1h'].includes(interval);
}

/**
 * Validate trade type
 * @param {string} tradeType - Trade type
 * @returns {boolean}
 */
export function validateTradeType(tradeType) {
  return ['long', 'short', 'both'].includes(tradeType?.toLowerCase());
}

/**
 * Validate amount (must be positive)
 * @param {number} amount - Amount value
 * @returns {boolean}
 */
export function validateAmount(amount) {
  return typeof amount === 'number' && amount > 0;
}

/**
 * Validate percentage values (OC, extend, etc.)
 * @param {number} value - Percentage value
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {boolean}
 */
export function validatePercentage(value, min = 0, max = 1000) {
  return typeof value === 'number' && value >= min && value <= max;
}

/**
 * Validate wallet address format (basic check)
 * @param {string} address - Wallet address
 * @returns {boolean}
 */
export function validateWalletAddress(address) {
  if (!address) return false;
  // Basic validation: should be alphanumeric and 20+ characters
  return /^[a-zA-Z0-9]{20,}$/.test(address);
}

/**
 * Validate network
 * @param {string} network - Network name
 * @returns {boolean}
 */
export function validateNetwork(network) {
  return ['BEP20', 'ERC20', 'TRC20'].includes(network?.toUpperCase());
}

