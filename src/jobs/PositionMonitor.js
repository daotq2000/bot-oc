import { Position } from '../models/Position.js';
import { Strategy } from '../models/Strategy.js';
import { ExchangeService } from '../services/ExchangeService.js';
import { PositionService } from '../services/PositionService.js';
import { OrderService } from '../services/OrderService.js';
import { TelegramService } from '../services/TelegramService.js';
import { SCAN_INTERVALS } from '../config/constants.js';
import { configService } from '../services/ConfigService.js';
import logger from '../utils/logger.js';
import { ScanCycleCache } from '../utils/ScanCycleCache.js';
import { calculatePnL, calculatePnLPercent } from '../utils/calculator.js';
import { StrategyAdvancedSettings } from '../models/StrategyAdvancedSettings.js';
import { ATRTrailingService } from '../services/ATRTrailingService.js';
import { PartialTakeProfitService } from '../services/PartialTakeProfitService.js';
import { RiskManagementService } from '../services/RiskManagementService.js';
import { SupportResistanceService } from '../services/SupportResistanceService.js';
import { MultiTimeframeService } from '../services/MultiTimeframeService.js';
import { LossStreakService } from '../services/LossStreakService.js';
import { AutoOptimizeService } from '../services/AutoOptimizeService.js';
import { LifoAsyncQueue } from '../utils/LifoAsyncQueue.js';

/**
 * Position Monitor Job - Monitor and update open positions
 */
export class PositionMonitor {
  constructor() {
    this.exchangeServices = new Map(); // botId -> ExchangeService
    this.positionServices = new Map(); // botId -> PositionService
    this.orderServices = new Map(); // botId -> OrderService
    this.atrTrailingServices = new Map(); // botId -> ATRTrailingService
    this.partialTPServices = new Map(); // botId -> PartialTakeProfitService
    this.riskMgmtServices = new Map(); // botId -> RiskManagementService
    this.srServices = new Map(); // botId -> SupportResistanceService
    this.mtfServices = new Map(); // botId -> MultiTimeframeService
    this._autoOptimize = new AutoOptimizeService();
    this.telegramService = null;
    this.isRunning = false;
    this._lastLogTime = null; // For throttling debug logs
    this._lastSummary = null; // Cache last summary for diff logging
    this._pnlAlertTimer = null; // Timer for realtime PnL alerts

    // ADV_TPSL throttling (prevents API/CPU storms -> WS stale messages)
    this._advLastAppliedAt = new Map(); // posId -> ts
    this._advInFlight = 0;
    this._advProcessedThisCycle = 0;

    // Scan-cycle caches (cleared at the start of every monitorAllPositions run)
    this._scanCache = new ScanCycleCache();
    this._priceCache = new ScanCycleCache();
    this._closableQtyCache = new ScanCycleCache();

    // TP/SL placement queue (LIFO): newest positions get protected first.
    // Per-bot queues to avoid cross-bot starvation and reduce rate-limit collisions.
    this._tpslQueues = new Map(); // botId -> LifoAsyncQueue
  }

  /**
   * Send realtime PnL alerts for active Binance positions to Telegram
   * Interval controlled by PNL_ALERT_INTERVAL_MS (default 10s)
   */
  async _sendRealtimePnlAlerts() {
    const chatId = configService.getString('TELEGRAM_BOT_TOKEN_POSITION_MONITOR_BINANCE_CHANEL');
    if (!chatId) {
      logger.debug('[PositionMonitor] PnL alert skipped: chatId not configured');
      return;
    }
    if (!this.telegramService || !this.telegramService.initialized) {
      logger.debug('[PositionMonitor] PnL alert skipped: telegramService not initialized');
      return;
    }

    try {
      const openPositions = await Position.findOpen();
      if (!openPositions || openPositions.length === 0) {
        logger.debug('[PositionMonitor] PnL alert: no open positions');
        return;
      }
      
      const maxPositions = Number(configService.getNumber('PNL_ALERT_MAX_POSITIONS', 40)); // per bot cap
      const maxChunkChars = Number(configService.getNumber('PNL_ALERT_MAX_CHARS', 3500)); // Telegram hard limit ~4096, keep headroom
      const maxMessagesPerRun = Number(configService.getNumber('PNL_ALERT_MAX_MESSAGES', 3)); // per bot

      // Group by bot for exchange lookups
      const positionsByBot = new Map();
      for (const pos of openPositions) {
        if (!pos.bot_id) continue;
        if (!positionsByBot.has(pos.bot_id)) positionsByBot.set(pos.bot_id, []);
        positionsByBot.get(pos.bot_id).push(pos);
      }

      for (const [botId, botPositions] of positionsByBot.entries()) {
        const exchangeService = this.exchangeServices.get(botId);
        if (!exchangeService || exchangeService.bot?.exchange !== 'binance') {
          continue; // only Binance as yêu cầu
        }
        const botName = exchangeService.bot?.bot_name || `bot_${botId}`;

        // Fetch open positions on exchange once to verify active
        let exPositions = [];
        try {
          const raw = await exchangeService.getOpenPositions();
          exPositions = Array.isArray(raw) ? raw : [];
        } catch (e) {
          logger.warn(`[PositionMonitor] PnL alert: could not fetch exchange positions for bot ${botId}: ${e?.message || e}`);
          continue;
        }

        const activeMap = new Map(); // key: symbol|side -> true
        for (const ex of exPositions) {
          const sym = ex.symbol || ex.info?.symbol;
          const rawAmt = parseFloat(ex.positionAmt ?? ex.contracts ?? ex.size ?? 0);
          if (!sym || !rawAmt) continue;
          const side = rawAmt > 0 ? 'long' : rawAmt < 0 ? 'short' : null;
          if (!side) continue;
          activeMap.set(`${sym}|${side}`, true);
        }

        const botMessages = [];
        for (const pos of botPositions) {
          const side = pos.side || (pos.amount > 0 ? 'long' : 'short');
          const key = `${pos.symbol}|${side}`;
          if (!activeMap.has(key)) {
            // Not active on exchange, skip alert
            continue;
          }

          let currentPrice = null;
          try {
            currentPrice = await exchangeService.getTickerPrice(pos.symbol);
          } catch (e) {
            logger.warn(`[PositionMonitor] PnL alert: cannot get price for ${pos.symbol}: ${e?.message || e}`);
            continue;
          }
          if (!Number.isFinite(Number(currentPrice))) continue;

          const entryPrice = Number(pos.entry_price);
          const amount = Number(pos.amount);
          const pnl = calculatePnL(entryPrice, currentPrice, amount, side);
          const pnlPct = calculatePnLPercent(entryPrice, currentPrice, side);

          // Estimate PnL at TP/SL if available
          const tpPrice = Number(pos.take_profit_price || pos.initial_tp_price || 0) || null;
          const slPrice = Number(pos.stop_loss_price || pos.sl_price || pos.sl || pos.stoploss || 0) || null;
          const pnlTp = tpPrice ? calculatePnL(entryPrice, tpPrice, amount, side) : null;
          const pnlSl = slPrice ? calculatePnL(entryPrice, slPrice, amount, side) : null;

          const fmt = (v, digits = 5) => Number(v).toFixed(digits);
          const fmt2 = (v) => Number(v).toFixed(2);
          const sideLabel = side ? side.toUpperCase() : 'N/A';

          const tpLine = pnlTp !== null ? `🎯 TP Est: ≈ ${fmt2(pnlTp)} USDT` : null;
          const slLine = pnlSl !== null ? `🛡️ SL Est: ≈ ${fmt2(pnlSl)} USDT` : null;

          const block = [
            `📊 ${pos.symbol} | ${sideLabel}`,
            `🟢 Entry: ${fmt(entryPrice, 5)} → 🔴 Mark: ${fmt(currentPrice, 5)}`,
            `💥 PNL: ${fmt2(pnl)} USDT (${fmt2(pnlPct)}%)`,
            tpLine || slLine ? [tpLine, slLine].filter(Boolean).join(' | ') : null
          ].filter(Boolean).join('\n');

          // Prepend bot header per chunk later; here keep per-position block
          botMessages.push(block);
        }
        
        if (botMessages.length === 0) {
          logger.info(`[PositionMonitor] PnL alert: no active Binance positions to report for ${botName}`);
          continue;
        }

        // Sort by PnL asc (worst first) to surface risk
        botMessages.sort((a, b) => {
          const pa = parseFloat(a.match(/PNL: ([+-]?\d+(\.\d+)?)/)?.[1] || 0);
          const pb = parseFloat(b.match(/PNL: ([+-]?\d+(\.\d+)?)/)?.[1] || 0);
          return pa - pb;
        });

        const total = botMessages.length;
        const limited = botMessages.slice(0, maxPositions);
        const truncated = total - limited.length;

        // Chunk into multiple Telegram messages under length limit
        let chunks = [];
        let current = [];
        let currentLen = 0;
        for (const line of limited) {
          const projected = currentLen + line.length + 1;
          if (projected > maxChunkChars && current.length > 0) {
            chunks.push(current);
            current = [];
            currentLen = 0;
          }
          current.push(line);
          currentLen += line.length + 1;
          if (chunks.length >= maxMessagesPerRun - 1 && projected > maxChunkChars) break; // protect from spam
        }
        if (current.length) chunks.push(current);
        chunks = chunks.slice(0, maxMessagesPerRun); // hard cap messages per run

        let sentCount = 0;
        for (let i = 0; i < chunks.length; i++) {
          const lines = chunks[i];
          const header = `📊 Position | ${botName} (Total active: ${total}, showing ${sentCount + lines.length}${truncated > 0 ? `, truncated ${truncated}` : ''})\n`;
          const body = lines.join('\n\n');
          const msg = `${header}${body}`;
          await this.telegramService.sendMessage(chatId, msg, { alertType: 'position_monitor_binance' });
          sentCount += lines.length;
        }

        logger.info(`[PositionMonitor] PnL alert sent for ${botName} with ${Math.min(total, maxPositions)} position(s) over ${chunks.length} message(s), truncated=${truncated}`);
      }
    } catch (err) {
      logger.error('[PositionMonitor] PnL alert error:', err?.message || err);
    }
  }

  /**
   * Initialize services for all active bots
   */
  async initialize(telegramService) {
    this.telegramService = telegramService;

    try {
      const { Bot } = await import('../models/Bot.js');
      const bots = await Bot.findAll(true); // Active bots only
      
      logger.info(`[PositionMonitor] Found ${bots.length} active bot(s) to initialize: ${bots.map(b => `bot ${b.id}`).join(', ')}`);

      // Initialize bots sequentially with delay to reduce CPU load
      for (let i = 0; i < bots.length; i++) {
        logger.debug(`[PositionMonitor] Initializing bot ${bots[i].id} (${i + 1}/${bots.length})...`);
        await this.addBot(bots[i]);
        // Add delay between bot initializations to avoid CPU spike
        if (i < bots.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 600)); // 600ms delay
        }
      }
      
