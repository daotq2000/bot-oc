import logger from '../utils/logger.js';
import { configService } from './ConfigService.js';
import { webSocketManager } from './WebSocketManager.js';

/**
 * SoftwareStopLossService
 * 
 * Handles Stop Loss functionality when exchange-level SL orders are not supported
 * (e.g., Binance Testnet with error -4120 for STOP_MARKET orders).
 * 
 * This service:
 * 1. Monitors position prices via WebSocket
 * 2. When price hits SL level, places a MARKET order to close the position
 * 3. Provides the same protection as exchange-level SL orders
 * 
 * Usage:
 * - Called from PositionMonitor when sl_order_id is NULL
 * - Continuously checks price vs stop_loss_price
 * - Triggers MARKET close when SL is breached
 */
export class SoftwareStopLossService {
  constructor(exchangeService) {
    this.exchangeService = exchangeService;
    this._lastCheckTime = new Map(); // positionId -> timestamp
    this._checkIntervalMs = Number(configService.getNumber('SOFTWARE_SL_CHECK_INTERVAL_MS', 500)); // Check every 500ms
    this._enabled = configService.getBoolean('SOFTWARE_SL_ENABLED', true);
    this._triggeredPositions = new Set(); // Positions that have already been triggered (avoid duplicate closes)
  }

  /**
   * Check if a position's SL has been breached and close if necessary
   * @param {Object} position - Position object with id, symbol, side, stop_loss_price, amount
   * @returns {Promise<Object|null>} - Close order result or null if not triggered
   */
  async checkAndTriggerSL(position) {
    if (!this._enabled) {
      return null;
    }

    // Validate position
    if (!position || position.status !== 'open') {
      return null;
    }

    const positionId = position.id;
    const symbol = position.symbol;
    const side = position.side;
    const slPrice = Number(position.stop_loss_price || position.sl_price || 0);

    // No SL price set
    if (!slPrice || slPrice <= 0) {
      return null;
    }

    // Already triggered
    if (this._triggeredPositions.has(positionId)) {
      logger.debug(`[SoftwareSL] Position ${positionId} already triggered, skipping`);
      return null;
    }

    // Throttle checks
    const lastCheck = this._lastCheckTime.get(positionId) || 0;
    const now = Date.now();
    if (now - lastCheck < this._checkIntervalMs) {
      return null;
    }
    this._lastCheckTime.set(positionId, now);

    // Get current price
    let currentPrice;
    try {
      // Try WebSocket price first (faster)
      currentPrice = webSocketManager.getPrice(symbol.toUpperCase());
      
      // Fallback to REST if WebSocket not available
      if (!currentPrice) {
        currentPrice = await this.exchangeService.getTickerPrice(symbol);
      }
    } catch (error) {
      logger.warn(`[SoftwareSL] Failed to get price for ${symbol}: ${error?.message || error}`);
      return null;
    }

    if (!currentPrice || currentPrice <= 0) {
      return null;
    }

    // Check if SL is breached
    const slBreached = this._isSLBreached(side, currentPrice, slPrice);

    if (!slBreached) {
      return null;
    }

    // SL BREACHED! Close position immediately
    logger.error(
      `[SoftwareSL] 🚨 SL TRIGGERED! Position ${positionId} (${symbol} ${side.toUpperCase()}) ` +
      `| Current: ${currentPrice} | SL: ${slPrice} | Closing via MARKET order...`
    );

    // Mark as triggered to avoid duplicate closes
    this._triggeredPositions.add(positionId);

    try {
      const closeResult = await this._closePositionMarket(position);
      
      if (closeResult && closeResult.orderId) {
        logger.info(
          `[SoftwareSL] ✅ SL Close executed! Position ${positionId} (${symbol}) ` +
          `| Order ID: ${closeResult.orderId} | Status: ${closeResult.status}`
        );
        return closeResult;
      } else {
        logger.error(`[SoftwareSL] ❌ SL Close failed - no order ID returned | Position ${positionId}`);
        // Remove from triggered so it can retry
        this._triggeredPositions.delete(positionId);
        return null;
      }
    } catch (error) {
      logger.error(
        `[SoftwareSL] ❌ SL Close failed with error | Position ${positionId} (${symbol}) ` +
        `| Error: ${error?.message || error}`
      );
      // Remove from triggered so it can retry
      this._triggeredPositions.delete(positionId);
      return null;
    }
  }

