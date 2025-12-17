import { CandleService } from './CandleService.js';
import {
  calculateLongEntryPrice,
  calculateShortEntryPrice,
  calculateTakeProfit,
  calculateInitialStopLoss,
  calculateIgnoreThreshold
} from '../utils/calculator.js';
import logger from '../utils/logger.js';
import { configService } from './ConfigService.js';

/**
 * Strategy Service - Signal generation logic
 */
export class StrategyService {
  constructor(exchangeService, candleService, telegramService) {
    this.exchangeService = exchangeService;
    this.candleService = candleService;
    this.telegramService = telegramService; // For sending price alerts
  }

  /**
   * Check for trading signal and/or price alert
   * 
   * NOTE: This method is now DEPRECATED for realtime detection.
   * Realtime detection is handled by WebSocketOCConsumer.
   * This method is kept for backward compatibility but should not be used for active strategies.
   * 
   * @param {Object} strategy - Strategy object
   * @param {Object} alertConfig - Optional price alert configuration
   * @returns {Promise<Object|null>} Signal object or null
   */
  async checkSignal(strategy, alertConfig = null) {
    try {
      // DEPRECATED: Realtime detection is now handled by WebSocketOCConsumer
      // This method is kept for backward compatibility only
      logger.debug(`[Signal] Strategy ${strategy.id} (${strategy.symbol}): checkSignal() called but realtime detection is handled by WebSocketOCConsumer`);
      return null;

      // OLD CODE (commented out - no longer using database candles):
      /*
      // 1. Get latest candle from database
      const latestCandle = await this.candleService.getLatestCandle(
        strategy.symbol,
        strategy.interval
      );

      if (!latestCandle) {
        logger.info(`[Signal] Strategy ${strategy.id} (${strategy.symbol}): No candle data`);
        return null;
      }

      // 2. Get current market price (for real-time OC calculation)
      const currentPrice = await this.exchangeService.getTickerPrice(strategy.symbol);

      // If price is not available from WebSocket cache, skip this scan
      if (currentPrice === null) {
        logger.warn(`[Signal] Strategy ${strategy.id} (${strategy.symbol}): Price not available - WebSocket may not be connected or symbol not subscribed`);
        return null;
      }

      // 3. Check if candle is closed
      const isClosed = this.candleService.isCandleClosed(latestCandle);
      
      // 4. Calculate OC using current price if candle is not closed, otherwise use close price
      let oc, direction;
      if (!isClosed) {
        // Nến chưa đóng: sử dụng current price để tính OC real-time
        oc = this.candleService.calculateOC(latestCandle.open, currentPrice);
        direction = this.candleService.getCandleDirection(latestCandle.open, currentPrice);
        logger.info(`[Signal] Strategy ${strategy.id} (${strategy.symbol}): Candle OPEN - OC=${oc.toFixed(2)}% (using current price), direction=${direction}, threshold=${strategy.oc}%`);
      } else {
        // Nến đã đóng: sử dụng close price
        const metrics = this.candleService.calculateCandleMetrics(latestCandle);
        oc = metrics.oc;
        direction = metrics.direction;
        logger.info(`[Signal] Strategy ${strategy.id} (${strategy.symbol}): Candle CLOSED - OC=${oc.toFixed(2)}%, direction=${direction}, threshold=${strategy.oc}%`);
      }
      */

      // 4.1. Check for and send price alert if configured
      if (alertConfig) {
        await this.checkAndSendPriceAlert(alertConfig, {
          symbol: strategy.symbol,
          interval: strategy.interval,
          oc,
          open: latestCandle.open,
          currentPrice,
          direction
        });
      }

      // 5. Check if OC meets threshold (absolute value)
      if (Math.abs(oc) < strategy.oc) {
        // Only log when OC is close to threshold to reduce spam
        if (Math.abs(oc) >= strategy.oc * 0.8) {
          logger.info(`[Signal] Strategy ${strategy.id} (${strategy.symbol}): OC ${oc.toFixed(2)}% below threshold ${strategy.oc}%`);
        }
        return null;
      }

      // 6. Determine which side to trade
      const sidesToCheck = this.getSidesToCheck(strategy, direction);
      logger.info(`[Signal] Strategy ${strategy.id} (${strategy.symbol}): Checking sides: ${sidesToCheck.join(', ')} (trade_type=${strategy.trade_type})`);

      // 7. Create a candle object with current price for calculations
      const candleForCalculation = {
        ...latestCandle,
        close: isClosed ? latestCandle.close : currentPrice // Use current price if candle is open
      };

      logger.info(`[Signal] Strategy ${strategy.id} (${strategy.symbol}): Current price=${currentPrice}, Candle open=${latestCandle.open}, close=${candleForCalculation.close} (${isClosed ? 'closed' : 'open'})`);

      // 8. Check each side for signal
      for (const side of sidesToCheck) {
        const signal = await this.checkSideSignal(
          strategy,
          side,
          candleForCalculation,
          currentPrice,
          oc
        );

        if (signal) {
          logger.info(`[Signal] ✅ Strategy ${strategy.id} (${strategy.symbol}): Signal detected! Side=${side}, Entry=${signal.entryPrice}, Current=${currentPrice}`);
          return signal;
        }
      }

      logger.info(`[Signal] Strategy ${strategy.id} (${strategy.symbol}): No signal after checking all sides`);

      return null;
    } catch (error) {
      logger.error(`Error checking signal for strategy ${strategy.id}:`, error);
      return null;
    }
  }

