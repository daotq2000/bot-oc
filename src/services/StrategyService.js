import { CandleService } from './CandleService.js';
import {
  calculateLongEntryPrice,
  calculateShortEntryPrice,
  calculateTakeProfit,
  calculateInitialStopLoss,
  calculateIgnoreThreshold
} from '../utils/calculator.js';
import logger from '../utils/logger.js';

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
   * Check for trading signal
   * @param {Object} strategy - Strategy object
   * @returns {Promise<Object|null>} Signal object or null
   */
  /**
   * Check for trading signal and/or price alert
   * @param {Object} strategy - Strategy object
   * @param {Object} alertConfig - Optional price alert configuration
   * @returns {Promise<Object|null>} Signal object or null
   */
  async checkSignal(strategy, alertConfig = null) {
    try {
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
        logger.debug(`Price for ${strategy.symbol} not available in cache, skipping scan.`);
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
      const entryPrice = this.calculateEntryPrice(candle, strategy, side);
      logger.info(`[Signal] Strategy ${strategy.id} (${strategy.symbol}) ${side}: Entry=${entryPrice}, Current=${currentPrice}, Open=${candle.open}, Extend=${strategy.extend}%`);

      // Check if extend condition is met
      const extendMet = this.checkExtendCondition(side, currentPrice, entryPrice, candle.open);
      
      if (!extendMet) {
        logger.info(`[Signal] Strategy ${strategy.id} (${strategy.symbol}) ${side}: Extend condition not met. Current=${currentPrice}, Entry=${entryPrice}, Open=${candle.open}`);
        return null;
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
        oc: Math.abs(oc)
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
  calculateEntryPrice(candle, strategy, side) {
    const oc = Math.abs(
      this.candleService.calculateCandleMetrics(candle).oc
    );

    if (side === 'long') {
      return calculateLongEntryPrice(candle.open, oc, strategy.extend);
    } else {
      return calculateShortEntryPrice(candle.open, oc, strategy.extend);
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
   * Check if signal should be ignored based on previous candle
   * @param {Object} currentCandle - Current candle
   * @param {Object} strategy - Strategy object
   * @param {string} side - 'long' or 'short'
   * @param {number} currentPrice - Current market price
   * @returns {Promise<boolean>} True if should ignore
   */
  /**
   * Check and send price volatility alert if threshold is met
   * @param {Object} alertConfig - Price alert configuration
   * @param {Object} candleData - Candle and price data
   */
  async checkAndSendPriceAlert(alertConfig, candleData) {
    const { symbol, interval, oc, open, currentPrice, direction } = candleData;

    if (!alertConfig || !this.telegramService) return;

    // Check if OC meets the alert threshold
    if (Math.abs(oc) >= alertConfig.threshold) {
      logger.info(`[Alert] ${symbol} ${interval} OC of ${oc.toFixed(2)}% has crossed the threshold of ${alertConfig.threshold}%`);

      // Send Telegram alert
      await this.telegramService.sendVolatilityAlert(alertConfig.telegram_chat_id, {
        symbol,
        interval,
        oc,
        open,
        currentPrice,
        direction
      });

      // Here you might want to add a cooldown mechanism to avoid spamming alerts
      // For now, we'll rely on the job's interval
    }
  }

  async shouldIgnoreSignal(currentCandle, strategy, side, currentPrice) {
    try {
      // Get previous candle
      const previousCandle = await this.candleService.getPreviousCandle(
        strategy.symbol,
        strategy.interval
      );

      if (!previousCandle) {
        return false; // No previous candle, don't ignore
      }

      // Check if previous candle was opposite direction
      const prevDirection = this.candleService.calculateCandleMetrics(previousCandle).direction;
      const currentDirection = this.candleService.calculateCandleMetrics(currentCandle).direction;

      // If previous was same direction, don't ignore
      if (prevDirection === currentDirection) {
        return false;
      }

      // Calculate ignore threshold
      const ignoreThreshold = calculateIgnoreThreshold(
        previousCandle.high,
        previousCandle.low,
        strategy.ignore
      );

      // Check if price has retraced enough
      if (side === 'long') {
        // For long: check if price has dropped enough from previous high
        const retracement = previousCandle.high - currentPrice;
        return retracement < ignoreThreshold;
      } else {
        // For short: check if price has risen enough from previous low
        const retracement = currentPrice - previousCandle.low;
        return retracement < ignoreThreshold;
      }
    } catch (error) {
      logger.error(`Error checking ignore signal:`, error);
      return false; // Don't ignore on error
    }
  }
}

