import { Telegraf } from 'telegraf';
import logger from '../utils/logger.js';
import { configService } from './ConfigService.js';

/**
 * Telegram Service - Send notifications via Telegram
 */
export class TelegramService {
  constructor() {
    // Separate clients for different alert types
    this.clients = new Map(); // alertType -> { bot: Telegraf, chatId: string }
    this.initialized = false;

    // Queues and rate-limiting per client
    this._queues = new Map(); // alertType -> queue[]
    this._processing = new Map(); // alertType -> boolean
    this._lastSendAt = new Map(); // alertType -> timestamp
    this._perChatLastSend = new Map(); // chatId -> ts (shared across all bots)
    this._minGapGlobalMs = 1000;   // 1 msgs/sec global per bot (more conservative)
    this._perChatMinGapMs = 3000; // 1 msg/3sec per chat (Telegram recommends max 20 msg/min per chat)
    
    // Global backoff tracking for 429 errors
    this._globalBackoffUntil = new Map(); // alertType -> timestamp when backoff ends
    this._consecutiveErrors = new Map(); // alertType -> count of consecutive 429 errors

    // TTL and cleanup for memory leak prevention
    this._queueLastAccess = new Map(); // alertType -> timestamp
    this._chatLastAccess = new Map(); // chatId -> timestamp
    this._batches = new Map(); // exchange -> { messages: [], timer: Timeout }
    this._cleanupInterval = null;
    this._cleanupEveryMs = 5 * 60 * 1000;
    this._queueMaxIdleMs = 30 * 60 * 1000;
    this._chatMaxIdleMs = 6 * 60 * 60 * 1000;
    this._lastCleanupAt = 0;
  }

  /**
   * Initialize Telegram bots for all alert types
   */
  async initialize() {
    try {
      // 1. Order Service Alerts
      const orderToken = configService.getString('TELEGRAM_BOT_TOKEN');
      if (orderToken) {
        this.clients.set('order', {
          bot: new Telegraf(orderToken),
          chatId: '-1003163801780'
        });
        logger.info('Telegram client initialized for Order Service alerts');
      } else {
        logger.warn('TELEGRAM_BOT_TOKEN for Order Service not configured');
      }

      // 2. MEXC Price Alerts
      const mexcPriceToken = configService.getString('TELEGRAM_BOT_TOKEN_SEND_ALERT_MEXC');
      if (mexcPriceToken) {
        this.clients.set('price_mexc', {
          bot: new Telegraf(mexcPriceToken),
          chatId: '-1003052914854'
        });
        logger.info('Telegram client initialized for MEXC Price alerts');
      } else {
        logger.warn('TELEGRAM_BOT_TOKEN_SEND_ALERT_MEXC not configured');
      }

      // 3. Binance Price Alerts
      const binancePriceToken = configService.getString('TELEGRAM_BOT_TOKEN_SEND_ALERT_BINANCE');
      if (binancePriceToken) {
        this.clients.set('price_binance', {
          bot: new Telegraf(binancePriceToken),
          chatId: '-1003009070677'
        });
        logger.info('Telegram client initialized for Binance Price alerts');
      } else {
        logger.warn('TELEGRAM_BOT_TOKEN_SEND_ALERT_BINANCE not configured');
      }

      // 4. Position Monitor PnL Alerts (Binance)
      const pmBinanceToken = configService.getString('TELEGRAM_BOT_TOKEN_POSITION_MONITOR_BINANCE');
      const pmBinanceChat = configService.getString('TELEGRAM_BOT_TOKEN_POSITION_MONITOR_BINANCE_CHANEL');
      if (pmBinanceToken && pmBinanceChat) {
        this.clients.set('position_monitor_binance', {
          bot: new Telegraf(pmBinanceToken),
          chatId: pmBinanceChat
        });
        logger.info('Telegram client initialized for Position Monitor Binance alerts');
      } else {
        logger.warn('Position Monitor Binance Telegram token/chat not configured');
      }

      if (this.clients.size === 0) {
        logger.error('No Telegram clients could be initialized. Alerts will not be sent.');
        return false;
      }

      this.initialized = true;
      
      // Start periodic cleanup to prevent memory leaks
      this._startCleanupTimer();
      
      logger.info(`Telegram clients initialized for ${this.clients.size} modules`);
      return true;
    } catch (error) {
      logger.error('Failed to initialize Telegram bots', { err: error?.message, stack: error?.stack });
      return false;
    }
  }

