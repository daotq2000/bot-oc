import { Telegraf } from 'telegraf';
import logger from '../utils/logger.js';
import { configService } from './ConfigService.js';

/**
 * Telegram Service - Send notifications via Telegram
 */
export class TelegramService {
  constructor() {
    this.bot = null;
    this.initialized = false;
    this.alertChannelId = null;

    // Lightweight send queue to avoid blocking and to apply rate-limits
    this._queue = [];
    this._processing = false;
    this._lastSendAt = 0; // global throttle
    this._perChatLastSend = new Map(); // chatId -> ts
    // Default throttles (Telegram 30 msg/sec global, 1 msg/sec per chat is safer)
    this._minGapGlobalMs = 200;   // 5 msgs/sec global
    this._perChatMinGapMs = 1000; // 1 msg/sec per chat to avoid 429
  }

  /**
   * Initialize Telegram bot
   */
  async initialize() {
    try {
      const token = configService.getString('TELEGRAM_BOT_TOKEN');
      if (!token) {
        logger.warn('Telegram bot token not configured');
        return false;
      }

      this.bot = new Telegraf(token);
      this.alertChannelId = configService.getString('TELEGRAM_ALERT_CHANNEL_ID', this.alertChannelId || '-1003163801780');
      this.initialized = true;
      logger.info('Telegram bot initialized');
      return true;
    } catch (error) {
      logger.error('Failed to initialize Telegram bot:', error);
      return false;
    }
  }

  /**
   * Adaptive price formatting for small-priced assets
   */
  formatPriceAdaptive(value) {
    const v = Number(value);
    if (!Number.isFinite(v)) return String(value);
    const abs = Math.abs(v);
    if (abs >= 100) return v.toFixed(2);
    if (abs >= 1) return v.toFixed(4);
    if (abs >= 0.1) return v.toFixed(5);
    if (abs >= 0.01) return v.toFixed(6);
    if (abs >= 0.001) return v.toFixed(7);
    return v.toFixed(8);
  }

  /**
   * Send message to chat
   * @param {string} chatId - Chat ID
   * @param {string} message - Message text
   * @param {Object} options - Additional options
   */
  async sendMessage(chatId, message, options = {}) {
    // Master toggle to enable/disable all alerts from DB config
    const alertsEnabled = configService.getBoolean('ENABLE_ALERTS', true);
    if (!alertsEnabled) {
      logger.debug(`[Telegram] Alerts disabled by config (ENABLE_ALERTS=false), skipping message to ${chatId}`);
      return;
    }

    if (!this.initialized || !this.bot) {
      logger.warn(`[Telegram] Bot not initialized, skipping message to ${chatId}`);
      return;
    }

    if (!chatId) {
      logger.warn(`[Telegram] Chat ID is empty, skipping message`);
      return;
    }

    // Enqueue to avoid blocking and to respect rate limits
    this._queue.push({ chatId, message, options });
    this._processQueue().catch(() => {});
  }