  /**
   * Get sides to check based on trade_type and candle direction
   * @param {Object} strategy - Strategy object
   * @param {string} direction - Candle direction
   * @returns {Array<string>} Array of sides to check
   */
  getSidesToCheck(strategy, direction) {
    // Counter-trend logic: trade against the candle's direction
    if (strategy.trade_type === 'both') {
      // For bullish candle, check SHORT
      // For bearish candle, check LONG
      return direction === 'bullish' ? ['short'] : ['long'];
    } else if (strategy.trade_type === 'long') {
      // Only trade LONG if the candle is bearish
      return direction === 'bearish' ? ['long'] : [];
    } else { // trade_type is 'short'
      // Only trade SHORT if the candle is bullish
      return direction === 'bullish' ? ['short'] : [];
    }
  }

  /**
   * Check signal for specific side
   * @param {Object} strategy - Strategy object
   * @param {string} side - 'long' or 'short'
   * @param {Object} candle - Latest candle
   * @param {number} currentPrice - Current market price
   * @param {number} oc - OC percentage
   * @returns {Promise<Object|null>} Signal or null
   */
  async checkSideSignal(strategy, side, candle, currentPrice, oc) {
    try {
      // Calculate entry price
      const entryPrice = await this.calculateEntryPrice(candle, strategy, side);
      logger.info(`[Signal] Strategy ${strategy.id} (${strategy.symbol}) ${side}: Entry=${entryPrice}, Current=${currentPrice}, Open=${candle.open}, Extend=${strategy.extend}%`);

      // Check if extend condition is met
      const extendMet = this.checkExtendCondition(side, currentPrice, entryPrice, candle.open);
      
      if (!extendMet) {
        const allowLimitFallback = configService.getBoolean('ENABLE_LIMIT_ON_EXTEND_MISS', true);
        if (!allowLimitFallback) {
          logger.info(`[Signal] Strategy ${strategy.id} (${strategy.symbol}) ${side}: Extend condition not met. Current=${currentPrice}, Entry=${entryPrice}, Open=${candle.open} -> skip (config ENABLE_LIMIT_ON_EXTEND_MISS=false)`);
          return null;
        }
        logger.info(`[Signal] Strategy ${strategy.id} (${strategy.symbol}) ${side}: Extend not met -> proceed with LIMIT fallback (will place limit order with TTL)`);
      }

      // Check ignore logic
      const shouldIgnore = await this.shouldIgnoreSignal(
        candle,
        strategy,
        side,
        currentPrice
      );

      if (shouldIgnore) {
        logger.debug(`Signal ignored for ${strategy.symbol} ${side}`);
        return null;
      }

      // Calculate TP and SL
      const tpPrice = calculateTakeProfit(entryPrice, Math.abs(oc), strategy.take_profit, side);
      const slPrice = calculateInitialStopLoss(tpPrice, Math.abs(oc), strategy.reduce, side);

      // Create signal
      return {
        strategy,
        side,
        entryPrice,
        currentPrice,
        tpPrice,
        slPrice,
        amount: strategy.amount,
        oc: Math.abs(oc),
        // If extend not met but fallback allowed, force passive LIMIT instead of trigger
        forcePassiveLimit: !extendMet,
        ttlMinutes: Number(configService.getNumber('ENTRY_ORDER_TTL_MINUTES', 10))
      };
    } catch (error) {
      logger.error(`Error checking side signal for ${strategy.symbol} ${side}:`, error);
      return null;
    }
  }