  /**
   * Check if SL is breached based on position side
   * @param {string} side - 'long' or 'short'
   * @param {number} currentPrice - Current market price
   * @param {number} slPrice - Stop loss price
   * @returns {boolean} - True if SL is breached
   */
  _isSLBreached(side, currentPrice, slPrice) {
    if (side === 'long') {
      // LONG: SL is below entry, triggered when price falls to or below SL
      return currentPrice <= slPrice;
    } else {
      // SHORT: SL is above entry, triggered when price rises to or above SL
      return currentPrice >= slPrice;
    }
  }

  /**
   * Close position with MARKET order
   * @param {Object} position - Position to close
   * @returns {Promise<Object>} - Order result
   */
  async _closePositionMarket(position) {
    const symbol = position.symbol;
    const side = position.side;
    const quantity = Math.abs(Number(position.amount || position.quantity || 0));

    if (!quantity || quantity <= 0) {
      throw new Error(`Invalid quantity for position ${position.id}: ${quantity}`);
    }

    const binanceClient = this.exchangeService.binanceDirectClient;
    if (!binanceClient) {
      throw new Error('BinanceDirectClient not available');
    }

    // Determine close side (opposite of position side)
    const closeSide = side === 'long' ? 'SELL' : 'BUY';
    
    // Get position side for hedge mode
    const dualSide = await binanceClient.getDualSidePosition();
    const positionSide = side === 'long' ? 'LONG' : 'SHORT';
    
    // Get step size for quantity formatting
    const stepSize = await binanceClient.getStepSize(symbol);
    const formattedQuantity = binanceClient.formatQuantity(quantity, stepSize);

    const params = {
      symbol: binanceClient.normalizeSymbol(symbol),
      side: closeSide,
      type: 'MARKET',
      quantity: formattedQuantity
    };

    if (dualSide) {
      params.positionSide = positionSide;
    }

    logger.info(`[SoftwareSL] Placing MARKET close order: ${JSON.stringify(params)}`);

    const result = await binanceClient.makeRequestWithRetry('/fapi/v1/order', 'POST', params, true);
    
    return result;
  }

  /**
   * Clear triggered status for a position (use when position is closed or reset)
   * @param {number} positionId - Position ID
   */
  clearTriggeredStatus(positionId) {
    this._triggeredPositions.delete(positionId);
    this._lastCheckTime.delete(positionId);
  }

  /**
   * Check multiple positions for SL breach
   * @param {Array} positions - Array of positions to check
   * @returns {Promise<Array>} - Array of close results for triggered positions
   */
  async checkMultiplePositions(positions) {
    const results = [];
    
    for (const position of positions) {
      const result = await this.checkAndTriggerSL(position);
      if (result) {
        results.push({ positionId: position.id, result });
      }
    }
    
    return results;
  }

  /**
   * Get statistics about software SL monitoring
   * @returns {Object} - Stats object
   */
  getStats() {
    return {
      enabled: this._enabled,
      triggeredCount: this._triggeredPositions.size,
      monitoredCount: this._lastCheckTime.size,
      checkIntervalMs: this._checkIntervalMs
    };
  }
}

// Singleton instances per exchange service
const instances = new Map();

/**
 * Get or create SoftwareStopLossService instance for an exchange service
 * @param {ExchangeService} exchangeService - Exchange service instance
 * @returns {SoftwareStopLossService} - Service instance
 */
export function getSoftwareStopLossService(exchangeService) {
  const key = exchangeService.bot?.id || 'default';
  
  if (!instances.has(key)) {
    instances.set(key, new SoftwareStopLossService(exchangeService));
  }
  
  return instances.get(key);
}