  async _processQueue() {
    if (this._processing) return;
    this._processing = true;
    try {
      while (this._queue.length > 0) {
        const { chatId, message, options } = this._queue.shift();
        // Throttle globally and per-chat
        const now = Date.now();
        const gapGlobal = now - this._lastSendAt;
        const lastPerChat = this._perChatLastSend.get(chatId) || 0;
        const gapPerChat = now - lastPerChat;
        const waitMs = Math.max(0, this._minGapGlobalMs - gapGlobal, this._perChatMinGapMs - gapPerChat);
        if (waitMs > 0) {
          await new Promise(r => setTimeout(r, waitMs));
        }

        try {
          logger.debug(`[Telegram] Sending message to ${chatId}, length=${message.length}`);
          
          // Add timeout for Telegram API call (10 seconds)
          const telegramTimeout = Number(configService.getNumber('TELEGRAM_API_TIMEOUT_MS', 10000));
          const sendPromise = this.bot.telegram.sendMessage(chatId, message, {
            parse_mode: 'HTML',
            ...options
          });
          
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Telegram API timeout after ${telegramTimeout}ms`)), telegramTimeout)
          );
          
          await Promise.race([sendPromise, timeoutPromise]);
          
          this._lastSendAt = Date.now();
          this._perChatLastSend.set(chatId, this._lastSendAt);
          logger.info(`[Telegram] ✅ Successfully sent message to ${chatId}`);
        } catch (error) {
          const msg = error?.message || '';
          const retryAfter = Number(error?.response?.parameters?.retry_after || error?.parameters?.retry_after || NaN);
          const transient = /429|retry|timeout|network|ECONNRESET|ETIMEDOUT|socket hang/i.test(msg);

          if (transient) {
            // Respect Telegram retry_after when present
            const backoffMs = Number.isFinite(retryAfter) ? (retryAfter * 1000) : 2000; // Increased default backoff to 2s
            logger.warn(`[Telegram] Throttled or transient error, backing off ${backoffMs}ms before retry. chatId=${chatId}, msg=${msg}`);
            this._queue.unshift({ chatId, message, options }); // requeue
            await new Promise(r => setTimeout(r, backoffMs));
          } else {
            logger.error(`[Telegram] Failed to send message to ${chatId}:`, msg, error?.stack);
          }
        }
      }
    } finally {
      this._processing = false;
    }
  }

  /**
   * Send order notification
   * @param {Object} position - Position object
   * @param {Object} strategy - Strategy object
   */
  async sendOrderNotification(position, strategy) {
    if (!position || !strategy) {
      logger.warn(`[OrderNotification] Missing position or strategy, skipping notification`);
      return;
    }

    // Try to get bot info from strategy, or load it if missing
    let bot = strategy.bot || {};
    if (!bot.telegram_chat_id && strategy.bot_id) {
      try {
        const { Bot } = await import('../models/Bot.js');
        bot = await Bot.findById(strategy.bot_id) || bot;
      } catch (e) {
        logger.warn(`[OrderNotification] Failed to load bot ${strategy.bot_id}:`, e?.message || e);
      }
    }

    const chatId = bot.telegram_chat_id;
    if (!chatId) {
      logger.warn(`[OrderNotification] No telegram_chat_id for bot ${bot.id || strategy.bot_id}, skipping notification for position ${position.id}`);
      return;
    }

    const sideEmoji = position.side === 'long' ? '🟢' : '🔴';
    const sideText = position.side.toUpperCase();

    const message = `
${sideEmoji} <b>NEW ${sideText} POSITION</b>

Symbol: <b>${position.symbol}</b>
Entry: <b>${this.formatPriceAdaptive(position.entry_price)}</b>
TP: <b>${this.formatPriceAdaptive(position.take_profit_price)}</b> (+${this.calculatePercent(position.entry_price, position.take_profit_price, position.side).toFixed(2)}%)
SL: <b>${this.formatPriceAdaptive(position.stop_loss_price)}</b> (-${this.calculatePercent(position.entry_price, position.stop_loss_price, position.side).toFixed(2)}%)
Amount: <b>${parseFloat(position.amount).toFixed(2)}</b>

Bot: ${bot.bot_name || 'N/A'}
Strategy: ${strategy.interval} | OC: ${strategy.oc}%
    `.trim();

    await this.sendMessage(chatId, message);
  }

  /**
   * Helpers for formatted channel messages
   */
  formatSymbolUnderscore(symbol) {
    if (!symbol) return symbol;
    const s = symbol.toUpperCase();
    if (s.endsWith('USDT')) return s.replace(/USDT$/, '_USDT');
    if (s.includes('/')) return s.replace('/', '_');
    return s;
  }

  formatIntervalLabel(interval) {
    if (!interval) return '';
    const m = interval.match(/^(\d+)m$/i);
    if (m) return `Min${m[1]}`;
    const h = interval.match(/^(\d+)h$/i);
    if (h) return `Hour${h[1]}`;
    return interval;
  }

  async sendEntryTradeAlert(position, strategy, oc) {
    try {
      if (!this.initialized || !this.bot) {
        logger.warn(`[Entry Alert] Telegram bot not initialized, skipping alert for position ${position?.id}`);
        return;
      }

      const channelId = (strategy?.bot?.telegram_alert_channel_id) || this.alertChannelId;
      if (!channelId) {
        logger.warn(`[Entry Alert] Alert channel ID not configured, skipping alert for position ${position?.id}`);
        return;
      }

      const botName = (strategy?.bot?.bot_name) || 'N/A';
      const symbol = this.formatSymbolUnderscore(position.symbol);
      const side = position.side === 'long' ? 'Long' : 'Short';
      const intervalLabel = this.formatIntervalLabel(strategy.interval);
      const ocStr = (Number(oc || strategy.oc || 0)).toFixed(1);
      const extendStr = (Number(strategy.extend || 0)).toFixed(0);
      const tpStr = (Number(strategy.take_profit || 0)).toFixed(0);
      const openPrice = this.formatPriceAdaptive(position.entry_price);
      const amountStr = Number(position.amount).toFixed(2);

      const msg = `
🚀 ${symbol} | ${side}
Bot: ${botName}
${intervalLabel} | OC: ${ocStr}% | Extend: ${extendStr}% | TP: ${tpStr}%
Status: Completed
Open price: ${openPrice}
Amount: ${amountStr} (100%)`.trim();

      logger.info(`[Entry Alert] Sending entry trade alert for position ${position.id} (${symbol}) to channel ${channelId}`);
      await this.sendMessage(channelId, msg);
      logger.info(`[Entry Alert] ✅ Successfully sent entry trade alert for position ${position.id} (${symbol})`);
    } catch (e) {
      logger.error(`[Entry Alert] Failed to send entry trade alert for position ${position?.id}:`, e);
      logger.error(`[Entry Alert] Error stack:`, e?.stack);
    }
  }

  async sendCloseSummaryAlert(position, stats) {
    try {
      if (!position) {
        logger.warn(`[CloseSummaryAlert] Missing position, skipping notification`);
        return;
      }

      // Try to get channel ID from position, or use default alert channel
      let channelId = position?.telegram_alert_channel_id;
      
      // If no alert channel, try telegram_chat_id from bot
      if (!channelId && position?.telegram_chat_id) {
        channelId = position.telegram_chat_id;
      }
      
      // Fall back to default alert channel
      if (!channelId) {
        channelId = this.alertChannelId;
      }
      
      if (!channelId) {
        logger.warn(`[CloseSummaryAlert] No channel ID available for position ${position.id}, skipping notification`);
        logger.warn(`[CloseSummaryAlert] position.telegram_alert_channel_id: ${position?.telegram_alert_channel_id || 'NULL'}`);
        logger.warn(`[CloseSummaryAlert] position.telegram_chat_id: ${position?.telegram_chat_id || 'NULL'}`);
        logger.warn(`[CloseSummaryAlert] this.alertChannelId: ${this.alertChannelId || 'NULL'}`);
        return;
      }

      logger.info(`[CloseSummaryAlert] Sending alert for position ${position.id} to channel ${channelId}`);

      const symbol = this.formatSymbolUnderscore(position.symbol);
      const isWin = (position.close_reason === 'tp_hit');
      const sideTitle = position.side === 'long' ? 'Long' : 'Short';
      const title = `🏆 ${symbol} | ${sideTitle} ${isWin ? 'WIN' : 'LOSE'}`;

      const wins = Number(stats?.wins || 0);
      const loses = Number(stats?.loses || 0);
      const totalPnl = Number(stats?.total_pnl || 0);

      const botName = position.bot_name || 'N/A';
      const intervalLabel = this.formatIntervalLabel(position.interval);
      const ocStr = Number(position.oc || 0).toFixed(2);
      const extendStr = Number(position.extend || 0).toFixed(0);
      const tpStr = Number(position.take_profit || 0).toFixed(0);
      const reduceStr = Number(position.reduce || 0).toFixed(0);
      const upReduceStr = Number(position.up_reduce || 0).toFixed(0);

      const closePrice = this.formatPriceAdaptive(position.close_price);
      const amountStr = Number(position.amount).toFixed(2);

      const pnlVal = Number(position.pnl || 0);
      const pnlPct = this.calculatePercent(position.entry_price, position.close_price, position.side);
      
      const pnlLine = `${pnlVal >= 0 ? '' : ''}${pnlVal.toFixed(2)}$ ~ ${pnlPct >= 0 ? '' : ''}${pnlPct.toFixed(2)}% (before fees)`;

      const msg = `
${title}
${wins} WIN, ${loses} LOSE | Total PNL: ${totalPnl.toFixed(2)}$
Bot: ${botName}
Strategy: ${intervalLabel} | OC: ${ocStr}% | Extend: ${extendStr}% | TP: ${tpStr}% | Reduce: ${reduceStr}% | Up Reduce: ${upReduceStr}%
Close price: ${closePrice}$
Amount: ${amountStr}
💰 PNL: ${pnlLine}`.trim();

      await this.sendMessage(channelId, msg);
      logger.info(`[CloseSummaryAlert] ✅ Successfully sent alert for position ${position.id}`);
    } catch (e) {
      logger.error(`[CloseSummaryAlert] ❌ Failed to send close summary alert for position ${position?.id || 'unknown'}:`, e?.message || e, e?.stack);
    }
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
Entry: <b>${this.formatPriceAdaptive(position.entry_price)}</b>
Close: <b>${this.formatPriceAdaptive(position.close_price)}</b>
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
   * Send price volatility alert with compact format
   * Format: ┌🚀🚀🚀 SVSA ⚡️ 10.50% 🟢
   *         └ 0.003788 → 0.004186
   * @param {string} chatId - Chat ID
   * @param {Object} alertData - Alert data
   */
//   async sendVolatilityAlert(chatId, alertData) {
//     if (!chatId) return;

//     const {
//       symbol,
//       oc,
//       open,
//       currentPrice,
//       direction
//     } = alertData;

//     const directionEmoji = direction === 'bullish' ? '🟢' : '🔴';
//     const rockets = Math.abs(oc) >= 10 ? '🚀'.repeat(Math.min(Math.floor(Math.abs(oc) / 10), 5)) : '';
//     const ocSign = oc >= 0 ? '+' : '';

//     // Format prices to remove trailing zeros
//     const formatPrice = (price) => {
//       const num = parseFloat(price);
//       return num.toString();
//     };

//     // Remove USDT suffix for cleaner display
//     const symbolDisplay = symbol.replace('USDT', '');

//     const message = `
// ┌${rockets} ${symbolDisplay} ⚡️ ${ocSign}${oc.toFixed(2)}% ${directionEmoji}
// └ ${formatPrice(open)} → ${formatPrice(currentPrice)}
//     `.trim();

//     await this.sendMessage(chatId, message);
//   }

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
   * Send price volatility alert (compact format)
   * Format:
   * ┌🚀🚀🚀 SVSA ⚡️ 10.50% 🟢
   * └ 0.003788 → 0.004186
   */
  async sendVolatilityAlert(chatId, alertData) {
    if (!chatId) {
      logger.warn(`[VolatilityAlert] Chat ID is empty, skipping alert`);
      return;
    }

    // Check master ENABLE_ALERTS switch
    const alertsEnabled = configService.getBoolean('ENABLE_ALERTS', true);
    if (!alertsEnabled) {
      logger.debug(`[VolatilityAlert] Alerts disabled by ENABLE_ALERTS config, skipping alert to ${chatId}`);
      return;
    }

    if (!this.initialized || !this.bot) {
      logger.warn(`[VolatilityAlert] Telegram bot not initialized, skipping alert to ${chatId}`);
      return;
    }

    const { oc, open, currentPrice, direction, interval, symbol } = alertData;
    
    if (!symbol || oc === undefined || open === undefined || currentPrice === undefined) {
      logger.warn(`[VolatilityAlert] Missing required alert data: symbol=${symbol}, oc=${oc}, open=${open}, currentPrice=${currentPrice}`);
      return;
    }

    const directionEmoji = direction === 'bullish' ? '🟢' : '🔴';

    // 1 rocket per 10% absolute OC
    const rocketCount = Math.floor(Math.abs(oc) / 10);
    const rockets = rocketCount > 0 ? '🚀'.repeat(rocketCount) : '';

    // Absolute OC with two decimals
    const ocAbs = Math.abs(oc).toFixed(2);

    // Interval label (emoji if available)
    const intervalLabel = typeof this.getIntervalEmoji === 'function'
      ? this.getIntervalEmoji(interval)
      : (interval || '');

    // Price formatting: up to 8 decimals, trim trailing zeros
    const formatPrice = (p) => {
      const n = Number(p);
      if (!Number.isFinite(n)) return String(p);
      let s = n.toFixed(8);
      s = s.replace(/\.0+$/, '');
      s = s.replace(/(\.\d*?[1-9])0+$/, '$1');
      return s;
    };

    // Format symbol for display (remove USDT suffix)
    const symbolDisplay = symbol ? symbol.replace(/USDT$/, '') : 'N/A';

    const message = `
┌${rockets} ${symbolDisplay} ${intervalLabel} ⚡️ ${ocAbs}% ${directionEmoji}
└ ${formatPrice(open)} → ${formatPrice(currentPrice)}
    `.trim();

    logger.info(`[VolatilityAlert] Queuing alert to ${chatId}: ${symbol} ${intervalLabel} ${ocAbs}% ${directionEmoji}`);
    
    // sendMessage is queue-based, so we queue it and let the queue processor handle it
    // The actual send status will be logged by _processQueue
    try {
      await this.sendMessage(chatId, message);
      // Note: sendMessage returns immediately after queuing, actual send happens in _processQueue
      // We log "queued" here, and "sent successfully" is logged in _processQueue
      logger.debug(`[VolatilityAlert] Alert queued for ${chatId}: ${symbol} ${intervalLabel} ${ocAbs}% ${directionEmoji}`);
    } catch (error) {
      logger.error(`[VolatilityAlert] Failed to queue alert to ${chatId}:`, error?.message || error);
      throw error;
    }
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

  /**
   * Send concurrency limit alert (trade rejected due to max concurrent trades limit)
   * @param {Object} strategy - Strategy object
   * @param {Object} status - Concurrency status (deprecated - ConcurrencyManager removed)
   */
  async sendConcurrencyLimitAlert(strategy, status) {
    try {
      if (!this.initialized || !this.bot) {
        logger.warn(`[ConcurrencyAlert] Telegram bot not initialized`);
        return;
      }

      let bot = strategy.bot || {};
      let chatId = bot.telegram_alert_channel_id || bot.telegram_chat_id || this.alertChannelId;

      if (!chatId) {
        // Attempt to fetch bot info if missing
        try {
          const { Bot } = await import('../models/Bot.js');
          const full = await Bot.findById(strategy.bot_id);
          bot = full || bot;
          chatId = bot?.telegram_alert_channel_id || bot?.telegram_chat_id || this.alertChannelId;
        } catch (_) {}
      }

      if (!chatId) {
        logger.debug(`[ConcurrencyAlert] No alert/chat ID for bot ${bot?.id || strategy.bot_id}, skipping alert`);
        return;
      }

      const utilizationPercent = status.utilizationPercent || 0;
      const utilizationBar = this.createProgressBar(utilizationPercent);

      const message = `
⚠️ <b>TRADE REJECTED - MAX CONCURRENT LIMIT</b>

Symbol: <b>${strategy.symbol}</b>
Strategy: <b>${strategy.interval}</b> (OC: ${strategy.oc}%)
Bot: <b>${bot.bot_name || 'N/A'}</b>

Current Positions: <b>${status.currentCount}/${status.maxConcurrent}</b>
Utilization: ${utilizationBar} <b>${utilizationPercent}%</b>

<i>Signal detected but trade rejected to maintain concurrency limit.</i>
      `.trim();

      logger.info(`[ConcurrencyAlert] Sending concurrency limit alert for strategy ${strategy.id} (${strategy.symbol})`);
      await this.sendMessage(chatId, message);
      logger.info(`[ConcurrencyAlert] ✅ Successfully sent concurrency limit alert`);
    } catch (e) {
      logger.error(`[ConcurrencyAlert] Failed to send concurrency limit alert:`, e);
    }
  }

  /**
   * Create a simple progress bar for visualization
   * @param {number} percent - Percentage (0-100)
   * @returns {string} Progress bar string
   */
  createProgressBar(percent) {
    const filled = Math.round(percent / 10);
    const empty = 10 - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    return bar;
  }
}