      logger.info(`[PositionMonitor] ✅ Initialized ${this.exchangeServices.size} ExchangeService(s) for ${bots.length} bot(s)`);
    } catch (error) {
      logger.error('Failed to initialize PositionMonitor', { err: error?.message, stack: error?.stack });
    }
  }

  /**
   * Small helper to retry getOrderStatus to handle transient API errors
   */
  async _getOrderStatusWithRetry(exchangeService, symbol, orderId, label, maxRetries = 3, baseDelayMs = 200) {
    let attempt = 0;
    let lastError;
    while (attempt < maxRetries) {
      try {
        const res = await exchangeService.getOrderStatus(symbol, orderId);
        return res;
      } catch (err) {
        lastError = err;
        attempt++;
        const delay = baseDelayMs * attempt;
        logger.debug(
          `[OrderStatusRetry] ${label} attempt ${attempt}/${maxRetries} failed: ${err?.message || err}. ` +
          `Retrying in ${delay}ms...`
        );
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    logger.warn(`[OrderStatusRetry] ${label} failed after ${maxRetries} attempts: ${lastError?.message || lastError}`);
    throw lastError;
  }

  /**
   * Add bot to monitor
   * @param {Object} bot - Bot object
   */
  async addBot(bot) {
    try {
      logger.debug(`[PositionMonitor] Creating ExchangeService for bot ${bot.id} (${bot.exchange || 'unknown'}, testnet=${bot.binance_testnet || 'false'})...`);
      const exchangeService = new ExchangeService(bot);
      await exchangeService.initialize();
      this.exchangeServices.set(bot.id, exchangeService);
      logger.debug(`[PositionMonitor] ✅ ExchangeService created for bot ${bot.id}`);

      const positionService = new PositionService(exchangeService, this.telegramService, {
        scanCache: this._scanCache,
        priceCache: this._priceCache,
        closableQtyCache: this._closableQtyCache
      });
      this.positionServices.set(bot.id, positionService);

      const orderService = new OrderService(exchangeService, this.telegramService);
      this.orderServices.set(bot.id, orderService);

      // Advanced TP/SL services (toggle at runtime via env)
      this.atrTrailingServices.set(bot.id, new ATRTrailingService(exchangeService));
      this.partialTPServices.set(bot.id, new PartialTakeProfitService(exchangeService));
      this.riskMgmtServices.set(bot.id, new RiskManagementService(exchangeService));
      this.srServices.set(bot.id, new SupportResistanceService(exchangeService));
      this.mtfServices.set(bot.id, new MultiTimeframeService(exchangeService));

      logger.info(`[PositionMonitor] ✅ Initialized for bot ${bot.id} (${bot.exchange || 'unknown'}, testnet=${bot.binance_testnet || 'false'})`);
    } catch (error) {
      logger.error(`[PositionMonitor] ❌ Failed to initialize for bot ${bot.id}:`, error?.message || error, error?.stack);
      // Don't throw - continue with other bots
    }
  }

  /**
   * Remove bot from monitor
   * @param {number} botId - Bot ID
   */
  removeBot(botId) {
    this.exchangeServices.delete(botId);
    this.positionServices.delete(botId);
    this.orderServices.delete(botId);
    this.atrTrailingServices.delete(botId);
    this.partialTPServices.delete(botId);
    this.riskMgmtServices.delete(botId);
    this.srServices.delete(botId);
    this.mtfServices.delete(botId);
    logger.info(`Removed bot ${botId} from PositionMonitor`);
  }

  /**
   * Monitor a single position
   * @param {Object} position - Position object
   */
  async monitorPosition(position) {
    try {
      const botId = position.bot_id || position.strategy?.bot_id;
      const positionService = this.positionServices.get(botId);
      if (!positionService) {
        logger.warn(`PositionService not found for position ${position.id}`);
        return;
      }

      // Scan-cycle cache: avoid reprocessing the same position multiple times per cycle
      const scanKey = `monitor:${position.id}`;
      if (this._scanCache.has(scanKey)) {
        return;
      }
      this._scanCache.set(scanKey, true);

      // Advanced TP/SL manager (safe no-op if disabled / no settings table)
      // CRITICAL: TP/SL placement (placeExitOrder) is independent of ADV_TPSL and watchdog degrade mode
      // This ensures basic TP/SL protection is always available even when advanced features are disabled
      if (configService.getBoolean('ADV_TPSL_ENABLED', false) && position.status === 'open') {
        try {
          // Check watchdog degrade mode - if degraded, skip ADV_TPSL to protect WS
          const { watchdogService } = await import('../services/WatchdogService.js');
          const watchdogLimits = watchdogService?.getAdvLimits?.() || null;
          if (watchdogLimits && watchdogLimits.maxPerCycle === 0) {
            // Degraded mode active - skip ADV_TPSL to protect WebSocket
            logger.debug(`[ADV_TPSL] Skipping advanced features for position ${position.id} (watchdog degrade mode active)`);
          } else {
            // Throttle ADV_TPSL to avoid API storms that cause WS stale messages/extreme latency.
            const advMaxPerCycle = watchdogLimits?.maxPerCycle ?? Number(configService.getNumber('ADV_TPSL_MAX_POSITIONS_PER_CYCLE', 25));
            const advCooldownMs = watchdogLimits?.cooldownMs ?? Number(configService.getNumber('ADV_TPSL_POSITION_COOLDOWN_MS', 120000)); // 2m
            const advMaxConcurrent = watchdogLimits?.maxConcurrent ?? Number(configService.getNumber('ADV_TPSL_MAX_CONCURRENT', 2));
            const allowWithoutProtection = configService.getBoolean('ADV_TPSL_ALLOW_WHEN_NO_TPSL', false);

            if (this._advProcessedThisCycle >= advMaxPerCycle) {
              // skip - protect bot health
            } else if (this._advInFlight >= advMaxConcurrent) {
              // skip when saturated
            } else {
              const lastAt = this._advLastAppliedAt.get(position.id) || 0;
              if (Date.now() - lastAt < advCooldownMs) {
                // skip until cooldown passes
              } else {
                const hasBasicProtection = Boolean(position.exit_order_id) && Boolean(position.sl_order_id);
                if (!hasBasicProtection && !allowWithoutProtection) {
                  // skip heavy OHLCV analysis until TP/SL orders exist
                } else {
                  this._advInFlight += 1;
                  this._advProcessedThisCycle += 1;
                  this._advLastAppliedAt.set(position.id, Date.now());

                  const settings = await StrategyAdvancedSettings.getByStrategyId(position.strategy_id);
                  const atrSvc = this.atrTrailingServices.get(botId);
                  const riskSvc = this.riskMgmtServices.get(botId);
                  const ptpSvc = this.partialTPServices.get(botId);
                  const srSvc = this.srServices.get(botId);
                  const mtfSvc = this.mtfServices.get(botId);

                  // Loss streak guard (optional): if too many consecutive losses, close bad losers faster.
                  if (configService.getBoolean('ADV_TPSL_LOSS_STREAK_ENABLED', false) && settings?.loss_streak_enabled === true) {
                    const streak = await LossStreakService.getLossStreak(botId);
                    const maxLosses = Number(settings.max_consecutive_losses ?? configService.getNumber('ADV_TPSL_MAX_CONSECUTIVE_LOSSES', 3));
                    const forceCloseNegPct = Number(configService.getNumber('ADV_TPSL_LOSS_STREAK_FORCE_CLOSE_NEG_PCT', 3.0));
                    if (streak >= maxLosses) {
                      const current = Number(await this.exchangeServices.get(botId)?.getTickerPrice(position.symbol));
                      const entry = Number(position.entry_price);
                      const dir = (position.side || (Number(position.amount) > 0 ? 'long' : 'short')) === 'long' ? 1 : -1;
                      const pnlPct = Number.isFinite(current) && Number.isFinite(entry) && entry > 0 ? ((current - entry) / entry) * 100 * dir : 0;
                      if (pnlPct <= -Math.abs(forceCloseNegPct)) {
                        await this.exchangeServices.get(botId)?.closePosition(position.symbol, position.side, position.amount);
                        logger.warn(`[ADV_TPSL][LossStreak] bot=${botId} streak=${streak} forced close pos=${position.id} pnlPct=${pnlPct.toFixed(2)}%`);
                        return;
                      }
                    }
                  }

                  // Auto optimize (throttled; safe, DB-only)
                  if (configService.getBoolean('ADV_TPSL_AUTO_OPTIMIZE_ENABLED', false) && settings?.auto_optimize_enabled === true) {
                    await this._autoOptimize.maybeOptimize(position.strategy_id);
                  }

                  // Order: ATR -> Risk(breakeven/RR/volume/lowvol...) -> Partial TP
                  if (atrSvc) await atrSvc.apply(position, settings);
                  if (riskSvc) await riskSvc.apply(position, settings);
                  if (srSvc) await srSvc.apply(position, settings);
                  if (mtfSvc) await mtfSvc.apply(position, settings);
                  if (ptpSvc) await ptpSvc.apply(position, settings);

                  this._advInFlight -= 1;
                }
              }
            }
          }
        } catch (e) {
          if (this._advInFlight > 0) this._advInFlight -= 1;
          logger.warn(`[ADV_TPSL] Failed to apply advanced TP/SL for pos=${position.id}: ${e?.message || e}`);
        }
      }

      // Update position (checks TP/SL and updates dynamic SL)
      const updated = await positionService.updatePosition(position);

      // positionService.updatePosition() may return null/undefined on failure (e.g., network timeout)
      if (!updated) {
        logger.warn(`Position ${position.id}: updatePosition returned null/undefined (skipping status check)`);
        return;
      }

      // Notification is now handled within PositionService.closePosition to ensure correct PNL
      if (updated.status === 'closed' && updated.close_reason) {
        logger.info(`Position ${position.id} was closed with reason: ${updated.close_reason}. Notification handled by PositionService.`);
      }
    } catch (error) {
      logger.error(`Error monitoring position ${position.id}`, { err: error?.message, stack: error?.stack });
    }
  }

  /**
   * Place TP/SL orders for new positions that don't have them yet.
   * Uses soft lock to prevent race conditions when multiple instances run concurrently.
   * @param {Object} position - Position object
   */
  _getTpSlQueue(botId) {
    const id = String(botId);
    if (this._tpslQueues.has(id)) return this._tpslQueues.get(id);

    const concurrency = Number(configService.getNumber('TPSL_QUEUE_CONCURRENCY_PER_BOT', 2));
    const maxSize = Number(configService.getNumber('TPSL_QUEUE_MAX_SIZE_PER_BOT', 500));

    const q = new LifoAsyncQueue({
      concurrency,
      maxSize,
      name: `TPSLQueue(bot=${id})`
    });

    this._tpslQueues.set(id, q);
    return q;
  }

  async placeExitOrder(position) {
    const botId = position?.bot_id;
    const q = this._getTpSlQueue(botId);

    // Dedupe per position: only keep the latest TP/SL placement request.
    // Priority: emergency positions go first.
    const openedAt = position?.opened_at ? new Date(position.opened_at).getTime() : 0;
    const ageMs = openedAt ? Date.now() - openedAt : 0;
    const emergencyMs = Number(configService.getNumber('POSITION_EMERGENCY_SLA_MS', 10 * 1000));
    const priority = ageMs > emergencyMs ? 10 : 0;

    return q.push({
      key: `tpsl:${position?.id}`,
      priority,
      maxRetries: Number(configService.getNumber('TPSL_QUEUE_MAX_RETRIES', 3)),
      baseDelayMs: Number(configService.getNumber('TPSL_QUEUE_BASE_DELAY_MS', 200)),
      fn: async () => this._placeExitOrderCore(position)
    });
  }

  async _placeExitOrderCore(position) {
    // Skip if position is not open
    if (position.status !== 'open') {
      return;
    }

    // CRITICAL SAFETY CHECK: If position has been open > 10s without TP/SL, force create immediately
    // This prevents positions from being exposed to market risk without protection
    // Reduced from 30s to 10s for faster protection
    const SAFETY_CHECK_MS = 10000; // 10 seconds (reduced from 30s)
    if (position.opened_at) {
      const openedAt = new Date(position.opened_at).getTime();
      const timeSinceOpened = Date.now() - openedAt;
      const hasTPSL = position.exit_order_id && position.sl_order_id;
      
      if (timeSinceOpened > SAFETY_CHECK_MS && !hasTPSL) {
        logger.error(
          `[Place TP/SL] 🚨 CRITICAL SAFETY CHECK: Position ${position.id} (${position.symbol}) has been open for ` +
          `${Math.floor(timeSinceOpened / 1000)}s without TP/SL! ` +
          `exit_order_id=${position.exit_order_id || 'NULL'}, sl_order_id=${position.sl_order_id || 'NULL'}. ` +
          `FORCING immediate TP/SL creation to prevent deep loss or missed profit!`
        );
        // Force set tp_sl_pending to ensure TP/SL creation
        try {
          if (Position?.rawAttributes?.tp_sl_pending) {
            await Position.update(position.id, { tp_sl_pending: true });
            position.tp_sl_pending = true;
          }
        } catch (e) {
          logger.debug(`[Place TP/SL] Could not set tp_sl_pending flag: ${e?.message || e}`);
        }
      }
    }

    // RACE CONDITION FIX: Use soft lock to prevent concurrent TP/SL placement
    // Try to acquire lock by setting is_processing flag (with retry mechanism)
    let lockAcquired = false;
    try {
      const { pool } = await import('../config/database.js');
      // Retry lock up to 3 times with 100ms delay
      for (let retry = 0; retry < 3; retry++) {
        const [result] = await pool.execute(
          `UPDATE positions 
           SET is_processing = 1 
           WHERE id = ? AND status = 'open' AND (is_processing = 0 OR is_processing IS NULL)
           LIMIT 1`,
          [position.id]
        );
        
        if (result.affectedRows > 0) {
          lockAcquired = true;
          break;
        }
        
        // Wait before retry (except last attempt)
        if (retry < 2) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      // If no rows updated after retries, another process is already handling this position
      if (!lockAcquired) {
        logger.debug(`[Place TP/SL] Position ${position.id} is already being processed by another instance (after 3 retries), skipping...`);
        return;
      }
    } catch (lockError) {
      // If is_processing column doesn't exist, continue without lock (backward compatibility)
      logger.debug(`[Place TP/SL] Could not acquire lock for position ${position.id} (column may not exist): ${lockError?.message || lockError}`);
      lockAcquired = true; // Continue processing if column doesn't exist
    }

    // Check if TP/SL orders still exist on exchange
    // If exit_order_id exists in DB but order is not on exchange (filled/canceled), we should recreate it
    // CRITICAL FIX: Also check tp_sl_pending flag - if true, we need to place TP/SL even if exit_order_id exists
    const isTPSLPending = position.tp_sl_pending === true || position.tp_sl_pending === 1;
    let needsTp = !position.exit_order_id || isTPSLPending;
    let needsSl = !position.sl_order_id || isTPSLPending;

    // OPTIMIZATION: Skip order verification for newly opened positions (< 5s)
    // New positions won't have orders yet, so verification is unnecessary
    const timeSinceOpened = position.opened_at ? Date.now() - new Date(position.opened_at).getTime() : 0;
    const isNewPosition = timeSinceOpened < 5000; // Less than 5 seconds

    // If exit_order_id exists, verify it's still active on exchange (skip for new positions)
    if (position.exit_order_id && !isNewPosition) {
      try {
        const exchangeService = this.exchangeServices.get(position.bot_id);
        if (exchangeService) {
          const orderStatus = await this._getOrderStatusWithRetry(
            exchangeService,
            position.symbol,
            position.exit_order_id,
            `TP order ${position.exit_order_id} pos=${position.id}`
          );
          const status = (orderStatus?.status || '').toLowerCase();
          // If order is filled, canceled, or expired, we need to recreate it
          if (status === 'filled' || status === 'canceled' || status === 'cancelled' || status === 'expired') {
            logger.warn(`[Place TP/SL] TP order ${position.exit_order_id} for position ${position.id} is ${status} on exchange, will recreate`);
            needsTp = true;
            // Clear exit_order_id in DB so we can recreate
            await Position.update(position.id, { exit_order_id: null });
            position.exit_order_id = null;
          }
        }
      } catch (e) {
        // If we can't check order status, do NOT clear order id; mark pending to retry next cycle
        logger.warn(
          `[Place TP/SL] Could not verify TP order ${position.exit_order_id} for position ${position.id}: ${e?.message || e}. ` +
          `Marking tp_sl_pending and will retry without clearing order_id.`
        );
        needsTp = true; // try to replace if needed
        try {
          if (Position?.rawAttributes?.tp_sl_pending) {
            await Position.update(position.id, { tp_sl_pending: true });
            position.tp_sl_pending = true;
          }
        } catch (flagErr) {
          logger.debug(`[Place TP/SL] Could not set tp_sl_pending after TP status error: ${flagErr?.message || flagErr}`);
        }
      }
    }

    // If sl_order_id exists, verify it's still active on exchange (skip for new positions)
    if (position.sl_order_id && !isNewPosition) {
      try {
        const exchangeService = this.exchangeServices.get(position.bot_id);
        if (exchangeService) {
          const orderStatus = await this._getOrderStatusWithRetry(
            exchangeService,
            position.symbol,
            position.sl_order_id,
            `SL order ${position.sl_order_id} pos=${position.id}`
          );
          const status = (orderStatus?.status || '').toLowerCase();
          // If order is filled, canceled, or expired, we need to recreate it
          if (status === 'filled' || status === 'canceled' || status === 'cancelled' || status === 'expired') {
            logger.warn(`[Place TP/SL] SL order ${position.sl_order_id} for position ${position.id} is ${status} on exchange, will recreate`);
            needsSl = true;
            // Clear sl_order_id in DB so we can recreate
            await Position.update(position.id, { sl_order_id: null });
            position.sl_order_id = null;
          }
        }
      } catch (e) {
        // If we can't check order status, do NOT clear order id; mark pending to retry next cycle
        logger.warn(
          `[Place TP/SL] Could not verify SL order ${position.sl_order_id} for position ${position.id}: ${e?.message || e}. ` +
          `Marking tp_sl_pending and will retry without clearing order_id.`
        );
        needsSl = true; // try to replace if needed
        try {
          if (Position?.rawAttributes?.tp_sl_pending) {
            await Position.update(position.id, { tp_sl_pending: true });
            position.tp_sl_pending = true;
          }
        } catch (flagErr) {
          logger.debug(`[Place TP/SL] Could not set tp_sl_pending after SL status error: ${flagErr?.message || flagErr}`);
        }
      }
    }

    // Skip if both TP and SL already exist and are active, AND tp_sl_pending is false
    if (!needsTp && !needsSl && !isTPSLPending) {
      // Release lock before returning
      await this._releasePositionLock(position.id);
      return;
    }
    
    // If tp_sl_pending is true but we have both orders, clear the flag
    if (isTPSLPending && position.exit_order_id && (!needsSl || position.sl_order_id)) {
      // Both orders exist, clear pending flag (only if column exists)
      try {
        if (Position?.rawAttributes?.tp_sl_pending) {
      await Position.update(position.id, { tp_sl_pending: false });
      logger.debug(`[Place TP/SL] Cleared tp_sl_pending flag for position ${position.id} (both TP and SL exist)`);
        } else {
          logger.debug(`[Place TP/SL] Skipped clearing tp_sl_pending (column not supported) for position ${position.id}`);
        }
      } catch (e) {
        logger.debug(`[Place TP/SL] Failed to clear tp_sl_pending flag (column may not exist): ${e?.message || e}`);
      }
      await this._releasePositionLock(position.id);
      return;
    }

    try {
      let exchangeService = this.exchangeServices.get(position.bot_id);
      if (!exchangeService) {
        // ✅ AUTO-FIX: Try to initialize ExchangeService for this bot if missing
        logger.warn(`[Place TP/SL] ExchangeService not found for bot ${position.bot_id}, attempting to initialize...`);
        try {
          const { Bot } = await import('../models/Bot.js');
          const bot = await Bot.findById(position.bot_id);
          if (!bot) {
            logger.error(`[Place TP/SL] Bot ${position.bot_id} not found in database, skipping position ${position.id}`);
        await this._releasePositionLock(position.id);
        return;
          }
          if (!bot.is_active && bot.is_active !== 1) {
            logger.warn(`[Place TP/SL] Bot ${position.bot_id} is not active, skipping position ${position.id}`);
            await this._releasePositionLock(position.id);
            return;
          }
          // Initialize ExchangeService for this bot
          await this.addBot(bot);
          exchangeService = this.exchangeServices.get(position.bot_id);
          if (exchangeService) {
            logger.info(`[Place TP/SL] ✅ Successfully initialized ExchangeService for bot ${position.bot_id}`);
          } else {
            logger.error(`[Place TP/SL] ❌ Failed to initialize ExchangeService for bot ${position.bot_id} after addBot`);
            await this._releasePositionLock(position.id);
            return;
          }
        } catch (error) {
          logger.error(`[Place TP/SL] ❌ Error initializing ExchangeService for bot ${position.bot_id}:`, error?.message || error);
          await this._releasePositionLock(position.id);
          return;
        }
      }

      // OPTIMIZATION: Get the actual fill price from the exchange with multiple fallbacks
      // Priority: 1) Order fill price, 2) Exchange position entry price, 3) DB entry price
      // CRITICAL FIX: Check order_id before querying exchange (synced positions have order_id=null)
      let fillPrice = null;
      let priceSource = 'unknown';
      
      // Method 1: Get from order fill price (most accurate for new positions)
      if (position.order_id) {
        try {
          fillPrice = await exchangeService.getOrderAverageFillPrice(position.symbol, position.order_id);
          if (fillPrice && Number.isFinite(fillPrice) && fillPrice > 0) {
            priceSource = 'order_fill';
            logger.info(`[Place TP/SL] ✅ Got fill price from order ${position.order_id}: ${fillPrice}`);
          }
        } catch (e) {
          logger.debug(`[Place TP/SL] Failed to get fill price from order for position ${position.id} (order_id=${position.order_id}): ${e?.message || e}`);
        }
      } else {
        logger.debug(`[Place TP/SL] Position ${position.id} has no order_id (synced position), trying exchange position data`);
      }
      
      // Method 2: Get from exchange position data (for synced positions)
      if (!fillPrice || !Number.isFinite(fillPrice) || fillPrice <= 0) {
        try {
          const exchangePositions = await exchangeService.getOpenPositions(position.symbol);
          if (Array.isArray(exchangePositions) && exchangePositions.length > 0) {
            const normalizedSymbol = (exchangeService?.binanceDirectClient?.normalizeSymbol && 
                                     exchangeService.binanceDirectClient.normalizeSymbol(position.symbol)) || position.symbol;
            const expectedPositionSide = position.side === 'long' ? 'LONG' : 'SHORT';
            
            const matchingPos = exchangePositions.find(p => {
              const symOk = (p.symbol === normalizedSymbol || p.symbol === position.symbol);
              if (!symOk) return false;
              if (p.positionSide && String(p.positionSide).toUpperCase() !== expectedPositionSide) return false;
              const amt = Math.abs(parseFloat(p.positionAmt ?? p.contracts ?? 0));
              return amt > 0;
            });
            
            if (matchingPos) {
              const exEntryPrice = parseFloat(matchingPos.entryPrice || matchingPos.info?.entryPrice || 0);
              if (exEntryPrice && Number.isFinite(exEntryPrice) && exEntryPrice > 0) {
                fillPrice = exEntryPrice;
                priceSource = 'exchange_position';
                logger.info(`[Place TP/SL] ✅ Got entry price from exchange position data: ${fillPrice}`);
              }
            }
          }
        } catch (e) {
          logger.debug(`[Place TP/SL] Failed to get entry price from exchange position data: ${e?.message || e}`);
        }
      }
      
      // Method 3: Fallback to DB entry_price
      if (!fillPrice || !Number.isFinite(fillPrice) || fillPrice <= 0) {
        if (position.entry_price && Number.isFinite(Number(position.entry_price)) && Number(position.entry_price) > 0) {
          fillPrice = Number(position.entry_price);
          priceSource = 'db_entry_price';
          logger.info(
            `[Place TP/SL] Using entry_price from DB for position ${position.id} ` +
            `(order_id=${position.order_id || 'null'}, synced position or order not found): ${fillPrice}`
          );
        } else {
          logger.warn(`[Place TP/SL] Could not get fill price for position ${position.id} (order_id=${position.order_id || 'null'}), will retry.`);
          // Release lock before returning
          await this._releasePositionLock(position.id);
          return;
        }
      }
      
      // OPTIMIZATION: Verify entry price accuracy and update if needed
      // If price from exchange differs significantly from DB, update DB
      const dbEntryPrice = Number(position.entry_price || 0);
      if (dbEntryPrice > 0 && fillPrice > 0 && priceSource !== 'db_entry_price') {
        const priceDiffPercent = Math.abs((fillPrice - dbEntryPrice) / dbEntryPrice) * 100;
        if (priceDiffPercent > 1) { // More than 1% difference
          logger.warn(
            `[Place TP/SL] ⚠️ Entry price mismatch for position ${position.id}: ` +
            `DB=${dbEntryPrice.toFixed(8)}, ${priceSource}=${fillPrice.toFixed(8)}, diff=${priceDiffPercent.toFixed(2)}%`
          );
          // Update DB with accurate price
          await Position.update(position.id, { entry_price: fillPrice });
          position.entry_price = fillPrice;
          logger.info(`[Place TP/SL] ✅ Updated position ${position.id} entry_price from ${dbEntryPrice.toFixed(8)} to ${fillPrice.toFixed(8)} (source: ${priceSource})`);
        } else if (priceSource === 'order_fill' || priceSource === 'exchange_position') {
          // Always update if we got price from exchange (more accurate)
          await Position.update(position.id, { entry_price: fillPrice });
          position.entry_price = fillPrice;
          logger.debug(`[Place TP/SL] Updated position ${position.id} with verified entry price: ${fillPrice} (source: ${priceSource})`);
        }
      } else if (priceSource === 'order_fill' || priceSource === 'exchange_position') {
        // Update if we got price from exchange and DB doesn't have it
        await Position.update(position.id, { entry_price: fillPrice });
        position.entry_price = fillPrice;
        logger.info(`[Place TP/SL] Updated position ${position.id} with entry price: ${fillPrice} (source: ${priceSource})`);
      }

      // Get strategy to access oc, take_profit, stoploss
      const strategy = await Strategy.findById(position.strategy_id);
      if (!strategy) {
        logger.warn(`[Place TP/SL] Strategy ${position.strategy_id} not found for position ${position.id}`);
        // Release lock before returning
        await this._releasePositionLock(position.id);
        return;
      }

      // Recalculate TP/SL based on the real entry price
      const { calculateTakeProfit, calculateInitialStopLoss, calculateInitialStopLossByAmount } = await import('../utils/calculator.js');
      const oc = strategy.oc || position.oc || 1; // Fallback to position.oc if available, then default to 1
      
      // CRITICAL FIX: Don't fallback to 50 if strategy.take_profit is explicitly 0 (disabled)
      // Only use fallback if take_profit is undefined/null, not if it's 0
      let takeProfit;
      if (strategy.take_profit !== undefined && strategy.take_profit !== null) {
        takeProfit = Number(strategy.take_profit);
      } else if (position.take_profit !== undefined && position.take_profit !== null) {
        takeProfit = Number(position.take_profit);
      } else {
        takeProfit = 50; // Default only if both are undefined/null
      }
      
      // If take_profit is 0 or invalid, skip TP calculation
      if (!Number.isFinite(takeProfit) || takeProfit <= 0) {
        logger.warn(`[Place TP/SL] Invalid take_profit (${takeProfit}) for position ${position.id}, skipping TP order placement`);
        takeProfit = null;
      }
      
      // CRITICAL FIX: Use trailing TP from DB if available, otherwise calculate initial TP
      // This ensures we use the latest trailing TP price, not the initial TP
      let tpPrice = null;
      if (position.take_profit_price && Number.isFinite(Number(position.take_profit_price)) && Number(position.take_profit_price) > 0) {
        // Use trailing TP from DB (already calculated by PositionService.updatePosition)
        tpPrice = Number(position.take_profit_price);
        logger.info(
          `[Place TP/SL] ✅ Using trailing TP from DB | pos=${position.id} ` +
          `take_profit_price=${tpPrice} (from DB, already trailing) timestamp=${new Date().toISOString()}`
        );
      } else if (takeProfit) {
        // Calculate initial TP if not available in DB
        tpPrice = calculateTakeProfit(fillPrice, takeProfit, position.side);
        logger.info(
          `[Place TP/SL] 📊 Calculated initial TP | pos=${position.id} ` +
          `tpPrice=${tpPrice} (calculated from strategy) timestamp=${new Date().toISOString()}`
        );
      }
      
      // Get the exact quantity of the position first (needed for SL calculation)
      // CRITICAL FIX: Skip positions without closable quantity immediately (no retry)
      // These positions are likely already closed on exchange but not synced in DB
      const quantity = await exchangeService.getClosableQuantity(position.symbol, position.side);
      if (!quantity || quantity <= 0) {
        logger.warn(
          `[Place TP/SL] ⚠️ No closable quantity found for position ${position.id} (${position.symbol}), ` +
          `position likely already closed on exchange. Skipping TP/SL placement (will be synced by PositionSync).`
        );

        // CRITICAL: Mark position as needing sync (don't retry TP/SL placement)
        try {
          await Position.update(position.id, {
            tp_sl_pending: false // Clear pending flag to prevent retry loops
          });
        } catch (e) {
          // Ignore if column doesn't exist
        }

        // Release lock before returning
        await this._releasePositionLock(position.id);
        return;
      }

      // ✅ Reconcile DB amount with on-exchange position size to avoid ReduceOnly rejections
      // `amount` in DB is USDT notional; exchange position size is in base-asset quantity.
      // If DB notional drifts, downstream TP/SL fallback may derive wrong quantity.
      try {
        const markPriceForNotional = Number(position.entry_price || fillPrice || 0);
        if (Number.isFinite(markPriceForNotional) && markPriceForNotional > 0) {
          const exchangeNotional = Number(quantity) * markPriceForNotional;
          const dbNotional = Number(position.amount || 0);
          const diffPct = dbNotional > 0 ? Math.abs(exchangeNotional - dbNotional) / dbNotional * 100 : 0;

          const reconcilePct = Number(configService.getNumber('POSITION_SIZE_RECONCILE_DIFF_PCT', 5)); // default 5%
          if (!Number.isFinite(reconcilePct) || reconcilePct < 0) {
            // no-op
          } else if (!dbNotional || !Number.isFinite(dbNotional) || dbNotional <= 0 || diffPct >= reconcilePct) {
            await Position.update(position.id, { amount: exchangeNotional });
            position.amount = exchangeNotional;
            logger.warn(
              `[Place TP/SL] 🔄 Reconciled DB amount using exchange qty | pos=${position.id} symbol=${position.symbol} ` +
              `qty=${Number(quantity).toFixed(8)} price=${markPriceForNotional.toFixed(8)} ` +
              `dbAmount=${Number(dbNotional || 0).toFixed(4)} newAmount=${exchangeNotional.toFixed(4)} diff=${diffPct.toFixed(2)}%`
            );
          }
        }
      } catch (e) {
        logger.debug(`[Place TP/SL] Size reconcile failed (non-blocking) | pos=${position.id} error=${e?.message || e}`);
      }

      // Attach preferred exit quantity to this position object so ExitOrderManager/BinanceDirectClient can use it
      // (helps avoid ReduceOnly order rejected due to stale DB sizing)
      position.preferred_exit_qty = quantity;

      // Only set SL if strategy.stoploss > 0. No fallback to reduce/up_reduce
      // NEW: stoploss is now in USDT (not percentage), need quantity to calculate SL price
      const rawStoploss = strategy.stoploss !== undefined ? Number(strategy.stoploss) : (position.stoploss !== undefined ? Number(position.stoploss) : NaN);
      const isStoplossValid = Number.isFinite(rawStoploss) && rawStoploss > 0;
      
      // Check quantity mismatch with DB amount BEFORE calculating SL
      // CRITICAL: If quantity differs significantly, actual loss will differ from slAmount
      const dbAmount = parseFloat(position.amount || 0);
      const markPrice = parseFloat(position.entry_price || fillPrice || 0);
      const estimatedQuantity = markPrice > 0 ? dbAmount / markPrice : 0;
      const quantityDiffPercent = estimatedQuantity > 0 ? Math.abs((quantity - estimatedQuantity) / estimatedQuantity) * 100 : 0;
      
      let slPrice = null;
      let quantityToUse = quantity; // Default: use exchange quantity
      
      if (isStoplossValid) {
        // CRITICAL FIX: If quantity mismatch > 10%, use estimated quantity to ensure loss = slAmount
        // This prevents actual loss from exceeding the set slAmount
        if (quantityDiffPercent > 10 && estimatedQuantity > 0) {
          logger.warn(
            `[Place TP/SL] ⚠️ Quantity mismatch detected for position ${position.id}: ` +
            `DB estimated=${estimatedQuantity.toFixed(4)}, Exchange=${quantity.toFixed(4)}, diff=${quantityDiffPercent.toFixed(2)}% ` +
            `Using estimated quantity to ensure SL loss matches set amount (${rawStoploss} USDT)`
          );
          
          // Use estimated quantity to calculate SL (ensures loss = slAmount)
          quantityToUse = estimatedQuantity;
          slPrice = calculateInitialStopLossByAmount(fillPrice, quantityToUse, rawStoploss, position.side);
          
          if (slPrice) {
            // Calculate what the actual loss would be with exchange quantity
            const actualLossWithExchangeQty = Math.abs(slPrice - fillPrice) * quantity;
            const lossDiff = actualLossWithExchangeQty - rawStoploss;
            
            logger.warn(
              `[Place TP/SL] 🔄 Recalculated SL using estimated quantity | ` +
              `pos=${position.id} slPrice=${slPrice.toFixed(8)} ` +
              `(if exchange qty used, actual loss would be ${actualLossWithExchangeQty.toFixed(2)} USDT, diff=${lossDiff.toFixed(2)} USDT)`
            );
          }
        } else {
          // Quantity matches or difference is small, safe to use exchange quantity
          slPrice = calculateInitialStopLossByAmount(fillPrice, quantityToUse, rawStoploss, position.side);
        }
      }

      // Place TP order if needed and tpPrice is valid
      if (needsTp && tpPrice && Number.isFinite(tpPrice) && tpPrice > 0) {
        try {
          // CRITICAL: Only update initial_tp_price if it's not already set (preserve original initial TP)
          const currentPosition = await Position.findById(position.id);
          const shouldPreserveInitialTP = currentPosition?.initial_tp_price && 
                                          Number.isFinite(Number(currentPosition.initial_tp_price)) && 
                                          Number(currentPosition.initial_tp_price) > 0;
          
          // ✅ Unified exit order: type switches based on profit/loss zone (STOP_MARKET <-> TAKE_PROFIT_MARKET)
          const { ExitOrderManager } = await import('../services/ExitOrderManager.js');
          const mgr = new ExitOrderManager(exchangeService);
          
          logger.info(
            `[Place TP/SL] 🚀 Calling ExitOrderManager.placeOrReplaceExitOrder | pos=${position.id} ` +
            `symbol=${position.symbol} side=${position.side} tpPrice=${tpPrice} ` +
            `currentExitOrderId=${position.exit_order_id || 'NULL'} timestamp=${new Date().toISOString()}`
          );
          
          const placed = await mgr.placeOrReplaceExitOrder(position, tpPrice);

          // CRITICAL FIX: After replacement, the new order ID must be persisted immediately.
          // The 'placed' object contains the new orderId. We must update the DB here.
          if (placed && placed.orderId) {
            await Position.update(position.id, { exit_order_id: placed.orderId });
            position.exit_order_id = placed.orderId; // Update in-memory object as well
            logger.info(`[Place TP/SL] ✅ Successfully updated exit_order_id to ${placed.orderId} for pos=${position.id} after replacement.`);
          }
          
          // CRITICAL: Check if ExitOrderManager signals to close position immediately
          // This happens when price has already exceeded initial TP before order placement
          if (placed?.shouldCloseImmediately === true) {
            logger.warn(
              `[Place TP/SL] 🚨 Price exceeded initial TP before order placement | pos=${position.id} ` +
              `desiredTP=${placed.desiredTP?.toFixed(8) || tpPrice} currentPrice=${placed.currentPrice?.toFixed(8)} ` +
              `side=${position.side} reason=${placed.reason || 'price_exceeded_initial_tp'} ` +
              `→ Closing position immediately with MARKET order`
            );
            
            // Release lock before closing
            await this._releasePositionLock(position.id);
            
            // Close position immediately using PositionService
            try {
              const positionService = this.positionServices.get(position.bot_id);
              if (!positionService) {
                logger.error(`[Place TP/SL] PositionService not found for bot ${position.bot_id}, cannot close position ${position.id}`);
                return;
              }
              
              // Calculate PnL for the close
              const { calculatePnL } = await import('../utils/calculator.js');
              const currentPnl = calculatePnL(
                position.entry_price,
                placed.currentPrice,
                position.amount,
                position.side
              );
              
              // Close position with proper reason
              const closedPosition = await positionService.closePosition(
                position,
                placed.currentPrice,
                currentPnl,
                'price_exceeded_initial_tp'
              );
              
              logger.info(
                `[Place TP/SL] ✅ Position ${position.id} closed immediately | ` +
                `price=${placed.currentPrice?.toFixed(8)} pnl=${currentPnl.toFixed(2)} ` +
                `reason=price_exceeded_initial_tp`
              );
              
              return; // Exit early, position is closed
            } catch (closeError) {
              logger.error(
                `[Place TP/SL] ❌ Failed to close position immediately | pos=${position.id} ` +
                `error=${closeError?.message || closeError} stack=${closeError?.stack || 'N/A'}`
              );
              // Continue to try placing TP order as fallback (though it may fail)
            }
          }
          
          const tpOrderId = placed?.orderId ? String(placed.orderId) : null;
          // Use adjusted stopPrice if available (for trailing TP), otherwise use original tpPrice
          const finalTPPrice = placed?.stopPrice && Number.isFinite(Number(placed.stopPrice)) 
            ? Number(placed.stopPrice) 
            : tpPrice;
          
          logger.info(
            `[Place TP/SL] 📋 ExitOrderManager returned | pos=${position.id} ` +
            `tpOrderId=${tpOrderId || 'NULL'} orderType=${placed?.orderType || 'N/A'} ` +
            `stopPrice=${finalTPPrice.toFixed(8)} (original=${tpPrice.toFixed(8)}) timestamp=${new Date().toISOString()}`
          );
          
          if (tpOrderId) {
            // Store initial TP price for trailing calculation (only if not already set)
            // CRITICAL: Only include tp_sl_pending if column exists (backward compatibility)
            // Use finalTPPrice (may be adjusted for trailing TP) instead of original tpPrice
            const updateData = { 
              exit_order_id: tpOrderId, 
              take_profit_price: finalTPPrice
            };
            if (!shouldPreserveInitialTP) {
              updateData.initial_tp_price = tpPrice; // Only set if not already set
            }
            
            // Only set tp_sl_pending if Position model supports it (check rawAttributes)
            if (Position?.rawAttributes?.tp_sl_pending) {
              updateData.tp_sl_pending = false; // Clear pending flag after successful EXIT placement
            }
            
            logger.info(
              `[Place TP/SL] 💾 Updating DB with exit_order_id | pos=${position.id} ` +
              `exit_order_id=${tpOrderId} take_profit_price=${finalTPPrice.toFixed(8)} ` +
              `initial_tp_price=${updateData.initial_tp_price || 'preserved'} ` +
              `tp_sl_pending=${updateData.tp_sl_pending !== undefined ? updateData.tp_sl_pending : 'N/A (column not supported)'} ` +
              `timestamp=${new Date().toISOString()}`
            );
            
            try {
            await Position.update(position.id, updateData);
              logger.info(
                `[Place TP/SL] ✅ Placed EXIT order ${tpOrderId} for position ${position.id} @ ${finalTPPrice.toFixed(8)} ` +
                `${shouldPreserveInitialTP ? '(preserved initial TP)' : '(initial TP)'} ` +
                `${finalTPPrice !== tpPrice ? `(adjusted from ${tpPrice.toFixed(8)} due to trailing TP)` : ''} ` +
                `timestamp=${new Date().toISOString()}`
              );
            
            // CRITICAL: If TP is placed but SL is still needed, ensure SL will be created
            // Don't clear tp_sl_pending if SL is still missing
            if (needsSl && (!position.sl_order_id || position.sl_order_id.trim() === '')) {
              logger.warn(
                `[Place TP/SL] ⚠️ TP placed but SL still missing for position ${position.id}. ` +
                `Will attempt to create SL after delay.`
              );
            }
              
              // CRITICAL FIX: Run dedupe AFTER successfully creating new order to clean up old duplicate orders
              // This ensures new order exists before cancelling old ones, preventing miss hit TP
              try {
                const exchangeService = this.exchangeServices.get(position.bot_id);
                if (exchangeService && exchangeService.bot?.exchange === 'binance') {
                  // Refresh position to get latest exit_order_id
                  const refreshedPosition = await Position.findById(position.id);
                  if (refreshedPosition) {
                    await this._dedupeCloseOrdersOnExchange(exchangeService, refreshedPosition);
                  }
                }
              } catch (dedupeError) {
                // Non-critical: dedupe failure doesn't affect order placement
                logger.debug(`[Place TP/SL] Dedupe after order creation skipped/failed for position ${position.id}: ${dedupeError?.message || dedupeError}`);
              }
            } catch (dbError) {
              // If error is about missing column, retry without that column
              if (dbError?.message?.includes("Unknown column") || dbError?.message?.includes("tp_sl_pending")) {
                logger.warn(
                  `[Place TP/SL] ⚠️ DB column error, retrying without tp_sl_pending | pos=${position.id} ` +
                  `error=${dbError?.message || dbError} timestamp=${new Date().toISOString()}`
                );
                const retryData = { 
                  exit_order_id: tpOrderId, 
                  take_profit_price: finalTPPrice
                };
                if (!shouldPreserveInitialTP) {
                  retryData.initial_tp_price = finalTPPrice;
                }
                // Retry without tp_sl_pending
                await Position.update(position.id, retryData);
                logger.info(
                  `[Place TP/SL] ✅ Retry successful: Placed EXIT order ${tpOrderId} for position ${position.id} @ ${finalTPPrice.toFixed(8)} ` +
                  `(without tp_sl_pending column) timestamp=${new Date().toISOString()}`
                );
              } else {
                logger.error(
                  `[Place TP/SL] ❌ DB UPDATE FAILED after order creation! | pos=${position.id} ` +
                  `tpOrderId=${tpOrderId} error=${dbError?.message || dbError} ` +
                  `stack=${dbError?.stack || 'N/A'} timestamp=${new Date().toISOString()}`
                );
                // CRITICAL: Order was created on exchange but DB update failed!
                // This will cause the order to be cancelled by dedupe on next run
                throw new Error(`DB update failed after order creation: ${dbError?.message || dbError}`);
              }
            }
          } else {
            // Order creation returned null (e.g., price too close to market)
            // Use finalTPPrice (may be adjusted for trailing TP) instead of original tpPrice
            logger.warn(
              `[Place TP/SL] ⚠️ TP order creation returned null for position ${position.id} @ ${finalTPPrice.toFixed(8)}. ` +
              `Updating TP price in DB only. timestamp=${new Date().toISOString()}`
            );
            const updateData = { take_profit_price: finalTPPrice };
            if (!shouldPreserveInitialTP) {
              updateData.initial_tp_price = finalTPPrice; // Only set if not already set
            }
            await Position.update(position.id, updateData);
          }
        } catch (e) {
          // If TP order creation fails, still update take_profit_price in DB
          // This allows trailing TP to work even if orders can't be placed
          logger.error(
            `[Place TP/SL] ❌ EXCEPTION in TP order placement | pos=${position.id} ` +
            `error=${e?.message || e} stack=${e?.stack || 'N/A'} ` +
            `timestamp=${new Date().toISOString()}`
          );
          // Use finalTPPrice if available (may be adjusted for trailing TP), otherwise use original tpPrice
          const fallbackTPPrice = placed?.stopPrice && Number.isFinite(Number(placed.stopPrice))
            ? Number(placed.stopPrice)
            : tpPrice;
          
          logger.warn(
            `[Place TP/SL] Updating TP price in DB to ${fallbackTPPrice.toFixed(8)} for position ${position.id} ` +
            `(order may have been created on exchange but DB update failed - check logs above) ` +
            `timestamp=${new Date().toISOString()}`
          );

          // SELF-HEALING: If error is -2022, check if position is already closed
          const errorMsg = e?.message || String(e);
          if (errorMsg.includes('-2022') || errorMsg.includes('ReduceOnly')) {
            try {
              const exchangeService = this.exchangeServices.get(position.bot_id);
              if (exchangeService) {
                const positions = await exchangeService.getOpenPositions();
                const pos = Array.isArray(positions) 
                  ? positions.find(p => (p.symbol || p.info?.symbol) === position.symbol && 
                                       Math.abs(parseFloat(p.positionAmt || p.contracts || 0)) > 0)
                  : null;
                
                if (!pos || Math.abs(parseFloat(pos.positionAmt || pos.contracts || 0)) === 0) {
                  logger.info(
                    `[Place TP/SL] Position ${position.id} (${position.symbol}) already closed on exchange. ` +
                    `TP creation failed with -2022, but position is safe. Updating local status to 'closed'.`
                  );
                  await Position.update(position.id, { 
                    status: 'closed', 
                    close_reason: 'sync_closed_on_exchange',
                    closed_at: new Date(),
                    tp_sl_pending: false
                  });
                  // Release lock and exit early
                  await this._releasePositionLock(position.id);
                  return;
                }
              }
            } catch (verifyError) {
              logger.warn(`[Place TP/SL] Could not verify position state after -2022 error on TP placement: ${verifyError?.message || verifyError}`);
            }
          }

          try {
            const currentPosition = await Position.findById(position.id);
            const shouldPreserveInitialTP = currentPosition?.initial_tp_price && 
                                            Number.isFinite(Number(currentPosition.initial_tp_price)) && 
                                            Number(currentPosition.initial_tp_price) > 0;
            const updateData = { take_profit_price: fallbackTPPrice };
            if (!shouldPreserveInitialTP) {
              updateData.initial_tp_price = fallbackTPPrice; // Only set if not already set
            }
            await Position.update(position.id, updateData);
          } catch (updateError) {
            logger.error(`[Place TP/SL] Failed to update TP price in DB:`, updateError?.message || updateError);
          }
        }
      } else if (needsTp && (!tpPrice || !Number.isFinite(tpPrice) || tpPrice <= 0)) {
        logger.error(
          `[Place TP/SL] ❌ CRITICAL: Cannot place TP order for position ${position.id}: invalid tpPrice (${tpPrice}). ` +
          `Position is exposed to unlimited loss risk! Strategy take_profit=${strategy?.take_profit || 'N/A'}, ` +
          `position.take_profit=${position?.take_profit || 'N/A'}. Please check strategy configuration.`
        );
        // CRITICAL: Even if TP cannot be placed, we should still try to place SL if possible
        // This is better than having no protection at all
      }

      // OPTIMIZATION: Place TP and SL in parallel (no delay needed by default)
      // Binance supports concurrent order placement, and parallel placement is faster
      // Only use delay if explicitly configured (for backward compatibility or rate limit concerns)
      const delayMs = configService.getNumber('TP_SL_PLACEMENT_DELAY_MS', 0); // Default: 0 (parallel placement)
      
      // Place SL order (only if slPrice is valid, i.e., stoploss > 0)
      // If delay is 0, place immediately (parallel with TP that was already placed above)
      if (needsSl && slPrice !== null && Number.isFinite(slPrice) && slPrice > 0) {
        // Add delay only if configured (for backward compatibility)
        if (delayMs > 0) {
          logger.debug(`[Place TP/SL] Waiting ${delayMs}ms before placing SL order for position ${position.id}...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        // Safety check: If SL is invalid (SL <= entry for SHORT or SL >= entry for LONG), force close position immediately
        const entryPrice = Number(fillPrice);
        const slPriceNum = Number(slPrice);
        if (Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(slPriceNum) && slPriceNum > 0) {
          const isInvalidSL = (position.side === 'short' && slPriceNum <= entryPrice) || 
                             (position.side === 'long' && slPriceNum >= entryPrice);
          
          if (isInvalidSL) {
            logger.warn(`[Place TP/SL] Invalid SL detected for position ${position.id}: SL=${slPriceNum}, Entry=${entryPrice}, Side=${position.side}. Force closing position immediately to minimize risk.`);
            
            // Cancel TP order if any (invalid SL detected, must close position immediately)
            if (position.exit_order_id) {
              try {
                await exchangeService.cancelOrder(position.exit_order_id, position.symbol);
                logger.info(`[Place TP/SL] Cancelled TP order ${position.exit_order_id} for position ${position.id} (invalid SL detected)`);
              } catch (e) {
                logger.warn(`[Place TP/SL] Failed to cancel TP order ${position.exit_order_id}: ${e?.message || e}`);
              }
            }
            
            // Force close position immediately with market order
            // REUSE existing PositionService instance instead of creating new one
            const positionService = this.positionServices.get(position.bot_id);
            if (!positionService) {
              logger.error(`[Place TP/SL] PositionService not found for bot ${position.bot_id}, cannot force close position ${position.id}`);
              await this._releasePositionLock(position.id);
              return;
            }
            const currentPrice = await exchangeService.getTickerPrice(position.symbol);
            const pnl = positionService.calculatePnL(position, currentPrice);
            await positionService.closePosition(position, currentPrice, pnl, 'sl_invalid');
            await this._releasePositionLock(position.id);
            return; // Exit early, position is closed
          }
        }
        
        try {
          const slRes = await exchangeService.createStopLossLimit(position.symbol, position.side, slPrice, quantity);
          const slOrderId = slRes?.orderId ? String(slRes.orderId) : null;
          if (slOrderId) {
            // Clear tp_sl_pending flag if both TP and SL are now placed
            const currentPosition = await Position.findById(position.id);
            const hasTP = currentPosition?.exit_order_id && currentPosition.exit_order_id.trim() !== '';
            const updateData = { 
              sl_order_id: slOrderId, 
              stop_loss_price: slPrice 
            };
            // Clear pending flag if both TP and SL are placed (only if column exists)
            if (hasTP && Position?.rawAttributes?.tp_sl_pending) {
              updateData.tp_sl_pending = false;
            }
            await Position.update(position.id, updateData);
            logger.debug(`[Place TP/SL] ✅ Placed SL order ${slOrderId} for position ${position.id} @ ${slPrice}`);
            
            // CRITICAL FIX: Run dedupe AFTER successfully creating SL order to clean up old duplicate orders
            try {
              const exchangeService = this.exchangeServices.get(position.bot_id);
              if (exchangeService && exchangeService.bot?.exchange === 'binance') {
                // Refresh position to get latest sl_order_id
                const refreshedPosition = await Position.findById(position.id);
                if (refreshedPosition) {
                  await this._dedupeCloseOrdersOnExchange(exchangeService, refreshedPosition);
                }
              }
            } catch (dedupeError) {
              // Non-critical: dedupe failure doesn't affect order placement
              logger.debug(`[Place TP/SL] Dedupe after SL creation skipped/failed for position ${position.id}: ${dedupeError?.message || dedupeError}`);
            }
          }
        } catch (e) {
          const errorMsg = e?.message || String(e);
          logger.error(
            `[Place TP/SL] ❌ CRITICAL: Failed to create SL order for position ${position.id}: ${errorMsg}. ` +
            `Position is exposed to unlimited loss risk! Will retry on next cycle.`
          );
          
          // CRITICAL: Handle Binance API Error -2022 gracefully
          // This error can occur when position is already closed or reduced
          if (errorMsg.includes('-2022') || errorMsg.includes('ReduceOnly')) {
            try {
              // Verify if position still exists on exchange
              const exchangeService = this.exchangeServices.get(position.bot_id);
              if (exchangeService) {
                const positions = await exchangeService.getOpenPositions();
                const pos = Array.isArray(positions) 
                  ? positions.find(p => (p.symbol || p.info?.symbol) === position.symbol && 
                                       Math.abs(parseFloat(p.positionAmt || p.contracts || 0)) > 0)
                  : null;
                
                if (!pos || Math.abs(parseFloat(pos.positionAmt || pos.contracts || 0)) === 0) {
                  logger.info(
                    `[Place TP/SL] Position ${position.id} (${position.symbol}) already closed/reduced on exchange. ` +
                    `SL creation failed but position is safe. Updating local status to 'closed'.`
                  );
                  // SELF-HEALING: Mark position as closed in DB to prevent retry loops
                  await Position.update(position.id, { 
                    status: 'closed', 
                    close_reason: 'sync_closed_on_exchange',
                    closed_at: new Date(),
                    tp_sl_pending: false // Ensure no more retries
                  });
                  return;
                }
              }
            } catch (verifyError) {
              logger.warn(`[Place TP/SL] Could not verify position state after -2022 error: ${verifyError?.message || verifyError}`);
            }
          }
          
          // CRITICAL: Set tp_sl_pending to true to ensure retry on next cycle
          try {
            if (Position?.rawAttributes?.tp_sl_pending) {
              await Position.update(position.id, { tp_sl_pending: true });
            }
          } catch (updateError) {
            logger.debug(`[Place TP/SL] Could not set tp_sl_pending flag for retry: ${updateError?.message || updateError}`);
          }
        }
      } else if (slPrice === null || slPrice <= 0) {
        // If strategy has no stoploss configured, this is expected behavior
        logger.debug(`[Place TP/SL] Skipping SL order placement for position ${position.id} (stoploss <= 0 or not set in strategy)`);
      }
    } catch (error) {
      logger.error(`[Place TP/SL] Error processing TP/SL for position ${position.id}:`, error?.message || error, error?.stack);
    } finally {
      // Always release lock in finally block
      await this._releasePositionLock(position.id);
    }
  }

  /**
   * Release soft lock for position
   * @param {number} positionId - Position ID
   */
  async _releasePositionLock(positionId) {
    try {
      const { pool } = await import('../config/database.js');
      await pool.execute(
        `UPDATE positions SET is_processing = 0 WHERE id = ?`,
        [positionId]
      );
    } catch (e) {
      // Ignore errors (column may not exist for backward compatibility)
      logger.debug(`[Place TP/SL] Could not release lock for position ${positionId}: ${e?.message || e}`);
    }
  }

  /**
   * Binance-only: remove duplicated close orders (TP/SL) to avoid order spam / Binance open-order limits.
   * Keeps at most 1 unified STOP_MARKET exit order (tracked by position.exit_order_id) and 1 STOP order (only if strategy stoploss enabled).
   * Also tries to keep the orders referenced by position.exit_order_id / position.sl_order_id (if present).
   * CRITICAL: Never cancels SL orders if strategy has stoploss > 0 (hard SL requirement).
   */
  async _dedupeCloseOrdersOnExchange(exchangeService, position) {
    const symbol = position.symbol;
    const side = position.side;
    const desiredPositionSide = side === 'long' ? 'LONG' : 'SHORT';
    const timestamp = new Date().toISOString();

    // CRITICAL FIX: Check if strategy has hard SL requirement (stoploss > 0)
    // If yes, we must NEVER cancel SL orders, only cancel duplicate TP orders
    let hasHardSL = false;
    try {
      const strategy = await Strategy.findById(position.strategy_id);
      if (strategy) {
        const rawStoploss = strategy.stoploss !== undefined ? Number(strategy.stoploss) : NaN;
        hasHardSL = Number.isFinite(rawStoploss) && rawStoploss > 0;
        if (hasHardSL) {
          logger.info(
            `[Dedupe] 🛡️ Strategy ${strategy.id} has hard SL requirement (stoploss=${rawStoploss} USDT). ` +
            `Will NOT cancel any SL orders, only dedupe TP orders. | pos=${position.id}`
          );
        }
      }
    } catch (e) {
      logger.debug(`[Dedupe] Could not check strategy for hard SL: ${e?.message || e} | pos=${position.id}`);
    }

    logger.debug(
      `[Dedupe] 🔍 Starting dedupe check | pos=${position.id} symbol=${symbol} side=${side} ` +
      `exit_order_id=${position.exit_order_id || 'NULL'} sl_order_id=${position.sl_order_id || 'NULL'} ` +
      `hasHardSL=${hasHardSL} timestamp=${timestamp}`
    );

    const openOrders = await exchangeService.getOpenOrders(symbol);
    if (!Array.isArray(openOrders) || openOrders.length <= 1) {
      logger.debug(`[Dedupe] ⏭️  SKIP: ${openOrders?.length || 0} open orders (<=1), no dedupe needed | pos=${position.id}`);
      return;
    }

    logger.debug(`[Dedupe] 📋 Found ${openOrders.length} total open orders on exchange | pos=${position.id} symbol=${symbol}`);

    // Only consider close / reduce-only style orders
    const reduceOnlyOrders = openOrders.filter(o => {
      const isReduceOnly = o?.reduceOnly === true || o?.reduceOnly === 'true';
      const isClosePosition = o?.closePosition === true || o?.closePosition === 'true';
      const type = String(o?.type || '').toUpperCase();
      const isTpOrStop = type === 'STOP_MARKET' || type === 'TAKE_PROFIT_MARKET' || type === 'STOP' || type === 'STOP_LOSS' || type === 'STOP_LOSS_LIMIT';
      // Some responses don't include reduceOnly flag but include closePosition
      return (isReduceOnly || isClosePosition) && isTpOrStop;
    });

    logger.debug(
      `[Dedupe] 🔍 Filtered to ${reduceOnlyOrders.length} reduce-only close orders | pos=${position.id} ` +
      `(types: ${reduceOnlyOrders.map(o => o?.type).join(', ')})`
    );

    if (reduceOnlyOrders.length <= 2) {
      logger.debug(`[Dedupe] ⏭️  SKIP: ${reduceOnlyOrders.length} reduce-only orders (<=2), no dedupe needed | pos=${position.id}`);
      return;
    }

    // Match positionSide if present (hedge mode)
    const scoped = reduceOnlyOrders.filter(o => {
      const ps = String(o?.positionSide || '').toUpperCase();
      return !ps || ps === desiredPositionSide;
    });

    logger.debug(
      `[Dedupe] 🎯 Scoped to ${scoped.length} orders matching positionSide=${desiredPositionSide} | pos=${position.id} ` +
      `(orderIds: ${scoped.map(o => o?.orderId).join(', ')})`
    );

    if (scoped.length <= 2) {
      logger.debug(`[Dedupe] ⏭️  SKIP: ${scoped.length} scoped orders (<=2), no dedupe needed | pos=${position.id}`);
      return;
    }

    // Unified exit order types
    const exitTypes = new Set(['STOP_MARKET', 'TAKE_PROFIT_MARKET']);
    const stopTypes = new Set(['STOP', 'STOP_LOSS', 'STOP_LOSS_LIMIT']);

    const keepIds = new Set();
    if (position.exit_order_id) {
      keepIds.add(String(position.exit_order_id));
      logger.debug(`[Dedupe] ✅ Keeping exit_order_id from DB: ${position.exit_order_id} | pos=${position.id}`);
    } else {
      logger.warn(
        `[Dedupe] ⚠️  WARNING: exit_order_id is NULL in DB but found ${scoped.length} exit orders on exchange! ` +
        `This may indicate a race condition or order was created but DB not updated. ` +
        `Will keep newest exit order to avoid cancelling valid order. | pos=${position.id}`
      );
    }
    if (position.sl_order_id) {
      keepIds.add(String(position.sl_order_id));
      logger.debug(`[Dedupe] ✅ Keeping sl_order_id from DB: ${position.sl_order_id} | pos=${position.id}`);
    }

    const byTimeAsc = [...scoped].sort((a, b) => Number(a?.time || a?.updateTime || a?.origTime || 0) - Number(b?.time || b?.updateTime || b?.origTime || 0));

    const exits = byTimeAsc.filter(o => exitTypes.has(String(o?.type || '').toUpperCase()));
    const stops = byTimeAsc.filter(o => stopTypes.has(String(o?.type || '').toUpperCase()));

    logger.debug(
      `[Dedupe] 📊 Categorized orders | pos=${position.id} ` +
      `exits=${exits.length} (${exits.map(o => `${o?.orderId}(${o?.type})`).join(', ')}) ` +
      `stops=${stops.length} (${stops.map(o => `${o?.orderId}(${o?.type})`).join(', ')})`
    );

    // Keep newest order of each class if not explicitly referenced
    const newestExit = exits.length ? exits[exits.length - 1] : null;
    const newestStop = stops.length ? stops[stops.length - 1] : null;
    if (newestExit?.orderId) {
      keepIds.add(String(newestExit.orderId));
      logger.debug(
        `[Dedupe] ✅ Keeping newest exit order: ${newestExit.orderId} (${newestExit.type}) | pos=${position.id} ` +
        `time=${newestExit.time || newestExit.updateTime || 'N/A'}`
      );
    }
    if (newestStop?.orderId) {
      keepIds.add(String(newestStop.orderId));
      logger.debug(
        `[Dedupe] ✅ Keeping newest stop order: ${newestStop.orderId} (${newestStop.type}) | pos=${position.id} ` +
        `time=${newestStop.time || newestStop.updateTime || 'N/A'}`
      );
    }

    const toCancel = scoped.filter(o => !keepIds.has(String(o?.orderId)));
    
    logger.info(
      `[Dedupe] 📋 Dedupe summary | pos=${position.id} symbol=${symbol} ` +
      `total=${scoped.length} keep=${keepIds.size} cancel=${toCancel.length} ` +
      `keepIds=[${Array.from(keepIds).join(', ')}] ` +
      `cancelIds=[${toCancel.map(o => o?.orderId).join(', ')}]`
    );

    if (toCancel.length === 0) {
      logger.debug(`[Dedupe] ✅ No orders to cancel | pos=${position.id}`);
      return;
    }

    // CRITICAL FIX: If exit_order_id is NULL in DB but we found exit orders on exchange,
    // DO NOT cancel them! This indicates the order was just created and DB hasn't been updated yet.
    // Instead, log a warning and skip cancellation for exit orders.
    if (!position.exit_order_id && exits.length > 0) {
      logger.error(
        `[Dedupe] 🚨 CRITICAL: exit_order_id is NULL in DB but found ${exits.length} exit orders on exchange! ` +
        `This is likely a race condition. Will NOT cancel exit orders to avoid data loss. ` +
        `Position ${position.id} needs manual intervention or PositionMonitor.placeExitOrder should be called. ` +
        `Found exit orders: ${exits.map(o => `${o.orderId}(${o.type}@${o.stopPrice || o.price})`).join(', ')}`
      );
      
      // CRITICAL FIX: Only cancel stop orders (SL) if strategy does NOT have hard SL requirement
      // If strategy has hard SL (stoploss > 0), NEVER cancel SL orders
      if (!hasHardSL) {
        const stopOrdersToCancel = toCancel.filter(o => stopTypes.has(String(o?.type || '').toUpperCase()));
        if (stopOrdersToCancel.length > 0) {
          logger.warn(
            `[Dedupe] ⚠️  Will cancel ${stopOrdersToCancel.length} duplicate STOP orders only (not exit orders) | pos=${position.id}`
          );
          for (const o of stopOrdersToCancel) {
            try {
              logger.info(`[Dedupe] 🗑️  Cancelling duplicate STOP order ${o.orderId} (${o.type}) | pos=${position.id} symbol=${symbol}`);
              await exchangeService.cancelOrder(String(o.orderId), symbol);
              logger.info(`[Dedupe] ✅ Cancelled duplicate STOP order ${o.orderId} | pos=${position.id}`);
            } catch (e) {
              logger.error(`[Dedupe] ❌ Failed to cancel duplicate STOP order ${o.orderId}: ${e?.message || e} | pos=${position.id}`);
            }
          }
        }
      } else {
        logger.info(
          `[Dedupe] 🛡️ Strategy has hard SL requirement, skipping cancellation of ${toCancel.filter(o => stopTypes.has(String(o?.type || '').toUpperCase())).length} STOP orders | pos=${position.id}`
        );
      }
      return; // Exit early, don't cancel exit orders
    }

    // CRITICAL FIX: Enable cancellation of duplicate orders to prevent order spam
    // Only cancel if exit_order_id exists in DB (race condition protection above)
    // CRITICAL: If strategy has hard SL requirement, NEVER cancel SL orders, only cancel duplicate TP orders
    const ordersToCancel = hasHardSL 
      ? toCancel.filter(o => exitTypes.has(String(o?.type || '').toUpperCase())) // Only cancel TP orders
      : toCancel; // Cancel all duplicate orders
    
    if (ordersToCancel.length === 0 && toCancel.length > 0) {
      logger.info(
        `[Dedupe] 🛡️ Strategy has hard SL requirement, skipping cancellation of ${toCancel.length} SL orders | pos=${position.id} ` +
        `(only ${toCancel.filter(o => exitTypes.has(String(o?.type || '').toUpperCase())).length} TP orders would be cancelled if any)`
      );
      return; // No orders to cancel
    }
    
    logger.info(
      `[Dedupe] 🗑️  Cancelling ${ordersToCancel.length} duplicate orders | pos=${position.id} symbol=${symbol} ` +
      `${hasHardSL ? '(SL orders protected due to hard SL requirement)' : ''} ` +
      `to enforce 1-exit-order invariant. Orders to cancel: ${ordersToCancel.map(o => `${o.orderId}(${o.type})`).join(', ')}`
    );

    for (const o of ordersToCancel) {
      try {
        const cancelStart = Date.now();
        logger.info(
          `[Dedupe] 🗑️  Cancelling duplicate order ${o.orderId} (${o.type}) | pos=${position.id} ` +
          `symbol=${symbol} stopPrice=${o.stopPrice || o.price || 'N/A'} timestamp=${new Date().toISOString()}`
        );
        await exchangeService.cancelOrder(String(o.orderId), symbol);
        const cancelDuration = Date.now() - cancelStart;
        logger.info(
          `[Dedupe] ✅ Cancelled duplicate order ${o.orderId} | pos=${position.id} ` +
          `duration=${cancelDuration}ms timestamp=${new Date().toISOString()}`
        );
      } catch (e) {
        logger.error(
          `[Dedupe] ❌ Failed to cancel duplicate order ${o.orderId}: ${e?.message || e} | pos=${position.id} ` +
          `stack=${e?.stack || 'N/A'}`
        );
      }
    }
  }

  /**
   * Check for unfilled orders that should be cancelled (candle ended)
   * @param {Object} position - Position object
   */
  async checkUnfilledOrders(position) {
    try {
      // Resolve services
      const strategy = await Strategy.findById(position.strategy_id);
      if (!strategy) return;
      const exchangeService = this.exchangeServices.get(strategy.bot_id);
      const orderService = this.orderServices.get(strategy.bot_id);
      if (!exchangeService || !orderService) return;

      // TTL-based cancellation for ENTRY orders only (not TP/SL orders)
      // IMPORTANT: This only cancels position.order_id (entry order), NOT exit_order_id or sl_order_id
      // EntryOrderMonitor handles entry orders from entry_orders table, but this is a fallback
      // for positions that may still have an unfilled entry order_id
      // TP/SL orders (exit_order_id, sl_order_id) are NEVER cancelled by this TTL
      const ttlMinutes = Number(configService.getNumber('ENTRY_ORDER_TTL_MINUTES', 30));
      const ttlMs = Math.max(1, ttlMinutes) * 60 * 1000;
      const openedAtMs = new Date(position.opened_at).getTime();
      const now = Date.now();

      // Only check position.order_id (entry order), NOT exit_order_id or sl_order_id
      if (position.status === 'open' && position.order_id && now - openedAtMs >= ttlMs) {
        // Check actual order status on exchange to avoid cancelling filled orders
        // This is the ENTRY order, not TP/SL orders
        const st = await exchangeService.getOrderStatus(position.symbol, position.order_id);
        if (st.status === 'open' && (st.filled || 0) === 0) {
          // Only cancel entry order, never cancel TP/SL orders here
          await orderService.cancelOrder(position, 'ttl_expired');
          logger.debug(`[PositionMonitor] Cancelled unfilled ENTRY order (order_id=${position.order_id}, TTL ${ttlMinutes}m) for position ${position.id}. TP/SL orders are NOT affected.`);
          return; // done for this position
        }
      }

      // DEPRECATED: Candle-based safety cancel feature removed (no longer using database candles)
      // This feature is disabled as we no longer store candles in database
      // Orders are now managed by TTL (ENTRY_ORDER_TTL_MINUTES) instead

      // Re-create entry order after manual cancel (binance-mainet) if 2 minutes passed
      if (position.status === 'open' && position.order_id) {
        try {
          const st = await exchangeService.getOrderStatus(position.symbol, position.order_id);
          const reMinutes = Number(configService.getNumber('RECREATE_CANCELED_ENTRY_MINUTES', 2));
          const twoMinutes = Math.max(1, reMinutes) * 60 * 1000;
          if ((st.status === 'canceled' || st.status === 'cancelled') && (st.filled || 0) === 0 && (now - openedAtMs) >= twoMinutes) {
            // Scope to the requested bot name, if available in this query
            if (!position.bot_name || position.bot_name === 'binance-mainet') {
              // Re-create as passive LIMIT at original entry price
              const side = position.side === 'long' ? 'buy' : 'sell';
              const params = {
                symbol: position.symbol,
                side,
                positionSide: position.side === 'long' ? 'LONG' : 'SHORT',
                amount: Number(position.amount), // USDT amount
                type: 'limit',
                price: Number(position.entry_price)
              };
              try {
                const newOrder = await exchangeService.createOrder(params);
                if (newOrder && newOrder.id) {
                  await Position.update(position.id, { order_id: newOrder.id });
                  logger.debug(`Recreated entry order for position ${position.id} (${position.symbol}) after manual cancel. New order_id=${newOrder.id}`);
                }
              } catch (e) {
                logger.warn(`Failed to recreate entry order for position ${position.id}: ${e?.message || e}`);
              }
            }
          }
        } catch (e) {
          logger.debug(`getOrderStatus failed for position ${position.id} during recreate check: ${e?.message || e}`);
        }
      }

    } catch (error) {
      logger.error(`Error checking unfilled orders for position ${position.id}`, { err: error?.message, stack: error?.stack });
    }
  }

  /**
   * Monitor all open positions
   */
  async monitorAllPositions() {
    if (this.isRunning) {
      logger.debug('PositionMonitor already running, skipping...');
      return;
    }

    this.isRunning = true;

    // Reset per-cycle caches
    this._scanCache.clear();
    this._priceCache.clear();
    this._closableQtyCache.clear();
    this._advProcessedThisCycle = 0;

    const cycleStart = Date.now();
    let totalHighPriority = 0;
    let totalLowPriority = 0;
    let totalBotsProcessed = 0;
    let totalPositionsProcessed = 0;
    try {
      const openPositions = await Position.findOpen();
      
      // DEBUG: Log position IDs being monitored (use info level for visibility)
      if (openPositions.length > 0) {
        const positionIds = openPositions.map(p => `${p.id}(${p.symbol})`).join(', ');
        logger.info(`[PositionMonitor] 📋 Found ${openPositions.length} open positions: [${positionIds}]`);
      } else {
        logger.warn(`[PositionMonitor] ⚠️ No open positions found`);
      }
      
      // Ensure WebSocket subscriptions for all position symbols (Binance)
      try {
        const { webSocketManager } = await import('../services/WebSocketManager.js');
        const binanceSymbols = new Set();
        for (const pos of openPositions) {
          if (pos.bot_id) {
            const exchangeService = this.exchangeServices.get(pos.bot_id);
            if (exchangeService && exchangeService.bot?.exchange === 'binance') {
              binanceSymbols.add(pos.symbol.toUpperCase());
            }
          }
        }
        if (binanceSymbols.size > 0) {
          webSocketManager.subscribe(Array.from(binanceSymbols));
          logger.debug(`[PositionMonitor] Ensured WebSocket subscriptions for ${binanceSymbols.size} Binance symbols`);
        }
      } catch (e) {
        logger.debug(`[PositionMonitor] Failed to ensure WebSocket subscriptions: ${e?.message || e}`);
      }

      // CRITICAL FIX: Group positions by bot_id to ensure fair distribution
      // Process each bot's positions in parallel to avoid one bot monopolizing the monitor
      const positionsByBot = new Map();
      for (const pos of openPositions) {
        const botId = pos.bot_id || pos.strategy?.bot_id;
        if (!botId) {
          logger.warn(`[PositionMonitor] Position ${pos.id} has no bot_id, skipping`);
          continue;
        }
        if (!positionsByBot.has(botId)) {
          positionsByBot.set(botId, []);
        }
        positionsByBot.get(botId).push(pos);
      }

      // PRIORITY QUEUE: Sort bots by mainnet/testnet priority
      // Mainnet (binance_testnet=false/null) = priority 1 (highest), Testnet = priority 0 (lower)
      const botEntries = Array.from(positionsByBot.entries());
      botEntries.sort(([botIdA], [botIdB]) => {
        const exchangeServiceA = this.exchangeServices.get(botIdA);
        const exchangeServiceB = this.exchangeServices.get(botIdB);
        const isMainnetA = exchangeServiceA?.bot?.exchange === 'binance' && 
                          (exchangeServiceA.bot.binance_testnet === null || exchangeServiceA.bot.binance_testnet === false || exchangeServiceA.bot.binance_testnet === 0);
        const isMainnetB = exchangeServiceB?.bot?.exchange === 'binance' && 
                          (exchangeServiceB.bot.binance_testnet === null || exchangeServiceB.bot.binance_testnet === false || exchangeServiceB.bot.binance_testnet === 0);
        const priorityA = isMainnetA ? 1 : 0;
        const priorityB = isMainnetB ? 1 : 0;
        return priorityB - priorityA; // Higher priority first (mainnet first)
      });

      const mainnetBots = botEntries.filter(([botId]) => {
        const exchangeService = this.exchangeServices.get(botId);
        return exchangeService?.bot?.exchange === 'binance' && 
               (exchangeService.bot.binance_testnet === null || exchangeService.bot.binance_testnet === false || exchangeService.bot.binance_testnet === 0);
      }).length;
      const testnetBots = botEntries.length - mainnetBots;

      logger.info(
        `[PositionMonitor] 🔄 Processing ${openPositions.length} positions across ${positionsByBot.size} bots ` +
        `(MAINNET: ${mainnetBots}, TESTNET: ${testnetBots}): ` +
        `${botEntries.map(([botId, positions]) => `bot_${botId}=${positions.length}`).join(', ')}`
      );

      // CRITICAL OPTIMIZATION: Separate positions into priority queues
      // High priority: positions without TP/SL (need immediate attention)
      // CRITICAL FIX: Position Age SLA - Emergency TP/SL placement (HARD RULE, không phụ thuộc degrade mode)
      // Low priority: positions with TP/SL (can be monitored less frequently)
      const highPriorityPositions = [];
      const emergencyPositions = []; // Positions that exceed SLA (must be processed IMMEDIATELY)
      const lowPriorityPositions = [];
      const now = Date.now();
      const SAFETY_CHECK_MS = Number(configService.getNumber('POSITION_AGE_SLA_MS', 30000)); // 30 seconds - Position Age SLA
      const EMERGENCY_SLA_MS = Number(configService.getNumber('POSITION_EMERGENCY_SLA_MS', 10 * 1000)); // 10 seconds - Emergency threshold
      
      for (const pos of openPositions) {
        const needsTPSL = !pos.exit_order_id || !pos.sl_order_id || pos.tp_sl_pending === true || pos.tp_sl_pending === 1;
        
        if (pos.opened_at) {
          const openedAt = new Date(pos.opened_at).getTime();
          const timeSinceOpened = now - openedAt;
          
          // 🚨 EMERGENCY SLA: Position > 10s without TP/SL = EMERGENCY (bypass all throttling)
          if (needsTPSL && timeSinceOpened > EMERGENCY_SLA_MS) {
            logger.error(
              `[PositionMonitor] 🚨🚨🚨 EMERGENCY SLA BREACH: Position ${pos.id} (${pos.symbol}) has been open for ${Math.floor(timeSinceOpened / 1000)}s ` +
              `without TP/SL! exit_order_id=${pos.exit_order_id || 'NULL'}, sl_order_id=${pos.sl_order_id || 'NULL'}. ` +
              `EMERGENCY TP/SL placement (bypassing all throttling and degrade mode)!`
            );
            emergencyPositions.push({ ...pos, ageMs: timeSinceOpened });
            continue;
          }
          
          // CRITICAL SAFETY CHECK: If position has been open > 30s without TP/SL, force it to high priority
          if (needsTPSL && timeSinceOpened > SAFETY_CHECK_MS) {
            logger.error(
              `[PositionMonitor] 🚨 CRITICAL: Position ${pos.id} (${pos.symbol}) has been open for ${Math.floor(timeSinceOpened / 1000)}s ` +
              `without TP/SL! exit_order_id=${pos.exit_order_id || 'NULL'}, sl_order_id=${pos.sl_order_id || 'NULL'}. ` +
              `FORCING TP/SL creation immediately to prevent deep loss!`
            );
            highPriorityPositions.push(pos);
            totalHighPriority++;
            continue;
          }
        }
        
        if (needsTPSL) {
          highPriorityPositions.push(pos);
          totalHighPriority++;
        } else {
          lowPriorityPositions.push(pos);
          totalLowPriority++;
        }
      }
      
      // CRITICAL: Process emergency positions FIRST (bypass all throttling, degrade mode, etc.)
      // BUT: Limit concurrent processing to prevent event loop blocking
      if (emergencyPositions.length > 0) {
        logger.error(
          `[PositionMonitor] 🚨🚨🚨 EMERGENCY MODE: ${emergencyPositions.length} positions exceed Emergency SLA! ` +
          `Processing with LIMITED CONCURRENCY to prevent event loop blocking...`
        );
        
        // Sort by age (oldest first = highest priority)
        emergencyPositions.sort((a, b) => b.ageMs - a.ageMs);
        
        // CRITICAL FIX: Limit concurrent emergency processing to prevent blocking
        // Process in small batches with yielding
        const EMERGENCY_BATCH_SIZE = Number(configService.getNumber('POSITION_MONITOR_EMERGENCY_BATCH_SIZE', 5)); // Max 5 concurrent
        const EMERGENCY_BATCH_DELAY_MS = Number(configService.getNumber('POSITION_MONITOR_EMERGENCY_BATCH_DELAY_MS', 100)); // 100ms delay
        
        for (let i = 0; i < emergencyPositions.length; i += EMERGENCY_BATCH_SIZE) {
          const batch = emergencyPositions.slice(i, i + EMERGENCY_BATCH_SIZE);
          
          // Process batch in parallel
          await Promise.allSettled(
            batch.map(pos => {
              logger.error(
                `[PositionMonitor] 🚨 EMERGENCY: Processing position ${pos.id} (${pos.symbol}) ` +
                `age=${Math.floor(pos.ageMs / 1000)}s - BYPASSING THROTTLING (batch ${Math.floor(i / EMERGENCY_BATCH_SIZE) + 1})`
              );
              return this.placeExitOrder(pos);
            })
          );
          
          // CRITICAL: Yield to event loop after each batch
          await new Promise(resolve => setImmediate(resolve));
          
          // Small delay between batches
          if (i + EMERGENCY_BATCH_SIZE < emergencyPositions.length) {
            await new Promise(resolve => setTimeout(resolve, EMERGENCY_BATCH_DELAY_MS));
          }
        }
        
        logger.info(
          `[PositionMonitor] ✅ Emergency processing complete: ${emergencyPositions.length} positions processed in batches`
        );
      }
      
      logger.info(
        `[PositionMonitor] 📊 Priority split: ${highPriorityPositions.length} high-priority (need TP/SL), ` +
        `${lowPriorityPositions.length} low-priority (have TP/SL)`
      );

      // Process each bot's positions in parallel (fair distribution)
      // CRITICAL OPTIMIZATION: Process mainnet bots first (already sorted), then high-priority positions, then low-priority
      const botProcessingPromises = botEntries.map(async ([botId, botPositions]) => {
        const startTime = Date.now();
        try {
          totalBotsProcessed++;
          totalPositionsProcessed += botPositions.length;
          // Split bot positions by priority
          const botHighPriority = botPositions.filter(p => 
            !p.exit_order_id || !p.sl_order_id || p.tp_sl_pending === true || p.tp_sl_pending === 1
          );
          const botLowPriority = botPositions.filter(p => 
            p.exit_order_id && p.sl_order_id && p.tp_sl_pending !== true && p.tp_sl_pending !== 1
          );
          
          logger.info(
            `[PositionMonitor] 🚀 Starting processing ${botPositions.length} positions for bot ${botId} ` +
            `(high-priority: ${botHighPriority.length}, low-priority: ${botLowPriority.length})`
          );
          
          // Process positions in batches per bot (to avoid rate limits per exchange)
          const batchSize = Number(configService.getNumber('POSITION_MONITOR_BATCH_SIZE', 5)); // Increased from 3 to 5
          const tpPlacementBatchSize = Number(configService.getNumber('POSITION_MONITOR_TP_BATCH_SIZE', 10)); // Larger batch for TP placement (parallel)
          const maxProcessingTimeMs = Number(configService.getNumber('POSITION_MONITOR_MAX_TIME_PER_BOT_MS', 300000)); // 5 minutes max per bot
          
          // PHASE 1: Process high-priority positions (need TP/SL) - URGENT
          // CRITICAL: Sort by opened_at (newest first) to prioritize recently filled positions
          // This ensures positions just filled get TP/SL immediately, reducing exposure risk
          botHighPriority.sort((a, b) => {
            const timeA = a.opened_at ? new Date(a.opened_at).getTime() : 0;
            const timeB = b.opened_at ? new Date(b.opened_at).getTime() : 0;
            return timeB - timeA; // Newest first (highest priority)
          });
          
          if (botHighPriority.length > 0) {
            logger.info(`[PositionMonitor] 🔥 Processing ${botHighPriority.length} high-priority positions for bot ${botId} (TP/SL placement, sorted by newest first)`);
            
            // CRITICAL FIX: Adaptive Chunking & Yielding to prevent event loop blocking
            // Process TP/SL placement in chunks with setImmediate() to yield to event loop
            // ADAPTIVE: Adjust batch size based on event loop delay
            const { watchdogService } = await import('../services/WatchdogService.js');
            const eventLoopMetrics = watchdogService?.getMetrics?.() || { mean: 0, max: 0 };
            const eventLoopDelay = eventLoopMetrics.mean || 0;
            
            // Adaptive batch size: reduce if event loop is under stress
            let adaptiveBatchSize = tpPlacementBatchSize;
            if (eventLoopDelay > 50) {
              adaptiveBatchSize = Math.max(2, Math.floor(tpPlacementBatchSize / 2)); // Reduce by half if delay > 50ms
              logger.warn(
                `[PositionMonitor] ⚠️ Event loop delay high (${eventLoopDelay.toFixed(1)}ms), ` +
                `reducing batch size from ${tpPlacementBatchSize} to ${adaptiveBatchSize}`
              );
            }
            
            const BATCH_DELAY_MS = Number(configService.getNumber('POSITION_MONITOR_TP_BATCH_DELAY_MS', 50));
            const MAX_POSITIONS_PER_CYCLE = Number(configService.getNumber('POSITION_MONITOR_MAX_TP_SL_PER_CYCLE', 50)); // Increased from 20 to 50 for faster throughput
            
            // Limit positions to process in this cycle (prevent 6-8 minute cycles)
            const positionsToProcess = botHighPriority.slice(0, MAX_POSITIONS_PER_CYCLE);
            if (botHighPriority.length > MAX_POSITIONS_PER_CYCLE) {
              logger.warn(
                `[PositionMonitor] ⚠️ Limiting TP/SL placement to ${MAX_POSITIONS_PER_CYCLE} positions ` +
                `(${botHighPriority.length - MAX_POSITIONS_PER_CYCLE} will be processed in next cycle)`
              );
            }
            
            for (let i = 0; i < positionsToProcess.length; i += adaptiveBatchSize) {
              const elapsed = Date.now() - startTime;
              if (elapsed > maxProcessingTimeMs) {
                logger.warn(`[PositionMonitor] ⏱️ Max time reached for bot ${botId}, stopping high-priority processing`);
                break;
              }
              
              // CRITICAL: Re-check event loop delay before each batch (adaptive)
              const currentMetrics = watchdogService?.getMetrics?.() || { mean: 0, max: 0 };
              const currentDelay = currentMetrics.mean || 0;
              
              // Break if event loop delay is too high (prevent further blocking)
              if (currentDelay > 100) {
                logger.warn(
                  `[PositionMonitor] ⚠️ Event loop delay too high (${currentDelay.toFixed(1)}ms), ` +
                  `stopping batch processing at ${i}/${positionsToProcess.length} to prevent further blocking`
                );
                break;
              }
              
              const batch = positionsToProcess.slice(i, i + adaptiveBatchSize);
              
              // CRITICAL: Check if TP/SL placement should be degraded (should NEVER be degraded)
              // But we still respect adaptive chunking to prevent blocking
              const shouldDegrade = watchdogService?.shouldDegradeJob?.('TP_PLACEMENT');
              if (shouldDegrade) {
                logger.error(
                  `[PositionMonitor] 🚨 WARNING: Watchdog tried to degrade TP_PLACEMENT! ` +
                  `This should NEVER happen (TP/SL is safety-critical). Proceeding anyway...`
                );
              }
              
              // Parallel TP/SL placement (no delay between positions in batch)
              await Promise.allSettled(
                batch.map(p => this.placeExitOrder(p))
              );
              
              // CRITICAL: Yield to event loop after each batch
              await new Promise(resolve => setImmediate(resolve));
              
              // Adaptive delay based on event loop state
              if (watchdogService?.isDegraded?.()) {
                // System is degraded, add extra delay to reduce load
                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS * 2));
              } else if (currentDelay > 20) {
                // Event loop under moderate stress, add small delay
                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
              } else if (i + adaptiveBatchSize < positionsToProcess.length) {
                // Normal state, minimal delay
                await new Promise(resolve => setTimeout(resolve, Math.max(10, BATCH_DELAY_MS / 2)));
              }
            }
          }
          
          // PHASE 2: Process all positions for monitoring (can be done in parallel with smaller batches)
          // CRITICAL FIX: Limit positions per cycle to prevent long cycles
          const MAX_MONITORING_PER_CYCLE = Number(configService.getNumber('POSITION_MONITOR_MAX_MONITORING_PER_CYCLE', 50)); // Limit monitoring per cycle
          const allPositionsForMonitoring = [...botHighPriority, ...botLowPriority].slice(0, MAX_MONITORING_PER_CYCLE);
          
          if (botHighPriority.length + botLowPriority.length > MAX_MONITORING_PER_CYCLE) {
            logger.warn(
              `[PositionMonitor] ⚠️ Limiting monitoring to ${MAX_MONITORING_PER_CYCLE} positions ` +
              `(${(botHighPriority.length + botLowPriority.length) - MAX_MONITORING_PER_CYCLE} will be processed in next cycle)`
            );
          }
          
          const monitoringBatchSize = Number(configService.getNumber('POSITION_MONITOR_MONITORING_BATCH_SIZE', 8)); // Parallel monitoring
          const MONITORING_BATCH_DELAY_MS = Number(configService.getNumber('POSITION_MONITOR_MONITORING_BATCH_DELAY_MS', 50)); // Reduced to 50ms
          
          for (let i = 0; i < allPositionsForMonitoring.length; i += monitoringBatchSize) {
            const elapsed = Date.now() - startTime;
            if (elapsed > maxProcessingTimeMs) {
              logger.warn(
                `[PositionMonitor] ⏱️ Max processing time (${maxProcessingTimeMs}ms) reached for bot ${botId}. ` +
                `Processed ${i}/${allPositionsForMonitoring.length} positions. Remaining will be processed in next cycle.`
              );
              break;
            }
            
            const batch = allPositionsForMonitoring.slice(i, i + monitoringBatchSize);
            
            // Parallel monitoring (update dynamic SL, check for TP/SL hit, trailing TP)
            await Promise.allSettled(
              batch.map(async (position) => {
                try {
                  await this.monitorPosition(position);
                } catch (monitorError) {
                  logger.error(`[PositionMonitor] Error monitoring position ${position.id}: ${monitorError?.message || monitorError}`);
                }
              })
            );

            // Check for other order management tasks (parallel)
            await Promise.allSettled(
              batch.map(p => this.checkUnfilledOrders(p))
            );

            // CRITICAL: Yield to event loop after each batch
            await new Promise(resolve => setImmediate(resolve));
            
            // Optional: Additional delay if event loop is under stress
            const { watchdogService } = await import('../services/WatchdogService.js');
            if (watchdogService?.isDegraded?.()) {
              // System is degraded, add extra delay
              await new Promise(resolve => setTimeout(resolve, MONITORING_BATCH_DELAY_MS * 2));
            } else if (i + monitoringBatchSize < allPositionsForMonitoring.length) {
              // Normal delay between batches
              await new Promise(resolve => setTimeout(resolve, MONITORING_BATCH_DELAY_MS));
            }
          }
          
          const totalTime = Date.now() - startTime;
          logger.info(
            `[PositionMonitor] ✅ Completed processing ${botPositions.length} positions for bot ${botId} in ${totalTime}ms ` +
            `(avg ${(totalTime / botPositions.length).toFixed(0)}ms per position)`
          );
        } catch (error) {
          logger.error(`[PositionMonitor] ❌ Error processing positions for bot ${botId}:`, error?.message || error);
        }
      });

      // Wait for all bots to complete (parallel processing)
      await Promise.allSettled(botProcessingPromises);

      // Log monitoring summary (per-cycle)
      const cycleTime = Date.now() - cycleStart;
      if (openPositions.length > 0 || !this._lastLogTime || (Date.now() - this._lastLogTime) > 60000) {
        logger.info(
          `[PositionMonitor] ✅ Cycle summary: positions=${openPositions.length}, bots=${positionsByBot.size}, ` +
          `high_pri=${totalHighPriority}, low_pri=${totalLowPriority}, bots_processed=${totalBotsProcessed}, ` +
          `positions_processed=${totalPositionsProcessed}, duration_ms=${cycleTime}`
        );
        this._lastLogTime = Date.now();
      }
    } catch (error) {
      logger.error('Error in monitorAllPositions', { err: error?.message, stack: error?.stack });
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Start the cron job
   */
  start() {
    // Get interval from config or use default 30 seconds
    // Changed from cron (1 minute) to setInterval (30 seconds) for faster TP order updates
    const intervalMs = Number(configService.getNumber('POSITION_MONITOR_INTERVAL_MS', SCAN_INTERVALS.POSITION_MONITOR));
    const pnlIntervalMs = Number(configService.getNumber('PNL_ALERT_INTERVAL_MS', 0)); // default 0 (disabled) - set > 0 to enable
    
    // Run immediately on start
    this.monitorAllPositions().catch(err => {
      logger.error('[PositionMonitor] Error in initial monitor run:', err);
    });

    // Log effective ADV_TPSL toggles (once) for debugging
    try {
      logger.info(
        `[ADV_TPSL] Effective toggles: enabled=${configService.getBoolean('ADV_TPSL_ENABLED', false)} ` +
        `atr=${configService.getBoolean('ADV_TPSL_ATR_ENABLED', true)} ` +
        `sr=${configService.getBoolean('ADV_TPSL_SR_ENABLED', false)} ` +
        `mtf=${configService.getBoolean('ADV_TPSL_MTF_ENABLED', false)} ` +
        `lossStreak=${configService.getBoolean('ADV_TPSL_LOSS_STREAK_ENABLED', false)} ` +
        `autoOptimize=${configService.getBoolean('ADV_TPSL_AUTO_OPTIMIZE_ENABLED', false)}`
      );
    } catch (_) {}

    // Start PnL realtime alerts (Binance only)
    // CRITICAL: Disabled by default - set PNL_ALERT_INTERVAL_MS > 0 to enable
    if (pnlIntervalMs > 0) {
      this._sendRealtimePnlAlerts().catch(err => {
        logger.error('[PositionMonitor] PnL alert run failed:', err?.message || err);
      });
      this._pnlAlertTimer = setInterval(() => {
        this._sendRealtimePnlAlerts().catch(err => {
          logger.error('[PositionMonitor] PnL alert run failed:', err?.message || err);
        });
      }, pnlIntervalMs);
      logger.info(`[PositionMonitor] PnL realtime alerts started with interval ${pnlIntervalMs}ms`);
    } else {
      logger.info(`[PositionMonitor] PnL realtime alerts DISABLED (PNL_ALERT_INTERVAL_MS=${pnlIntervalMs}ms)`);
    }
    
    // Then run every intervalMs
    setInterval(async () => {
      await this.monitorAllPositions();
    }, intervalMs);

    logger.info(`PositionMonitor started with interval: ${intervalMs}ms (${intervalMs / 1000}s)`);
  }
}