  /**
   * Calculate entry price
   * @param {Object} candle - Candle object
   * @param {Object} strategy - Strategy object
   * @param {string} side - 'long' or 'short'
   * @returns {number} Entry price
   */
  async calculateEntryPrice(candle, strategy, side) {
    const oc = Math.abs(
      this.candleService.calculateCandleMetrics(candle).oc
    );

    if (side === 'long') {
      return calculateLongEntryPrice(candle.open, oc, strategy.extend);
    } else {
      const overrideExtend = Number(configService.getNumber('SHORT_EXTEND_OVERRIDE', strategy.extend));
      return calculateShortEntryPrice(candle.open, oc, overrideExtend);
    }
  }

  /**
   * Check if extend condition is met
   * For LONG: price must drop below entry
   * For SHORT: price must rise above entry
   * @param {string} side - 'long' or 'short'
   * @param {number} currentPrice - Current market price
   * @param {number} entryPrice - Calculated entry price
   * @param {number} openPrice - Candle open price
   * @returns {boolean}
   */
  checkExtendCondition(side, currentPrice, entryPrice, openPrice) {
    if (side === 'long') {
      // For long: price must drop below entry (entry < open)
      return currentPrice <= entryPrice && entryPrice < openPrice;
    } else {
      // For short: price must rise above entry (entry > open)
      return currentPrice >= entryPrice && entryPrice > openPrice;
    }
  }

  /**
   * Check and send price volatility alert if threshold is met
   * @param {Object} alertConfig - Price alert configuration
   * @param {Object} candleData - Candle and price data
   */
  async checkAndSendPriceAlert(alertConfig, candleData) {
    const { symbol, interval, oc, open, currentPrice, direction } = candleData;

    if (!alertConfig || !this.telegramService) return;

    // Check if OC meets the threshold - CRITICAL FIX
    const absoluteOC = Math.abs(oc);
    if (absoluteOC < alertConfig.threshold) {
      logger.debug(`[Alert] OC ${absoluteOC.toFixed(2)}% below threshold ${alertConfig.threshold}% for ${symbol} ${interval}, skipping alert`);
      return;
    }

    // Guard: skip alerts for symbols not tradable on Binance Futures (when running on Binance)
    try {
      const exSvc = this.exchangeService;
      if (exSvc?.bot?.exchange === 'binance' && exSvc?.binanceDirectClient) {
        const info = await exSvc.binanceDirectClient.getTradingExchangeSymbol(symbol);
        if (!info || info.status !== 'TRADING') {
          logger.debug(`[Alert] Skip non-tradable futures symbol ${symbol} for interval ${interval}`);
          return;
        }
      }
    } catch (e) {
      logger.debug(`[Alert] Tradability check failed for ${symbol}, skipping alert: ${e?.message || e}`);
      return;
    }

    // Send price alert only if threshold is met
    try {
      logger.info(`[Alert] Triggering volatility alert for ${symbol} ${interval} (OC=${oc.toFixed(2)}% >= threshold ${alertConfig.threshold}%)`);
      // Send Telegram alert
      await this.telegramService.sendVolatilityAlert(alertConfig.telegram_chat_id, {
        symbol,
        interval,
        oc,
        open,
        currentPrice,
        direction
      });
      logger.info(`[Alert] ✅ Successfully sent volatility alert for ${symbol} ${interval} to chat ${alertConfig.telegram_chat_id}`);
    } catch (error) {
      logger.error(`[Alert] ❌ Failed to send volatility alert for ${symbol} ${interval}: ${error?.message || error}`);
    }
  }

  /**
   * Check if signal should be ignored based on previous candle
   * 
   * DEPRECATED: This method is no longer used as we don't store candles in database.
   * Realtime detection handles signal generation without database dependency.
   * 
   * @param {Object} currentCandle - Current candle (deprecated)
   * @param {Object} strategy - Strategy object
   * @param {string} side - 'long' or 'short'
   * @param {number} currentPrice - Current market price
   * @returns {Promise<boolean>} True if should ignore
   */
  async shouldIgnoreSignal(currentCandle, strategy, side, currentPrice) {
    // DEPRECATED: No longer using database candles
    // This method is kept for backward compatibility but always returns false
    logger.debug(`[StrategyService] shouldIgnoreSignal() called but deprecated (no database candles)`);
    return false; // Don't ignore signals (realtime detection handles this)
  }
}