  /**
   * Get bot instance for exchange
   * @param {string} exchange - Exchange name (mexc, binance, or null for default)
   * @returns {Telegraf|null} Bot instance or null
   */
  _getBot(alertType) {
    // Resolve client by alertType; fallback order -> price_binance -> price_mexc
    // (fallback is defensive, but callers should pass correct alertType)
    return this.clients.get(alertType)?.bot ||
      this.clients.get('order')?.bot ||
      this.clients.get('price_binance')?.bot ||
      this.clients.get('price_mexc')?.bot ||
      null;
  }

  /**
   * Start periodic cleanup timer to prevent memory leaks
   */
  _startCleanupTimer() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
    }
    
    this._cleanupInterval = setInterval(() => {
      this._cleanupMaps().catch(err => {
        logger.error(`[TelegramService] Cleanup error:`, err?.message || err);
      });
    }, this._cleanupEveryMs);
    
    logger.info(`[TelegramService] Started cleanup timer (every ${this._cleanupEveryMs}ms)`);
  }

  /**
   * Stop cleanup timer (for graceful shutdown)
   */
  _stopCleanupTimer() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
      logger.info(`[TelegramService] Stopped cleanup timer`);
    }
  }

  /**
   * Cleanup old entries from Maps to prevent memory leaks
   */
  async _cleanupMaps() {
    const now = Date.now();
    
    // Skip if cleanup ran recently (within 1 minute)
    if (now - this._lastCleanupAt < 60000) {
      return;
    }
    
    this._lastCleanupAt = now;
    let cleaned = 0;

    // Cleanup empty queues and idle queues
    if (this._queues && this._queues.entries) {
      for (const [exchange, queue] of this._queues.entries()) {
        const lastAccess = this._queueLastAccess.get(exchange) || 0;
        
        // Remove queue if empty and not accessed for maxIdleMs
        if (queue.length === 0 && (now - lastAccess) > this._queueMaxIdleMs) {
          this._queues.delete(exchange);
          this._processing.delete(exchange);
          this._lastSendAt.delete(exchange);
          this._queueLastAccess.delete(exchange);
          if (this._batches) {
            this._batches.delete(exchange);
          }
          cleaned++;
          logger.debug(`[TelegramService] Cleaned up idle queue for exchange: ${exchange}`);
        }
      }
    }

    // Cleanup per-chat tracking for inactive chats
    if (this._chatLastAccess && this._chatLastAccess.entries) {
      for (const [chatId, lastAccess] of this._chatLastAccess.entries()) {
        if ((now - lastAccess) > this._chatMaxIdleMs) {
          this._perChatLastSend.delete(chatId);
          this._chatLastAccess.delete(chatId);
          cleaned++;
        }
      }
    }

    // Cleanup batches that are stale
    if (this._batches && this._batches.entries) {
      for (const [exchange, batch] of this._batches.entries()) {
        if (batch && batch.timer && batch.messages && batch.messages.length === 0) {
          // Clear timer if batch is empty
          clearTimeout(batch.timer);
          this._batches.delete(exchange);
          cleaned++;
        }
      }
    }

    if (cleaned > 0) {
      logger.debug(`[TelegramService] Cleanup completed: removed ${cleaned} idle entries. ` +
        `Queues: ${this._queues.size}, Chats: ${this._perChatLastSend.size}, Batches: ${this._batches.size}`);
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
   * @param {Object} options - Additional options (can include exchange)
   */
  async sendMessage(chatId, message, options = {}) {
    // Master toggle to enable/disable all alerts from DB config
    const alertsEnabled = configService.getBoolean('ENABLE_ALERTS', true);
    if (!alertsEnabled) {
      logger.debug(`[Telegram] Alerts disabled by config (ENABLE_ALERTS=false), skipping message to ${chatId}`);
      return;
    }

    if (!this.initialized || this.clients.size === 0) {
      logger.warn(`[Telegram] Bot not initialized, skipping message to ${chatId}`);
      return;
    }

    if (!chatId) {
      logger.warn(`[Telegram] Chat ID is empty, skipping message`);
      return;
    }

    // Guard: message must be a string to avoid "Cannot read properties of undefined (reading 'length')" in queue processor
    const safeMessage = message != null ? String(message) : '';
    if (safeMessage === '' && message !== '') {
      logger.warn(`[Telegram] Message is empty or invalid for chatId=${chatId}, skipping`);
      return;
    }

    // Determine which telegram client to use.
    // Supported: order, price_mexc, price_binance
    const alertType = (options?.alertType || '').toLowerCase() || 'order';

    // Get or create queue for this alert type
    if (!this._queues.has(alertType)) {
      this._queues.set(alertType, []);
    }
    
    // Update last access time for cleanup tracking
    this._queueLastAccess.set(alertType, Date.now());
    this._chatLastAccess.set(chatId, Date.now());

    // Enqueue to avoid blocking and to respect rate limits (use safeMessage so processor never sees undefined)
    this._queues.get(alertType).push({ chatId, message: safeMessage, options });
    logger.debug(`[Telegram] Queued message for alertType=${alertType}, queue.length=${this._queues.get(alertType).length}`);
    this._processQueue(alertType).catch((err) => {
      logger.error(`[Telegram] Error processing queue for alertType=${alertType}:`, err?.message || err);
    });
  }

  async _processQueue(alertType = 'order') {
    // Normalize alertType
    const queueKey = (alertType || '').toLowerCase() || 'order';
    
    if (this._processing.get(queueKey)) {
      logger.debug(`[Telegram] Queue ${queueKey} is already being processed, skipping`);
      return;
    }
    
    this._processing.set(queueKey, true);
    logger.debug(`[Telegram] Starting queue processing for alertType=${alertType} (queueKey=${queueKey})`);
    
    const queue = this._queues.get(queueKey) || [];
    logger.debug(`[Telegram] Queue ${queueKey} has ${queue.length} messages`);
    
    const bot = this._getBot(alertType);
    
    if (!bot) {
      logger.error(`[Telegram] ❌ No bot available for alertType ${alertType || 'order'} (queueKey=${queueKey}), skipping queue processing. Available clients: ${Array.from(this.clients.keys()).join(', ')}`);
      this._processing.set(queueKey, false);
      return;
    }
    
    logger.debug(`[Telegram] Using bot for alertType=${alertType} (queueKey=${queueKey})`);
    
    try {
      while (queue.length > 0) {
        const item = queue.shift();
        const chatId = item?.chatId;
        const message = item?.message != null ? String(item.message) : '';
        const options = item?.options || {};
        if (!message) {
          logger.warn(`[Telegram] Skipping queued item with empty message for chatId=${chatId}`);
          continue;
        }
        
        // Check global backoff first (from previous 429 errors)
        const now = Date.now();
        const backoffUntil = this._globalBackoffUntil.get(queueKey) || 0;
        if (now < backoffUntil) {
          const waitForBackoff = backoffUntil - now;
          logger.info(`[Telegram] Global backoff active for ${queueKey}, waiting ${waitForBackoff}ms before processing. Queue size: ${queue.length + 1}`);
          queue.unshift({ chatId, message, options }); // Put item back
          await new Promise(r => setTimeout(r, waitForBackoff));
          continue;
        }
        
        // Throttle globally (per exchange) and per-chat
        const lastSendAt = this._lastSendAt.get(queueKey) || 0;
        const gapGlobal = now - lastSendAt;
        const lastPerChat = this._perChatLastSend.get(chatId) || 0;
        const gapPerChat = now - lastPerChat;
        const waitMs = Math.max(0, this._minGapGlobalMs - gapGlobal, this._perChatMinGapMs - gapPerChat);
        if (waitMs > 0) {
          await new Promise(r => setTimeout(r, waitMs));
        }

        try {
          logger.debug(`[Telegram] Sending message to ${chatId} (alertType=${alertType || 'order'}), length=${message.length}`);
          
          // Add timeout for Telegram API call (10 seconds)
          const telegramTimeout = Number(configService.getNumber('TELEGRAM_API_TIMEOUT_MS', 10000));
          // Do not forward internal routing options to Telegram API
          const { alertType: _at, exchange: _ex, ...tgOptions } = (options || {});
          const sendPromise = bot.telegram.sendMessage(chatId, message, {
            parse_mode: 'HTML',
            ...tgOptions
          });
          
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Telegram API timeout after ${telegramTimeout}ms`)), telegramTimeout)
          );
          
          await Promise.race([sendPromise, timeoutPromise]);
          
          const nowAfterSend = Date.now();
          this._lastSendAt.set(queueKey, nowAfterSend);
          this._perChatLastSend.set(chatId, nowAfterSend);
          this._queueLastAccess.set(queueKey, nowAfterSend);
          this._chatLastAccess.set(chatId, nowAfterSend);
          
          // Reset consecutive errors on success
          this._consecutiveErrors.set(queueKey, 0);
          
          logger.info(`[Telegram] ✅ Successfully sent message to ${chatId} (alertType=${alertType || 'order'})`);
        } catch (error) {
          // ✅ IMPROVED: Extract comprehensive error information
          const msg = error?.message || '';
          const errorCode = error?.code || error?.response?.error_code || 'N/A';
          const errorCause = error?.cause?.message || error?.cause || '';
          const errorReason = error?.reason || error?.cause?.code || '';
          const retryAfter = Number(error?.response?.parameters?.retry_after || error?.parameters?.retry_after || NaN);
          
          // Build detailed error message
          const errorDetails = [
            `message: ${msg}`,
            `code: ${errorCode}`,
            errorReason ? `reason: ${errorReason}` : '',
            errorCause ? `cause: ${errorCause}` : '',
            error?.response?.description ? `telegram_desc: ${error.response.description}` : ''
          ].filter(Boolean).join(', ');
          
          const is429 = /429/i.test(msg) || errorCode === 429 || error?.response?.error_code === 429;
          const transient = is429 || /retry|timeout|network|ECONNRESET|ETIMEDOUT|socket hang|EAI_AGAIN|ENOTFOUND|ECONNREFUSED/i.test(msg) || 
                           errorCode === 'ECONNRESET' || errorCode === 'ETIMEDOUT' || errorCode === 'ECONNREFUSED';
          
          // Check for specific Telegram API errors
          const isChatNotFound = /chat.*not.*found|chat_id.*invalid/i.test(msg) || error?.response?.error_code === 400;
          const isForbidden = /forbidden|blocked/i.test(msg) || error?.response?.error_code === 403;

          if (isChatNotFound || isForbidden) {
            // Chat not found or bot blocked - don't retry, just log warning
            logger.warn(`[Telegram] Chat ${chatId} not found or bot blocked. Skipping message. ${errorDetails}`);
            // Don't requeue - this is a permanent error
          } else if (is429) {
            // Handle 429 specifically with global backoff
            const consecutiveErrors = (this._consecutiveErrors.get(queueKey) || 0) + 1;
            this._consecutiveErrors.set(queueKey, consecutiveErrors);
            
            // Use retry_after from Telegram, add extra buffer, and apply exponential backoff for consecutive errors
            const baseBackoffMs = Number.isFinite(retryAfter) ? (retryAfter * 1000 + 5000) : 35000; // retry_after + 5s buffer, or 35s default
            const multiplier = Math.min(consecutiveErrors, 5); // Max 5x multiplier
            const backoffMs = baseBackoffMs * multiplier;
            
            // Set global backoff for this queue
            const backoffUntilTime = Date.now() + backoffMs;
            this._globalBackoffUntil.set(queueKey, backoffUntilTime);
            
            logger.warn(`[Telegram] 429 Rate Limited! Setting global backoff for ${queueKey}: ${backoffMs}ms (consecutive: ${consecutiveErrors}). chatId=${chatId}, retry_after=${retryAfter || 'N/A'}s`);
            
            queue.unshift({ chatId, message, options }); // requeue at front
            await new Promise(r => setTimeout(r, backoffMs));
          } else if (transient) {
            // Other transient errors (network issues, etc.)
            const backoffMs = 5000; // 5 second backoff for non-429 transient errors
            logger.warn(`[Telegram] Transient error, backing off ${backoffMs}ms before retry. chatId=${chatId}, alertType=${alertType || 'order'}, ${errorDetails}`);
            queue.unshift({ chatId, message, options }); // requeue
            await new Promise(r => setTimeout(r, backoffMs));
          } else {
            // Other errors - log with full details
            logger.error(`[Telegram] Failed to send message to ${chatId} (alertType=${alertType || 'order'}): ${errorDetails}`, error?.stack || '');
            // Don't requeue for unknown errors to avoid infinite loops
          }
        }
      }
      
      const remaining = this._queues.get(queueKey)?.length || 0;
      if (remaining > 0) {
        logger.debug(`[Telegram] Queue ${queueKey} processing completed, ${remaining} messages remaining`);
      } else {
        logger.debug(`[Telegram] Queue ${queueKey} processing completed, queue is empty`);
      }
    } catch (outerError) {
      logger.error(`[Telegram] ❌ CRITICAL: Error in _processQueue for alertType=${alertType} (queueKey=${queueKey})`, { err: outerError?.message, stack: outerError?.stack });
    } finally {
      this._processing.set(queueKey, false);
      logger.debug(`[Telegram] Queue ${queueKey} processing flag cleared`);
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

    await this.sendMessage(chatId, message, { alertType: 'order' });
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
      if (!this.initialized || this.clients.size === 0) {
        logger.warn(`[Entry Alert] Telegram bot not initialized, skipping alert for position ${position?.id}`);
        return;
      }
      

      const channelId = '-1003163801780';
      logger.debug(`[Entry Alert] Channel ID resolved: strategy.bot.telegram_alert_channel_id=${strategy?.bot?.telegram_alert_channel_id || 'NULL'}, this.alertChannelId=${this.alertChannelId || 'NULL'}, final=${channelId || 'NULL'}`);
      
      if (!channelId) {
        logger.warn(`[Entry Alert] Alert channel ID not configured, skipping alert for position ${position?.id}`);
        logger.warn(`[Entry Alert] Debug info: strategy.bot=${!!strategy?.bot}, strategy.bot_id=${strategy?.bot_id || 'NULL'}, position.bot_id=${position?.bot_id || 'NULL'}`);
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
      await this.sendMessage(channelId, msg, { alertType: 'order' });
      logger.info(`[Entry Alert] ✅ Message queued for position ${position.id} (actual send happens in _processQueue)`);
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
        channelId = "-1003163801780";
      }
      
      if (!channelId) {
        logger.warn(`[CloseSummaryAlert] No channel ID available for position ${position.id}, skipping notification`);
        logger.warn(`[CloseSummaryAlert] position.telegram_alert_channel_id: ${position?.telegram_alert_channel_id || 'NULL'}`);
        logger.warn(`[CloseSummaryAlert] position.telegram_chat_id: ${position?.telegram_chat_id || 'NULL'}`);
        logger.warn(`[CloseSummaryAlert] this.alertChannelId: ${this.alertChannelId || 'NULL'}`);
        return;
      }

      logger.info(`[CloseSummaryAlert] Sending alert for position ${position.id} to channel ${channelId}`);
      logger.debug(`[CloseSummaryAlert] Queue status: queues.size=${this._queues.size}, clients.size=${this.clients.size}, initialized=${this.initialized}`);

      const symbol = this.formatSymbolUnderscore(position.symbol);
      const pnlVal = Number(position.pnl || 0);
      const isWin = pnlVal > 0; // WIN if PNL > 0, LOSE if PNL <= 0
      const sideTitle = position.side === 'long' ? 'Long' : 'Short';
      const emoji = isWin ? '🏆' : '😡';
      const title = `${emoji} ${symbol} | ${sideTitle} ${isWin ? 'WIN' : 'LOSE'}`;

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

      await this.sendMessage(channelId, msg, { alertType: 'order' });
      logger.info(`[CloseSummaryAlert] ✅ Message queued for position ${position.id} (actual send happens in _processQueue)`);
    } catch (e) {
      logger.error(`[CloseSummaryAlert] ❌ Failed to send close summary alert for position ${position?.id || 'unknown'}:`, e?.message || e, e?.stack);
    }
  }

  /**
   * Send WebSocket exit order filled alert when DB position not found
   * This ensures we always notify about exit orders filled via WS, even if position lookup fails
   * @param {number} botId - Bot ID
   * @param {string} orderId - Exit order ID
   * @param {string} symbol - Trading symbol
   * @param {number} avgPrice - Average fill price
   * @param {number} filledQty - Filled quantity (optional)
   * @param {string} exchange - Exchange name (default: 'binance')
   */
  async sendWsExitFilledAlert(botId, orderId, symbol, avgPrice, filledQty = null, exchange = 'binance') {
    try {
      if (!this.initialized || this.clients.size === 0) {
        logger.warn(`[WS Exit Alert] Telegram bot not initialized, skipping alert for order ${orderId}`);
        return;
      }

      // WS exit filled alert is part of order service -> always use order client/channel
      const formattedSymbol = this.formatSymbolUnderscore(symbol);
      const formattedPrice = avgPrice ? this.formatPriceAdaptive(avgPrice) : 'N/A';
      const formattedQty = filledQty ? Number(filledQty).toFixed(2) : 'N/A';

      const msg = `
⚠️ <b>Closed Position ${formattedSymbol} </b>

Symbol: <b>${formattedSymbol}</b>
Bot ID: <b>${botId}</b>
Order ID: <b>${orderId}</b>
Avg Price: <b>${formattedPrice}</b>
Filled Qty: <b>${formattedQty}</b>
Exchange: <b>${String(exchange || 'N/A').toUpperCase()}</b>

<i>⚠️ DB position not found (no matching exit_order_id/sl_order_id). Please check PositionSync / orderId mapping.</i>
      `.trim();

      logger.info(`[WS Exit Alert] Sending WS exit filled alert for order ${orderId} (${symbol}) to channel -1003163801780`);
      await this.sendMessage('-1003163801780', msg, { alertType: 'order' });
      logger.info(`[WS Exit Alert] ✅ Message queued for order ${orderId} (actual send happens in _processQueue)`);
    } catch (e) {
      logger.error(`[WS Exit Alert] Failed to send WS exit filled alert for order ${orderId}:`, e?.message || e, e?.stack);
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

    await this.sendMessage(chatId, message, { alertType: 'order' });
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

    await this.sendMessage(chatId, message, { alertType: 'order' });
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

    await this.sendMessage(chatId, message, { alertType: 'order' });
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

//     await this.sendMessage(chatId, message, { alertType: 'order' });
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
   * @param {string} chatId - Chat ID
   * @param {Object} alertData - Alert data (can include exchange)
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

    if (!this.initialized || this.clients.size === 0) {
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

    // Extract exchange from alertData to use correct bot token and normalize to 'default' if empty/null
    const exchange = (alertData?.exchange || '').toLowerCase() || '';

    const alertType = exchange === 'mexc' ? 'price_mexc' : 'price_binance';

    logger.info(`[VolatilityAlert] Queuing alert to ${chatId} (alertType=${alertType}): ${symbol} ${intervalLabel} ${ocAbs}% ${directionEmoji}`);

    // sendMessage is queue-based, so we queue it and let the queue processor handle it
    // The actual send status will be logged by _processQueue
    try {
      await this.sendMessage(chatId, message, { alertType });
      logger.debug(`[VolatilityAlert] Alert queued for ${chatId} (alertType=${alertType}): ${symbol} ${intervalLabel} ${ocAbs}% ${directionEmoji}`);
    } catch (error) {
      logger.error(`[VolatilityAlert] Failed to queue alert to ${chatId} (alertType=${alertType}):`, error?.message || error);
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
      if (!this.initialized || this.clients.size === 0) {
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
      await this.sendMessage(chatId, message, { alertType: 'order' });
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

  /**
   * Stop service and cleanup all resources (for graceful shutdown)
   */
  async stop() {
    logger.info('[TelegramService] Stopping service and cleaning up resources...');
    
    // Stop cleanup timer
    this._stopCleanupTimer();
    
    // Clear all batches timers
    for (const [exchange, batch] of this._batches.entries()) {
      if (batch.timer) {
        clearTimeout(batch.timer);
      }
    }
    
    // Run final cleanup
    await this._cleanupMaps();
    
    // Clear all Maps
    this._queues.clear();
    this._processing.clear();
    this._lastSendAt.clear();
    this._perChatLastSend.clear();
    this._batches.clear();
    this._queueLastAccess.clear();
    this._chatLastAccess.clear();
    
    // Note: Keep bots Map as it may be needed for re-initialization
    
    this.initialized = false;
    logger.info('[TelegramService] Service stopped and resources cleaned up');
  }
}

