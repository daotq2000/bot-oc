import { Telegraf } from 'telegraf';
import logger from '../utils/logger.js';

/**
 * Telegram Service - Send notifications via Telegram
 */
export class TelegramService {
  constructor() {
    this.bot = null;
    this.initialized = false;
  }

  /**
   * Initialize Telegram bot
   */
  async initialize() {
    try {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        logger.warn('Telegram bot token not configured');
        return false;
      }

      this.bot = new Telegraf(token);
      this.initialized = true;
      logger.info('Telegram bot initialized');
      return true;
    } catch (error) {
      logger.error('Failed to initialize Telegram bot:', error);
      return false;
    }
  }

  /**
   * Send message to chat
   * @param {string} chatId - Chat ID
   * @param {string} message - Message text
   * @param {Object} options - Additional options
   */
  async sendMessage(chatId, message, options = {}) {
    if (!this.initialized || !this.bot) {
      logger.warn('Telegram bot not initialized, skipping message');
      return;
    }

    try {
      await this.bot.telegram.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        ...options
      });
    } catch (error) {
      logger.error(`Failed to send Telegram message to ${chatId}:`, error);
    }
  }

  /**
   * Send order notification
   * @param {Object} position - Position object
   * @param {Object} strategy - Strategy object
   */
  async sendOrderNotification(position, strategy) {
    if (!position || !strategy) return;

    const bot = strategy.bot || {};
    const chatId = bot.telegram_chat_id;
    if (!chatId) return;

    const sideEmoji = position.side === 'long' ? '🟢' : '🔴';
    const sideText = position.side.toUpperCase();

    const message = `
${sideEmoji} <b>NEW ${sideText} POSITION</b>

Symbol: <b>${position.symbol}</b>
Entry: <b>$${parseFloat(position.entry_price).toFixed(2)}</b>
TP: <b>$${parseFloat(position.take_profit_price).toFixed(2)}</b> (+${this.calculatePercent(position.entry_price, position.take_profit_price, position.side).toFixed(2)}%)
SL: <b>$${parseFloat(position.stop_loss_price).toFixed(2)}</b> (-${this.calculatePercent(position.entry_price, position.stop_loss_price, position.side).toFixed(2)}%)
Amount: <b>$${parseFloat(position.amount).toFixed(2)}</b>

Bot: ${bot.bot_name || 'N/A'}
Strategy: ${strategy.interval} | OC: ${strategy.oc}%
    `.trim();

    await this.sendMessage(chatId, message);
  }

  /**
   * Send close notification
   * @param {Object} position - Closed position object
   * @param {Object} originalPosition - Original position (for comparison)
   */
  async sendCloseNotification(position, originalPosition = null) {
    if (!position) return;

    // Get bot from strategy if available
    const chatId = position.telegram_chat_id || originalPosition?.telegram_chat_id;
    if (!chatId) return;

    const pnl = parseFloat(position.pnl || 0);
    const pnlPercent = this.calculatePercent(
      position.entry_price,
      position.close_price,
      position.side
    );
    const pnlEmoji = pnl >= 0 ? '✅' : '❌';
    const pnlSign = pnl >= 0 ? '+' : '';

    const message = `
${pnlEmoji} <b>POSITION CLOSED</b>

Symbol: <b>${position.symbol}</b>
Side: <b>${position.side.toUpperCase()}</b>
Entry: <b>$${parseFloat(position.entry_price).toFixed(2)}</b>
Close: <b>$${parseFloat(position.close_price).toFixed(2)}</b>
PnL: <b>${pnlSign}$${pnl.toFixed(2)}</b> (${pnlSign}${pnlPercent.toFixed(2)}%)
Reason: <b>${this.formatCloseReason(position.close_reason)}</b>
    `.trim();

    await this.sendMessage(chatId, message);
  }

  /**
   * Send error notification
   * @param {Object} bot - Bot object
   * @param {Error} error - Error object
   */
  async sendErrorNotification(bot, error) {
    const chatId = bot.telegram_chat_id;
    if (!chatId) return;

    // Skip notifications for Gate testnet server errors (known issue)
    if (bot.exchange === 'gate') {
      const errorMsg = error.message || '';
      if (errorMsg.includes('SERVER_ERROR') || 
          errorMsg.includes('Internal server error') ||
          errorMsg.includes('INVALID_PARAM_VALUE')) {
        logger.debug(`Skipping Telegram notification for Gate testnet error: ${errorMsg}`);
        return;
      }
    }

    const message = `
⚠️ <b>ERROR</b>

Bot: <b>${bot.bot_name || 'N/A'}</b>
Error: <code>${error.message || 'Unknown error'}</code>
Time: ${new Date().toLocaleString()}
    `.trim();

    await this.sendMessage(chatId, message);
  }

  /**
   * Send balance update notification
   * @param {Object} bot - Bot object
   * @param {string} type - Update type
   * @param {number} amount - Amount
   */
  async sendBalanceUpdate(bot, type, amount) {
    const chatId = bot.telegram_chat_id;
    if (!chatId) return;

    const typeLabels = {
      'spot_to_future': 'Spot → Futures',
      'future_to_spot': 'Futures → Spot',
      'withdraw': 'Withdrawal'
    };

    const emoji = type === 'withdraw' ? '💸' : '💱';

    const message = `
${emoji} <b>BALANCE UPDATE</b>

Bot: <b>${bot.bot_name || 'N/A'}</b>
Type: <b>${typeLabels[type] || type}</b>
Amount: <b>$${parseFloat(amount).toFixed(2)}</b>
    `.trim();

    await this.sendMessage(chatId, message);
  }

  /**
   * Calculate percentage difference
   * @param {number} entry - Entry price
   * @param {number} exit - Exit price
   * @param {string} side - Position side
   * @returns {number} Percentage
   */
  calculatePercent(entry, exit, side) {
    if (side === 'long') {
      return ((exit - entry) / entry) * 100;
    } else {
      return ((entry - exit) / entry) * 100;
    }
  }

  /**
   * Format close reason
   * @param {string} reason - Close reason
   * @returns {string} Formatted reason
   */
  formatCloseReason(reason) {
    const reasons = {
      'tp_hit': 'Take Profit',
      'sl_hit': 'Stop Loss',
      'manual': 'Manual Close',
      'candle_end': 'Candle End'
    };
    return reasons[reason] || reason;
  }

  /**
   * Send price volatility alert with the new compact format
   * @param {string} chatId - Chat ID
   * @param {Object} alertData - Alert data
   */
  async sendVolatilityAlert(chatId, alertData) {
    if (!chatId) return;

    const {
      symbol,
      interval,
      oc,
      open,
      currentPrice,
      direction
    } = alertData;

    const intervalEmoji = this.getIntervalEmoji(interval);
    const directionEmoji = direction === 'bullish' ? '🟢' : '🔴';
    const rockets = Math.abs(oc) >= 10 ? '🚀'.repeat(Math.min(Math.floor(Math.abs(oc) / 10), 5)) : '';

    // Format time as HH:MM:SS AM/PM
    const timeStr = new Date().toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });

    // Format prices to remove trailing zeros
    const formatPrice = (price) => parseFloat(price.toFixed(8)).toString();

    const message = `
📈 ${symbol.replace('USDT', '_USDT')} ${intervalEmoji} ${oc.toFixed(2)}% ${directionEmoji} ${rockets}
┌ ${formatPrice(open)} → ${formatPrice(currentPrice)} ${timeStr}
    `.trim();

    await this.sendMessage(chatId, message);
  }

  /**
   * Get interval emoji representation
   * @param {string} interval - Time interval
   * @returns {string} Emoji representation
   */
  getIntervalEmoji(interval) {
    const map = {
      '1m': '1️⃣',
      '3m': '3️⃣',
      '5m': '5️⃣',
      '15m': '1️⃣5️⃣',
      '30m': '3️⃣0️⃣',
      '1h': '1️⃣h'
    };
    return map[interval] || interval;
  }





  /**
   * Send price volatility alert
   * @param {string} chatId - Chat ID
   * @param {Object} alertData - Alert data
   */
  async sendVolatilityAlert(chatId, alertData) {
    if (!chatId) return;

    const {
      symbol,
      interval,
      oc,
      open,
      currentPrice,
      direction
    } = alertData;

    const intervalEmoji = this.getIntervalEmoji(interval);
    const directionEmoji = direction === 'bullish' ? '🟢' : '🔴';
    const rockets = Math.abs(oc) >= 10 ? '🚀'.repeat(Math.min(Math.floor(Math.abs(oc) / 10), 5)) : '';

    const message = `
📈 <b>Price Alert</b> ${rockets}

Symbol: <b>${symbol}</b>
Interval: <b>${intervalEmoji}</b>
OC: <b>${oc.toFixed(2)}%</b> ${directionEmoji}

Open: ${open}
Price: ${currentPrice}
    `.trim();

    await this.sendMessage(chatId, message);
  }

  /**
   * Get interval emoji representation
   * @param {string} interval - Time interval (1m, 5m, 15m, 30m)
   * @returns {string} Emoji representation
   */
  getIntervalEmoji(interval) {
    const map = {
      '1m': '1️⃣',
      '3m': '3️⃣',
      '5m': '5️⃣',
      '15m': '1️⃣5️⃣',
      '30m': '3️⃣0️⃣',
      '1h': '1️⃣h'
    };
    return map[interval] || interval;
  }
}

