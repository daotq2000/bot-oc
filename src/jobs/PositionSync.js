import { Position } from '../models/Position.js';
import { EntryOrder } from '../models/EntryOrder.js';
import { ExchangeService } from '../services/ExchangeService.js';
import { SCAN_INTERVALS } from '../config/constants.js';
import { configService } from '../services/ConfigService.js';
import logger from '../utils/logger.js';
import pool from '../config/database.js';

/**
 * Position Sync Job - Sync positions from exchange to database
 * Ensures consistency between exchange and database
 */
export class PositionSync {
  constructor() {
    this.exchangeServices = new Map(); // botId -> ExchangeService
    this.telegramService = null; // TelegramService for sending alerts
    this.isRunning = false;
    this.task = null;
    
    // ✅ IMPROVEMENT: Track sync metrics for monitoring and alerting
    this.syncMetrics = {
      totalSyncs: 0,
      successfulSyncs: 0,
      failedSyncs: 0,
      totalSyncIssues: 0,
      tpSlVerifiedCloses: 0,  // Positions closed because TP/SL was verified as filled
      unknownCloses: 0,        // Positions closed without verified TP/SL
      lastSyncAt: null,
      lastSyncDuration: 0,
      avgSyncDuration: 0
    };
  }

  /**
   * Get current sync metrics for monitoring
   */
  getSyncMetrics() {
    const successRate = this.syncMetrics.totalSyncs > 0 
      ? ((this.syncMetrics.successfulSyncs / this.syncMetrics.totalSyncs) * 100).toFixed(1)
      : 0;
    
    return {
      ...this.syncMetrics,
      successRate: `${successRate}%`
    };
  }

  /**
   * Initialize services for all active bots
   * @param {TelegramService} telegramService - Optional TelegramService for sending alerts
   */
  async initialize(telegramService = null) {
    this.telegramService = telegramService;
    try {
      const { Bot } = await import('../models/Bot.js');
      const bots = await Bot.findAll(true); // Active bots only

      // Initialize bots sequentially with delay to reduce CPU load
      for (let i = 0; i < bots.length; i++) {
        await this.addBot(bots[i]);
        // Add delay between bot initializations to avoid CPU spike
        if (i < bots.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay between bots
        }
      }
    } catch (error) {
      logger.error('Failed to initialize PositionSync:', error);
    }
  }

  /**
   * Add bot to sync
   * @param {Object} bot - Bot object
   */
  async addBot(bot) {
    try {
      const exchangeService = new ExchangeService(bot);
      await exchangeService.initialize();
      this.exchangeServices.set(bot.id, exchangeService);
      logger.info(`PositionSync initialized for bot ${bot.id}`);
    } catch (error) {
      logger.error(`Failed to initialize PositionSync for bot ${bot.id}:`, error);
    }
  }

  /**
   * Remove bot from sync
   * @param {number} botId - Bot ID
   */
  removeBot(botId) {
    this.exchangeServices.delete(botId);
    logger.info(`Removed bot ${botId} from PositionSync`);
  }

  /**
   * Sync positions from exchange to database
   * Creates Position records for positions that exist on exchange but not in database
   * CRITICAL: Uses soft locking (is_processing) to prevent race conditions with PositionMonitor
   */
  async syncPositions() {
    if (this.isRunning) {
      logger.debug('[PositionSync] Sync already running, skipping...');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    this.syncMetrics.totalSyncs++;
    
    try {
      logger.info('[PositionSync] Starting position sync from exchange...');

      let totalProcessed = 0;
      let totalCreated = 0;
      let totalClosed = 0;
      let totalErrors = 0;
      let syncIssuesDetected = 0; // ✅ Track sync issues
      let tpSlVerifiedCloses = 0; // ✅ Track TP/SL verified closes
      let unknownCloses = 0;      // ✅ Track unknown closes

      for (const [botId, exchangeService] of this.exchangeServices.entries()) {
        try {
          const result = await this.syncBotPositions(botId, exchangeService);
          if (result) {
            totalProcessed += result.processed || 0;
            totalCreated += result.created || 0;
            totalClosed += result.closed || 0;
            syncIssuesDetected += result.syncIssuesDetected || 0;
            tpSlVerifiedCloses += result.tpSlVerifiedCloses || 0;
            unknownCloses += result.unknownCloses || 0;
          }
        } catch (error) {
          totalErrors++;
          logger.error(`[PositionSync] Error syncing positions for bot ${botId}:`, error?.message || error);
        }
      }

      const duration = Date.now() - startTime;
      
      // ✅ IMPROVEMENT: Update sync metrics
      this.syncMetrics.successfulSyncs++;
      this.syncMetrics.totalSyncIssues += syncIssuesDetected;
      this.syncMetrics.tpSlVerifiedCloses += tpSlVerifiedCloses;
      this.syncMetrics.unknownCloses += unknownCloses;
      this.syncMetrics.lastSyncAt = new Date().toISOString();
      this.syncMetrics.lastSyncDuration = duration;
      this.syncMetrics.avgSyncDuration = Math.round(
        (this.syncMetrics.avgSyncDuration * (this.syncMetrics.totalSyncs - 1) + duration) / this.syncMetrics.totalSyncs
      );
      
      logger.info(
        `[PositionSync] Position sync completed in ${duration}ms: ` +
        `processed=${totalProcessed}, created=${totalCreated}, closed=${totalClosed}, ` +
        `tpsl_verified=${tpSlVerifiedCloses}, unknown=${unknownCloses}, sync_issues=${syncIssuesDetected}, errors=${totalErrors}`
      );
      
      // ✅ IMPROVEMENT: Alert if sync issues detected (with more context)
      if (syncIssuesDetected > 3 && this.telegramService) {
        try {
          const metrics = this.getSyncMetrics();
          await this.telegramService.sendMessage(
            `⚠️ [PositionSync] Detected ${syncIssuesDetected} sync issue(s)\n` +
            `📊 Success Rate: ${metrics.successRate}\n` +
            `✅ TP/SL Verified: ${tpSlVerifiedCloses}\n` +
            `❓ Unknown: ${unknownCloses}\n` +
            `⏱️ Duration: ${duration}ms`
          );
        } catch (alertError) {
          logger.debug(`[PositionSync] Could not send Telegram alert: ${alertError?.message || alertError}`);
        }
      }
    } catch (error) {
      logger.error('[PositionSync] Error in syncPositions:', error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Retry helper with exponential backoff
   * @param {Function} fn - Async function to retry
   * @param {number} maxRetries - Maximum number of retries (default: 3)
   * @param {number} baseDelayMs - Base delay in ms (default: 2000)
   * @returns {Promise<any>} Result from fn or throws after max retries
   */
  async _retryWithBackoff(fn, maxRetries = 3, baseDelayMs = 2000) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) {
          const delayMs = baseDelayMs * Math.pow(2, attempt - 1); // Exponential backoff: 2s, 4s, 8s
          logger.warn(`[PositionSync] Retry ${attempt}/${maxRetries} failed, waiting ${delayMs}ms before next attempt: ${error?.message || error}`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }
    throw lastError;
  }

  /**
   * Sync positions for a specific bot
   * @param {number} botId - Bot ID
   * @param {ExchangeService} exchangeService - Exchange service instance
   */
  async syncBotPositions(botId, exchangeService) {
    try {
      // Fetch positions from exchange with retry logic
      // Use exchangeService.getOpenPositions() which handles Binance DirectClient properly
      let exchangePositions;
      try {
        // ✅ IMPROVEMENT: Add retry with exponential backoff for network/API failures
        exchangePositions = await this._retryWithBackoff(
          () => exchangeService.getOpenPositions(),
          3, // maxRetries
          2000 // baseDelayMs
        );
        logger.debug(`[PositionSync] Fetched ${Array.isArray(exchangePositions) ? exchangePositions.length : 0} positions from exchange for bot ${botId}`);
      } catch (error) {
        logger.error(`[PositionSync] Failed to fetch positions from exchange for bot ${botId} after retries:`, error?.message || error);
        return;
      }
      
      if (!Array.isArray(exchangePositions)) {
        logger.error(`[PositionSync] Invalid exchange positions data for bot ${botId}`);
        return;
      }
      
      // Get open positions from database for this bot (must be done before checking exchangePositions.length)
      const [dbPositions] = await pool.execute(
        `SELECT p.*, s.symbol as strategy_symbol, s.bot_id
         FROM positions p
         JOIN strategies s ON p.strategy_id = s.id
         WHERE s.bot_id = ? AND p.status = 'open'`,
        [botId]
      );
      
      // If no positions on exchange, all DB positions should be closed
      if (exchangePositions.length === 0) {
        logger.info(`[PositionSync] No positions on exchange for bot ${botId}, closing all open positions in DB`);
        let closedCount = 0;
        for (const dbPos of dbPositions) {
          try {
            const pool = (await import('../config/database.js')).default;
            const [lockResult] = await pool.execute(
              `UPDATE positions 
               SET is_processing = 1 
               WHERE id = ? AND status = 'open' AND (is_processing = 0 OR is_processing IS NULL)
               LIMIT 1`,
              [dbPos.id]
            );
            
            if (lockResult.affectedRows > 0) {
              try {
                logger.warn(
                  `[PositionSync] Position ${dbPos.id} (${dbPos.symbol} ${dbPos.side}) exists in DB but exchange has no positions, closing via PositionService`
                );
                // CRITICAL FIX: Use PositionService.closePosition() instead of Position.update() to ensure Telegram alert is sent
                try {
                  const { PositionService } = await import('../services/PositionService.js');
                  const positionService = new PositionService(exchangeService, this.telegramService); // Use TelegramService if available
                  
                  // Get current price for PnL calculation
                  let closePrice = dbPos.entry_price || 0;
                  try {
                    closePrice = await exchangeService.getTickerPrice(dbPos.symbol);
                  } catch (priceError) {
                    logger.warn(`[PositionSync] Could not get ticker price for ${dbPos.symbol}, using entry_price: ${priceError?.message || priceError}`);
                  }
                  
                  const { calculatePnL } = await import('../utils/calculator.js');
                  const pnl = calculatePnL(dbPos.entry_price, closePrice, dbPos.amount, dbPos.side);
                  
                  await positionService.closePosition(dbPos, closePrice, pnl, 'sync_exchange_empty');
                  closedCount++;
                  logger.info(`[PositionSync] ✅ Closed position ${dbPos.id} via PositionService (Telegram alert should be sent)`);
                } catch (closeError) {
                  // Fallback to direct update if PositionService fails
                  logger.error(
                    `[PositionSync] Failed to close position ${dbPos.id} via PositionService: ${closeError?.message || closeError}. ` +
                    `Falling back to direct DB update (no Telegram alert will be sent).`
                  );
                  await Position.update(dbPos.id, {
                    status: 'closed',
                    close_reason: 'sync_exchange_empty',
                    closed_at: new Date()
                  });
                  closedCount++;
                }
              } finally {
                try {
                  await pool.execute(
                    `UPDATE positions SET is_processing = 0 WHERE id = ?`,
                    [dbPos.id]
                  );
                } catch (releaseError) {
                  logger.debug(`[PositionSync] Could not release lock for position ${dbPos.id}: ${releaseError?.message || releaseError}`);
                }
              }
            }
          } catch (error) {
            const errorMsg = error?.message || String(error);
            // Handle SQL error about is_processing column gracefully
            if (errorMsg.includes("Unknown column 'is_processing'") || errorMsg.includes("is_processing")) {
              logger.debug(`[PositionSync] Column 'is_processing' does not exist, proceeding without lock for position ${dbPos.id}`);
              try {
                logger.warn(
                  `[PositionSync] Position ${dbPos.id} (${dbPos.symbol} ${dbPos.side}) exists in DB but exchange has no positions, closing via PositionService`
                );
                // CRITICAL FIX: Use PositionService.closePosition() instead of Position.update() to ensure Telegram alert is sent
                try {
                  const { PositionService } = await import('../services/PositionService.js');
                  const positionService = new PositionService(exchangeService, this.telegramService); // Use TelegramService if available
                  
                  // Get current price for PnL calculation
                  let closePrice = dbPos.entry_price || 0;
                  try {
                    closePrice = await exchangeService.getTickerPrice(dbPos.symbol);
                  } catch (priceError) {
                    logger.warn(`[PositionSync] Could not get ticker price for ${dbPos.symbol}, using entry_price: ${priceError?.message || priceError}`);
                  }
                  
                  const { calculatePnL } = await import('../utils/calculator.js');
                  const pnl = calculatePnL(dbPos.entry_price, closePrice, dbPos.amount, dbPos.side);
                  
                  await positionService.closePosition(dbPos, closePrice, pnl, 'sync_exchange_empty');
                  logger.info(`[PositionSync] ✅ Closed position ${dbPos.id} via PositionService (Telegram alert should be sent)`);
                } catch (closeError) {
                  // Fallback to direct update if PositionService fails
                  logger.error(
                    `[PositionSync] Failed to close position ${dbPos.id} via PositionService: ${closeError?.message || closeError}. ` +
                    `Falling back to direct DB update (no Telegram alert will be sent).`
                  );
                  await Position.update(dbPos.id, {
                    status: 'closed',
                    close_reason: 'sync_exchange_empty',
                    closed_at: new Date()
                  });
                }
              } catch (updateError) {
                logger.error(`[PositionSync] Failed to close position ${dbPos.id}:`, updateError?.message || updateError);
              }
            } else {
              logger.error(`[PositionSync] Failed to close position ${dbPos.id}:`, errorMsg);
            }
          }
        }
        logger.info(`[PositionSync] Closed ${closedCount} positions for bot ${botId} (exchange has no positions)`);
        return;
      }

      // Helper to normalize symbol exactly like we do for exchange positions
      const normalizeSymbol = (symbol) => this.normalizeSymbol(symbol);

      // Build exchange_position_key for hedge-mode reconciliation.
      // Key format: <exchange>_<botId>_<symbol>_<LONG|SHORT>
      const buildExchangePositionKey = (exchange, botId, symbol, side) => {
        const ex = String(exchange || '').toLowerCase();
        const normSym = normalizeSymbol(symbol);
        const ps = side === 'long' ? 'LONG' : 'SHORT';
        return `${ex}_${botId}_${normSym}_${ps}`;
      };

      // Create a map of DB positions by exchange_position_key (preferred) and by normalized symbol+side (fallback)
      // Use array to store multiple positions with same key (defensive for historical duplicates)
      const dbPositionsMap = new Map();
      for (const pos of dbPositions) {
        const rawSym = pos.symbol;
        const normSym = normalizeSymbol(rawSym);
        const keyRaw = `${rawSym}_${pos.side}`;
        const keyNorm = `${normSym}_${pos.side}`;

        if (pos.exchange_position_key) {
          const k = String(pos.exchange_position_key);
          if (!dbPositionsMap.has(k)) dbPositionsMap.set(k, []);
          dbPositionsMap.get(k).push(pos);
        }

        if (!dbPositionsMap.has(keyRaw)) dbPositionsMap.set(keyRaw, []);
        if (!dbPositionsMap.has(keyNorm)) dbPositionsMap.set(keyNorm, []);
        dbPositionsMap.get(keyRaw).push(pos);
        if (keyRaw !== keyNorm) dbPositionsMap.get(keyNorm).push(pos);
      }

      // Process exchange positions
      let processedCount = 0;
      let createdCount = 0;
      const matchedDbPositionIds = new Set(); // Track which DB positions were matched
      
      for (const exPos of exchangePositions) {
        try {
          // Normalize position data
          // CRITICAL FIX: Parse raw amount FIRST, then determine side, then get absolute value
          const symbol = exPos.symbol || exPos.info?.symbol || exPos.market;
          const rawAmt = parseFloat(exPos.positionAmt ?? exPos.contracts ?? exPos.size ?? 0);
          const side = rawAmt > 0 ? 'long' : rawAmt < 0 ? 'short' : null;
          const contracts = Math.abs(rawAmt); // Absolute value AFTER determining side
          
          if (!symbol || !side || contracts <= 0) {
            logger.debug(`[PositionSync] Skipping invalid position: symbol=${symbol}, side=${side}, rawAmt=${rawAmt}, contracts=${contracts}`);
            continue; // Skip invalid positions
          }

          // Normalize symbol format - handle different exchange formats
          // Binance: BTCUSDT, MEXC: BTC/USDT:USDT, Gate: BTC_USDT
          const normalizedSymbol = normalizeSymbol(symbol);
          
          logger.debug(`[PositionSync] Processing position: ${symbol} -> ${normalizedSymbol}, ${side}, contracts=${contracts}`);

          // Check if position exists in database
          // Preferred matching key: exchange_position_key (stable for hedge mode)
          const exchange = exchangeService?.bot?.exchange || 'binance';
          const exKey = buildExchangePositionKey(exchange, botId, normalizedSymbol, side);

          // Fallback matching keys (legacy): symbol_side
          const key1 = `${normalizedSymbol}_${side}`;
          const key2 = `${symbol}_${side}`;

          const dbPosArray = dbPositionsMap.get(exKey) || dbPositionsMap.get(key1) || dbPositionsMap.get(key2) || [];

          if (dbPosArray.length === 0) {
            // Position exists on exchange but not in database - try to find matching entry_order or strategy
            logger.info(`[PositionSync] Position ${normalizedSymbol} ${side} exists on exchange but not in database, attempting to create...`);
            try {
              const created = await this.createMissingPosition(botId, normalizedSymbol, side, exPos, exchangeService);
              if (created) createdCount++;
            } catch (createError) {
              logger.error(`[PositionSync] Failed to create position ${normalizedSymbol} ${side}:`, createError?.message || createError);
            }
          } else {
            // Position exists in both - verify consistency for all matching positions
            // Match all positions with same symbol+side (there can be multiple positions)
            for (const dbPos of dbPosArray) {
              matchedDbPositionIds.add(dbPos.id); // Mark as matched

              // Backfill exchange_position_key if missing (stabilizes future reconciliation)
              if (!dbPos.exchange_position_key) {
                try {
                  const exchange = exchangeService?.bot?.exchange || 'binance';
                  const k = buildExchangePositionKey(exchange, botId, normalizedSymbol, dbPos.side);
                  await Position.update(dbPos.id, { exchange_position_key: k });
                  dbPos.exchange_position_key = k;
                } catch (e) {
                  logger.debug(`[PositionSync] Could not backfill exchange_position_key for pos=${dbPos.id}: ${e?.message || e}`);
                }
              }

              // Reset debounce counter when the position is confirmed on exchange
              if (Number(dbPos.not_on_exchange_count || 0) !== 0) {
                try {
                  await Position.update(dbPos.id, { not_on_exchange_count: 0 });
                  dbPos.not_on_exchange_count = 0;
                } catch (e) {
                  logger.debug(`[PositionSync] Could not reset not_on_exchange_count for pos=${dbPos.id}: ${e?.message || e}`);
                }
              }

              await this.verifyPositionConsistency(dbPos, exPos);
            }
          }
          processedCount++;
        } catch (error) {
          logger.warn(`[PositionSync] Error processing exchange position ${exPos.symbol || 'unknown'}:`, error?.message || error);
        }
      }
      
      // CRITICAL: Close positions that exist in DB but not on exchange
      // ✅ IMPROVEMENT: Verify TP/SL orders before closing to avoid false positives
      // ✅ FIX: Debounce close. Only close after N consecutive sync cycles not found on exchange.
      const closeDebounceMax = Math.max(1, Number(configService.getNumber('POSITION_SYNC_CLOSE_DEBOUNCE_COUNT', 5)) || 5);
      let closedCount = 0;
      let tpSlVerifiedCloses = 0;  // ✅ Track closes that were verified as TP/SL hit
      let unknownCloses = 0;        // ✅ Track closes without verified TP/SL
      
      for (const dbPos of dbPositions) {
        if (!matchedDbPositionIds.has(dbPos.id) && dbPos.status === 'open') {
          // This position exists in DB but not on exchange
          // Debounce: increment not_on_exchange_count and close only when threshold reached
          const prevCount = Number(dbPos.not_on_exchange_count || 0) || 0;
          const nextCount = prevCount + 1;

          try {
            await Position.update(dbPos.id, { not_on_exchange_count: nextCount });
          } catch (e) {
            logger.debug(`[PositionSync] Could not update not_on_exchange_count for pos=${dbPos.id}: ${e?.message || e}`);
          }

          if (nextCount < closeDebounceMax) {
            logger.warn(
              `[PositionSync] Debounce close: pos ${dbPos.id} not found on exchange ` +
              `(${nextCount}/${closeDebounceMax}) | symbol=${dbPos.symbol} side=${dbPos.side}`
            );
            continue;
          }

          // Threshold reached: verify TP/SL orders first, then close
          try {
            const pool = (await import('../config/database.js')).default;
            // Try to acquire lock before updating
            const [lockResult] = await pool.execute(
              `UPDATE positions 
               SET is_processing = 1 
               WHERE id = ? AND status = 'open' AND (is_processing = 0 OR is_processing IS NULL)
               LIMIT 1`,
              [dbPos.id]
            );
            
            if (lockResult.affectedRows > 0) {
              // Lock acquired, proceed with verification and update
              try {
                // ✅ IMPROVEMENT: Verify TP/SL orders before closing
                let tpOrderFilled = false;
                let slOrderFilled = false;
                let closeReason = 'sync_not_on_exchange';
                
                // Check TP order
                if (dbPos.exit_order_id) {
                  try {
                    const tpOrderStatus = await exchangeService.getOrderStatus(dbPos.symbol, dbPos.exit_order_id);
                    const tpStatus = (tpOrderStatus?.status || '').toLowerCase();
                    if (tpStatus === 'filled' || tpOrderStatus?.executedQty > 0) {
                      tpOrderFilled = true;
                      closeReason = 'tp_hit'; // TP was hit, not a sync issue
                      logger.info(`[PositionSync] ✅ TP order ${dbPos.exit_order_id} was FILLED for position ${dbPos.id}, closing as TP_HIT`);
                    }
                  } catch (tpError) {
                    // Order might not exist (already filled and removed), check if it was filled
                    logger.debug(`[PositionSync] Could not verify TP order ${dbPos.exit_order_id} for position ${dbPos.id}: ${tpError?.message || tpError}`);
                  }
                }
                
                // Check SL order
                if (!tpOrderFilled && dbPos.sl_order_id) {
                  try {
                    const slOrderStatus = await exchangeService.getOrderStatus(dbPos.symbol, dbPos.sl_order_id);
                    const slStatus = (slOrderStatus?.status || '').toLowerCase();
                    if (slStatus === 'filled' || slOrderStatus?.executedQty > 0) {
                      slOrderFilled = true;
                      closeReason = 'sl_hit'; // SL was hit, not a sync issue
                      logger.info(`[PositionSync] ✅ SL order ${dbPos.sl_order_id} was FILLED for position ${dbPos.id}, closing as SL_HIT`);
                    }
                  } catch (slError) {
                    // Order might not exist (already filled and removed), check if it was filled
                    logger.debug(`[PositionSync] Could not verify SL order ${dbPos.sl_order_id} for position ${dbPos.id}: ${slError?.message || slError}`);
                  }
                }
                
                // If TP or SL was filled, use appropriate close reason
                if (tpOrderFilled || slOrderFilled) {
                  logger.info(
                    `[PositionSync] Position ${dbPos.id} (${dbPos.symbol} ${dbPos.side}) was closed via ${tpOrderFilled ? 'TP' : 'SL'} order, not sync issue`
                  );
                } else {
                logger.warn(
                    `[PositionSync] Position ${dbPos.id} (${dbPos.symbol} ${dbPos.side}) exists in DB but not on exchange (no TP/SL filled), closing via PositionService`
                );
                }
                
                // CRITICAL FIX: Use PositionService.closePosition() instead of Position.update() to ensure Telegram alert is sent
                try {
                  const { PositionService } = await import('../services/PositionService.js');
                  const positionService = new PositionService(exchangeService, this.telegramService); // Use TelegramService if available
                  
                  // Get current price for PnL calculation
                  let closePrice = dbPos.entry_price || 0;
                  try {
                    closePrice = await exchangeService.getTickerPrice(dbPos.symbol);
                  } catch (priceError) {
                    logger.warn(`[PositionSync] Could not get ticker price for ${dbPos.symbol}, using entry_price: ${priceError?.message || priceError}`);
                  }
                  
                  const { calculatePnL } = await import('../utils/calculator.js');
                  const pnl = calculatePnL(dbPos.entry_price, closePrice, dbPos.amount, dbPos.side);
                  
                  await positionService.closePosition(dbPos, closePrice, pnl, closeReason);
                  closedCount++;
                  
                  // ✅ IMPROVEMENT: Track TP/SL verified vs unknown closes
                  if (tpOrderFilled || slOrderFilled) {
                    tpSlVerifiedCloses++;
                  } else {
                    unknownCloses++;
                  }
                  
                  logger.info(`[PositionSync] ✅ Closed position ${dbPos.id} via PositionService (reason: ${closeReason}, Telegram alert should be sent)`);
                } catch (closeError) {
                  // Fallback to direct update if PositionService fails
                  logger.error(
                    `[PositionSync] Failed to close position ${dbPos.id} via PositionService: ${closeError?.message || closeError}. ` +
                    `Falling back to direct DB update (no Telegram alert will be sent).`
                  );
                  await Position.update(dbPos.id, {
                    status: 'closed',
                    close_reason: closeReason,
                    closed_at: new Date()
                  });
                  closedCount++;
                  
                  // ✅ Track even for fallback
                  if (tpOrderFilled || slOrderFilled) {
                    tpSlVerifiedCloses++;
                  } else {
                    unknownCloses++;
                  }
                }
              } finally {
                // Always release lock in finally block
                try {
                  await pool.execute(
                    `UPDATE positions SET is_processing = 0 WHERE id = ?`,
                    [dbPos.id]
                  );
                } catch (releaseError) {
                  logger.debug(`[PositionSync] Could not release lock for position ${dbPos.id}: ${releaseError?.message || releaseError}`);
                }
              }
            } else {
              // Another process is handling this position, skip update
              logger.debug(`[PositionSync] Position ${dbPos.id} is being processed by another instance, skipping close update`);
            }
          } catch (lockError) {
            // If is_processing column doesn't exist, proceed without lock (backward compatibility)
            logger.debug(`[PositionSync] Could not acquire lock for position ${dbPos.id}: ${lockError?.message || lockError}`);
            try {
              // ✅ IMPROVEMENT: Verify TP/SL orders before closing (same logic as above)
              let tpOrderFilled = false;
              let slOrderFilled = false;
              let closeReason = 'sync_not_on_exchange';
              
              // Check TP order
              if (dbPos.exit_order_id) {
                try {
                  const tpOrderStatus = await exchangeService.getOrderStatus(dbPos.symbol, dbPos.exit_order_id);
                  const tpStatus = (tpOrderStatus?.status || '').toLowerCase();
                  if (tpStatus === 'filled' || tpOrderStatus?.executedQty > 0) {
                    tpOrderFilled = true;
                    closeReason = 'tp_hit';
                    logger.info(`[PositionSync] ✅ TP order ${dbPos.exit_order_id} was FILLED for position ${dbPos.id}, closing as TP_HIT`);
                  }
                } catch (tpError) {
                  logger.debug(`[PositionSync] Could not verify TP order ${dbPos.exit_order_id} for position ${dbPos.id}: ${tpError?.message || tpError}`);
                }
              }
              
              // Check SL order
              if (!tpOrderFilled && dbPos.sl_order_id) {
                try {
                  const slOrderStatus = await exchangeService.getOrderStatus(dbPos.symbol, dbPos.sl_order_id);
                  const slStatus = (slOrderStatus?.status || '').toLowerCase();
                  if (slStatus === 'filled' || slOrderStatus?.executedQty > 0) {
                    slOrderFilled = true;
                    closeReason = 'sl_hit';
                    logger.info(`[PositionSync] ✅ SL order ${dbPos.sl_order_id} was FILLED for position ${dbPos.id}, closing as SL_HIT`);
                  }
                } catch (slError) {
                  logger.debug(`[PositionSync] Could not verify SL order ${dbPos.sl_order_id} for position ${dbPos.id}: ${slError?.message || slError}`);
                }
              }
              
              if (tpOrderFilled || slOrderFilled) {
                logger.info(
                  `[PositionSync] Position ${dbPos.id} (${dbPos.symbol} ${dbPos.side}) was closed via ${tpOrderFilled ? 'TP' : 'SL'} order, not sync issue`
                );
              } else {
              logger.warn(
                  `[PositionSync] Position ${dbPos.id} (${dbPos.symbol} ${dbPos.side}) exists in DB but not on exchange (no TP/SL filled), closing via PositionService`
              );
              }
              
              // CRITICAL FIX: Use PositionService.closePosition() instead of Position.update() to ensure Telegram alert is sent
              try {
                const { PositionService } = await import('../services/PositionService.js');
                const positionService = new PositionService(exchangeService, this.telegramService); // Inject TelegramService if available
                
                // Get current price for PnL calculation
                let closePrice = dbPos.entry_price || 0;
                try {
                  closePrice = await exchangeService.getTickerPrice(dbPos.symbol);
                } catch (priceError) {
                  logger.warn(`[PositionSync] Could not get ticker price for ${dbPos.symbol}, using entry_price: ${priceError?.message || priceError}`);
                }
                
                const { calculatePnL } = await import('../utils/calculator.js');
                const pnl = calculatePnL(dbPos.entry_price, closePrice, dbPos.amount, dbPos.side);
                
                await positionService.closePosition(dbPos, closePrice, pnl, closeReason);
                closedCount++;
                logger.info(`[PositionSync] ✅ Closed position ${dbPos.id} via PositionService (reason: ${closeReason}, Telegram alert should be sent)`);
              } catch (closeError) {
                // Fallback to direct update if PositionService fails
                logger.error(
                  `[PositionSync] Failed to close position ${dbPos.id} via PositionService: ${closeError?.message || closeError}. ` +
                  `Falling back to direct DB update (no Telegram alert will be sent).`
                );
                await Position.update(dbPos.id, {
                  status: 'closed',
                  close_reason: closeReason,
                  closed_at: new Date()
                });
                closedCount++;
              }
            } catch (updateError) {
              const updateErrorMsg = updateError?.message || String(updateError);
              // Handle SQL error about is_processing column gracefully
              if (updateErrorMsg.includes("Unknown column 'is_processing'") || updateErrorMsg.includes("is_processing")) {
                logger.debug(`[PositionSync] Column 'is_processing' does not exist, proceeding without lock for position ${dbPos.id}`);
                // Try to update without lock
                try {
                  await Position.update(dbPos.id, {
                    status: 'closed',
                    close_reason: 'sync_not_on_exchange',
                    closed_at: new Date()
                  });
                  closedCount++;
                } catch (retryError) {
                  logger.error(`[PositionSync] Failed to close position ${dbPos.id} (retry):`, retryError?.message || retryError);
                }
              } else {
                logger.error(`[PositionSync] Failed to close position ${dbPos.id}:`, updateErrorMsg);
              }
            }
          }
        }
      }
      
      logger.info(
        `[PositionSync] Processed ${processedCount} exchange positions for bot ${botId}, ` +
        `created ${createdCount} missing positions, closed ${closedCount} orphan positions`
      );
      
      // Return summary for aggregation
      return {
        processed: processedCount,
        created: createdCount,
        closed: closedCount,
        syncIssuesDetected: unknownCloses, // ✅ Track positions closed due to sync issues (not TP/SL)
        tpSlVerifiedCloses: tpSlVerifiedCloses, // ✅ Track positions closed because TP/SL was verified
        unknownCloses: unknownCloses  // ✅ Track positions closed without verified TP/SL
      };
    } catch (error) {
      logger.error(`[PositionSync] Error syncing bot ${botId}:`, error?.message || error);
      throw error;
    }
  }

  /**
   * Normalize symbol to consistent format (BTCUSDT everywhere)
   * @param {string} symbol - Raw symbol
   * @returns {string} Normalized symbol
   */
  normalizeSymbol(symbol) {
    if (!symbol) return symbol;
    let normalizedSymbol = String(symbol);
    normalizedSymbol = normalizedSymbol.replace(/\/USDT:USDT$/, 'USDT'); // MEXC format
    normalizedSymbol = normalizedSymbol.replace(/\/USDT$/, 'USDT'); // Standard format with slash
    normalizedSymbol = normalizedSymbol.replace(/_USDT$/, 'USDT'); // Gate format
    normalizedSymbol = normalizedSymbol.replace(/\//g, ''); // Remove any remaining slashes
    return normalizedSymbol;
  }

  /**
   * Create Position record for position that exists on exchange but not in database
   * Uses optimistic locking (no transaction, relies on UNIQUE constraint) for better performance
   * @param {number} botId - Bot ID
   * @param {string} symbol - Symbol (normalized)
   * @param {string} side - 'long' or 'short'
   * @param {Object} exPos - Exchange position data
   * @param {ExchangeService} exchangeService - Exchange service instance
   */
  async createMissingPosition(botId, symbol, side, exPos, exchangeService) {
    // CRITICAL: Normalize side parameter to ensure consistency (lowercase 'long' or 'short')
    let normalizedSide = String(side || '').toLowerCase();
    if (normalizedSide !== 'long' && normalizedSide !== 'short') {
      logger.error(`[PositionSync] Invalid side parameter: ${JSON.stringify(side)}, must be 'long' or 'short'`);
      return false;
    }
    side = normalizedSide; // Use normalized side

    // Normalize symbol to ensure consistency
    const normalizedSymbol = this.normalizeSymbol(symbol);

    // OPTIMISTIC LOCK: Check for existing position without lock (fast read)
    // This is a performance optimization - we rely on UNIQUE constraint to prevent duplicates
    const [existing] = await pool.execute(
      `SELECT p.id, p.symbol, p.side
       FROM positions p
       JOIN strategies s ON p.strategy_id = s.id
       WHERE s.bot_id = ? 
         AND p.status = 'open'
         AND p.side = ?
         AND (
           p.symbol = ? OR 
           p.symbol = ? OR 
           s.symbol = ? OR 
           s.symbol = ?
         )
       LIMIT 1`,
      [
        botId,
        side,
        normalizedSymbol,
        `${normalizedSymbol}/USDT`,
        normalizedSymbol,
        `${normalizedSymbol}/USDT`
      ]
    );

    if (existing.length > 0) {
      logger.info(
        `[PositionSync] Skip creating duplicate Position for ${normalizedSymbol} ${side} on bot ${botId} ` +
        `(found existing position id=${existing[0].id}, symbol=${existing[0].symbol})`
      );
      return false;
    }

      // Try to find matching entry_order first (use normalized symbol for consistency)
      const [entryOrders] = await pool.execute(
        `SELECT * FROM entry_orders 
         WHERE bot_id = ? AND side = ? AND status = 'open'
           AND (symbol = ? OR symbol = ? OR symbol = ?)
         ORDER BY created_at DESC LIMIT 1`,
        [botId, side, normalizedSymbol, `${normalizedSymbol}/USDT`, symbol]
      );

      if (entryOrders.length > 0) {
        const entry = entryOrders[0];
        logger.info(`[PositionSync] Found matching entry_order ${entry.id} for missing position ${symbol} ${side}`);
        // Try to create Position directly using entry_order data
        try {
          const { Strategy } = await import('../models/Strategy.js');
          const strategy = await Strategy.findById(entry.strategy_id);
          if (!strategy) {
            logger.warn(`[PositionSync] Strategy ${entry.strategy_id} not found for entry_order ${entry.id}`);
            return false;
          }
          
          // Use entry_order data to create Position
          const { calculateTakeProfit, calculateInitialStopLoss } = await import('../utils/calculator.js');
          const entryPrice = parseFloat(exPos.entryPrice || exPos.info?.entryPrice || exPos.markPrice || entry.entry_price || 0);
          const tpPrice = calculateTakeProfit(entryPrice, strategy.take_profit, side);
          const rawStoploss = strategy.stoploss !== undefined ? Number(strategy.stoploss) : NaN;
          const isStoplossValid = Number.isFinite(rawStoploss) && rawStoploss > 0;
          const slPrice = isStoplossValid ? calculateInitialStopLoss(entryPrice, rawStoploss, side) : null;
          
          // Use normalized symbol for consistency
            const position = await Position.create({
              strategy_id: entry.strategy_id,
              bot_id: botId,
              order_id: entry.order_id,
            symbol: normalizedSymbol, // Use normalized symbol
              side: side,
              entry_price: entryPrice,
              amount: entry.amount,
              take_profit_price: tpPrice,
              stop_loss_price: slPrice,
              current_reduce: strategy.reduce,
              tp_sl_pending: true
            });
            
            await EntryOrder.markFilled(entry.id);
            
          logger.info(`[PositionSync] ✅ Created Position ${position.id} from entry_order ${entry.id} for ${normalizedSymbol} ${side}`);
          
          // OPTIMIZATION: Trigger immediate TP/SL placement for newly created position
          // This reduces unprotected time window from 30-60s to < 5s
          await this._triggerImmediateTPSLPlacement(position);
          
            return true;
        } catch (error) {
          // OPTIMISTIC LOCK: Handle duplicate gracefully (race condition detected)
          if (error?.code === 'ER_DUP_ENTRY' || error?.message?.includes('Duplicate entry') || error?.message?.includes('UNIQUE constraint')) {
            logger.info(
              `[PositionSync] Position already exists for ${normalizedSymbol} ${side} on bot ${botId} ` +
              `(race condition detected, another process created it first)`
            );
            return false; // Not an error, just skip
          }
          logger.error(`[PositionSync] Error creating Position from entry_order ${entry.id}:`, error?.message || error);
          return false;
        }
      }

      // Try to find matching strategy (use normalized symbol for consistency)
      const [strategies] = await pool.execute(
        `SELECT * FROM strategies 
         WHERE bot_id = ? AND is_active = TRUE
           AND (symbol = ? OR symbol = ? OR symbol = ?)
         ORDER BY created_at DESC LIMIT 1`,
        [botId, normalizedSymbol, `${normalizedSymbol}/USDT`, symbol]
      );

      if (strategies.length === 0) {
        logger.warn(
          `[PositionSync] ⚠️ ORPHAN POSITION: No matching strategy found for position ${symbol} ${side} on bot ${botId}. ` +
          `This position exists on exchange but cannot be managed by bot because no active strategy matches the symbol.`
        );
        return false; // Can't create Position without strategy
      }

      const strategy = strategies[0];

      // Get position details from exchange
      // CRITICAL: Parse raw amount first to determine side correctly
      const rawAmt = parseFloat(exPos.positionAmt ?? exPos.contracts ?? 0);
      const contracts = Math.abs(rawAmt);
      
      // CRITICAL FIX: Verify side matches rawAmt to prevent side mismatch bugs
      const verifiedSide = rawAmt > 0 ? 'long' : rawAmt < 0 ? 'short' : null;
      if (verifiedSide && verifiedSide !== side) {
        logger.error(
          `[PositionSync] ⚠️ SIDE MISMATCH when creating position for ${symbol}: ` +
          `Parameter side=${side}, but rawAmt=${rawAmt} indicates side=${verifiedSide}. ` +
          `Using verified side from rawAmt to prevent incorrect position creation.`
        );
        // Use verified side from rawAmt instead of parameter
        // This prevents creating position with wrong side if parameter was incorrect
        side = verifiedSide;
      }
      
      const entryPrice = parseFloat(exPos.entryPrice || exPos.info?.entryPrice || exPos.markPrice || 0);
      const markPrice = parseFloat(exPos.markPrice || exPos.info?.markPrice || entryPrice || 0);
      
      // Calculate amount in USDT (approximate)
      const amount = contracts * markPrice;

      // Calculate TP/SL
      const { calculateTakeProfit, calculateInitialStopLoss } = await import('../utils/calculator.js');
      const tpPrice = calculateTakeProfit(entryPrice || markPrice, strategy.take_profit, side);
      const rawStoploss = strategy.stoploss !== undefined ? Number(strategy.stoploss) : NaN;
      const isStoplossValid = Number.isFinite(rawStoploss) && rawStoploss > 0;
      const slPrice = isStoplossValid ? calculateInitialStopLoss(entryPrice || markPrice, rawStoploss, side) : null;

      // OPTIMISTIC LOCK: Create Position directly without transaction (fast)
      // UNIQUE constraint will prevent duplicates if race condition occurs
      // CRITICAL FIX: Set order_id = null for synced positions (no real order exists)
      // Fake order_id like "sync_..." causes Binance API errors when querying order status
      // Synced positions are positions that already exist on exchange, not newly created orders
      try {
        const exchange = exchangeService?.bot?.exchange || 'binance';
        const exchangePositionKey = `${String(exchange).toLowerCase()}_${botId}_${normalizedSymbol}_${side === 'long' ? 'LONG' : 'SHORT'}`;

        const position = await Position.create({
          strategy_id: strategy.id,
          bot_id: botId,
          order_id: null, // CRITICAL: No real order_id for synced positions (position already existed on exchange)
          symbol: normalizedSymbol, // Use normalized symbol for consistency
          side: side,
          entry_price: entryPrice || markPrice,
          amount: amount,
          take_profit_price: tpPrice,
          stop_loss_price: slPrice,
          current_reduce: strategy.reduce,
          tp_sl_pending: true,
          exchange_position_key: exchangePositionKey
        });

        logger.info(
          `[PositionSync] ✅ Created missing Position ${position.id} for ${normalizedSymbol} ${side} on bot ${botId} ` +
          `(synced from exchange, order_id=null because position already existed on exchange, not from new order)`
        );
        
        // OPTIMIZATION: Trigger immediate TP/SL placement for newly created position
        // This reduces unprotected time window from 30-60s to < 5s
        await this._triggerImmediateTPSLPlacement(position, exchangeService);
        
        return true;
      } catch (error) {
        // OPTIMISTIC LOCK: Handle duplicate gracefully (race condition detected)
        if (error?.code === 'ER_DUP_ENTRY' || error?.message?.includes('Duplicate entry') || error?.message?.includes('UNIQUE constraint')) {
          logger.info(
            `[PositionSync] Position already exists for ${normalizedSymbol} ${side} on bot ${botId} ` +
            `(race condition detected, another process created it first)`
          );
          return false; // Not an error, just skip
        }
        logger.error(`[PositionSync] Error creating missing position for ${symbol} ${side}:`, error?.message || error);
        return false;
      }
  }

  /**
   * Verify consistency between database and exchange position
   * Checks: contracts (closed), size mismatch, side mismatch, entry price mismatch
   * @param {Object} dbPos - Database position
   * @param {Object} exPos - Exchange position
   * @param {ExchangeService} exchangeService - Exchange service instance
   */
  async verifyPositionConsistency(dbPos, exPos) {
    try {
      // Parse raw amount first to determine side correctly
      const rawAmt = parseFloat(exPos.positionAmt ?? exPos.contracts ?? 0);
      const contracts = Math.abs(rawAmt);
      const exSide = rawAmt > 0 ? 'long' : rawAmt < 0 ? 'short' : null;
      
      // 1. Check if exchange position is closed (contracts = 0) but DB position is open
      // CRITICAL FIX: Use soft lock to prevent race condition with PositionMonitor
      if (contracts <= 0 && dbPos.status === 'open') {
        try {
          const pool = (await import('../config/database.js')).default;
          // Try to acquire lock before updating
          const [lockResult] = await pool.execute(
            `UPDATE positions 
             SET is_processing = 1 
             WHERE id = ? AND status = 'open' AND (is_processing = 0 OR is_processing IS NULL)
             LIMIT 1`,
            [dbPos.id]
          );
          
          if (lockResult.affectedRows > 0) {
            // Lock acquired, proceed with update
            try {
        logger.warn(`[PositionSync] Position ${dbPos.id} is open in DB but closed on exchange, marking as closed`);
        await Position.update(dbPos.id, {
          status: 'closed',
          close_reason: 'sync_exchange_closed',
          closed_at: new Date()
        });
            } finally {
              // Always release lock in finally block
              try {
                await pool.execute(
                  `UPDATE positions SET is_processing = 0 WHERE id = ?`,
                  [dbPos.id]
                );
              } catch (releaseError) {
                logger.debug(`[PositionSync] Could not release lock for position ${dbPos.id}: ${releaseError?.message || releaseError}`);
              }
            }
          } else {
            // Another process is handling this position, skip update
            logger.debug(`[PositionSync] Position ${dbPos.id} is being processed by another instance, skipping close update`);
          }
        } catch (lockError) {
          // If is_processing column doesn't exist, proceed without lock (backward compatibility)
          logger.debug(`[PositionSync] Could not acquire lock for position ${dbPos.id}: ${lockError?.message || lockError}`);
          await Position.update(dbPos.id, {
            status: 'closed',
            close_reason: 'sync_exchange_closed',
            closed_at: new Date()
          });
        }
        return;
      }

      // 2. Check side mismatch (CRITICAL)
      if (exSide && exSide !== dbPos.side) {
        logger.error(
          `[PositionSync] ⚠️ SIDE MISMATCH for position ${dbPos.id}: ` +
          `DB=${dbPos.side}, Exchange=${exSide}, symbol=${dbPos.symbol}. ` +
          `This is a critical error - position side is incorrect!`
        );
        // Don't auto-fix side mismatch - requires manual intervention
        return;
      }

      // 3. Check size mismatch (warn if significant difference)
      const dbAmount = parseFloat(dbPos.amount || 0);
      const exAmount = contracts * parseFloat(exPos.markPrice || exPos.info?.markPrice || dbPos.entry_price || 0);
      const sizeDiffPercent = dbAmount > 0 ? Math.abs((exAmount - dbAmount) / dbAmount) * 100 : 0;
      
      if (sizeDiffPercent > 10) { // More than 10% difference
        logger.warn(
          `[PositionSync] Size mismatch for position ${dbPos.id}: ` +
          `DB=${dbAmount.toFixed(2)}, Exchange=${exAmount.toFixed(2)}, diff=${sizeDiffPercent.toFixed(2)}%`
        );
      }

      // 4. Check entry price mismatch (warn if significant difference)
      const exEntryPrice = parseFloat(exPos.entryPrice || exPos.info?.entryPrice || 0);
      const dbEntryPrice = parseFloat(dbPos.entry_price || 0);
      
      if (exEntryPrice > 0 && dbEntryPrice > 0) {
        const priceDiffPercent = Math.abs((exEntryPrice - dbEntryPrice) / dbEntryPrice) * 100;
        if (priceDiffPercent > 5) { // More than 5% difference
          logger.warn(
            `[PositionSync] Entry price mismatch for position ${dbPos.id}: ` +
            `DB=${dbEntryPrice}, Exchange=${exEntryPrice}, diff=${priceDiffPercent.toFixed(2)}%`
          );
        }
      }

      // 5. AUTO-REPAIR: Force TP/SL reconciliation if orders are missing on exchange
      // Only for positions with an active strategy match (which dbPos already has)
      const hasTP = dbPos.exit_order_id != null;
      const hasSL = dbPos.sl_order_id != null || dbPos.use_software_sl;

      if (!hasTP || !hasSL) {
        logger.info(
          `[PositionSync] 🔧 AUTO-REPAIR: Position ${dbPos.id} (${dbPos.symbol}) missing TP or SL orders in DB. ` +
          `Setting tp_sl_pending=true to trigger re-placement.`
        );
        await Position.update(dbPos.id, { tp_sl_pending: true });
      }
    } catch (error) {
      logger.warn(`[PositionSync] Error verifying position ${dbPos.id}:`, error?.message || error);
    }
  }

  /**
   * Trigger immediate TP/SL placement for newly created position
   * OPTIMIZATION: Sets tp_sl_pending flag to ensure PositionMonitor processes it with high priority
   * This reduces unprotected time window from 30-60s to < 5s (next PositionMonitor cycle)
   * @param {Object} position - Position object
   * @param {ExchangeService} exchangeService - Exchange service instance
   */
  async _triggerImmediateTPSLPlacement(position) {
    try {
      // Set tp_sl_pending flag to ensure PositionMonitor processes this position with high priority
      // PositionMonitor already has logic to prioritize positions with tp_sl_pending = true
      try {
        await Position.update(position.id, { tp_sl_pending: true });
        logger.info(
          `[PositionSync] 🚀 Set tp_sl_pending flag for position ${position.id} ` +
          `(${position.symbol} ${position.side}) to trigger immediate TP/SL placement in next PositionMonitor cycle`
        );
      } catch (updateError) {
        // If tp_sl_pending column doesn't exist, that's okay - PositionMonitor will still handle it
        const errorMsg = updateError?.message || String(updateError);
        if (errorMsg.includes("Unknown column 'tp_sl_pending'") || errorMsg.includes("tp_sl_pending")) {
          logger.debug(
            `[PositionSync] tp_sl_pending column not available for position ${position.id}, ` +
            `PositionMonitor will still process it in next cycle`
          );
        } else {
          logger.warn(
            `[PositionSync] Failed to set tp_sl_pending flag for position ${position.id}: ${errorMsg}`
          );
        }
      }
    } catch (error) {
      // Non-critical: if we can't set flag, PositionMonitor will still handle it
      logger.debug(
        `[PositionSync] Could not trigger immediate TP/SL placement for position ${position.id}: ` +
        `${error?.message || error}. Will be handled by PositionMonitor in next cycle.`
      );
    }
  }

  /**
   * Start the sync job
   */
  start() {
    if (this.task) {
      logger.warn('[PositionSync] Job already started');
      return;
    }

    // Get interval from config or use default 40 seconds
    // Changed from cron (minutes) to setInterval (seconds) for faster position sync
    const intervalMs = Number(configService.getNumber('POSITION_SYNC_INTERVAL_MS', SCAN_INTERVALS.POSITION_SYNC));
    
    // Run immediately on start
    this.syncPositions().catch(err => {
      logger.error('[PositionSync] Error in initial sync:', err);
    });
    
    // Then run every intervalMs
    this.task = setInterval(async () => {
      await this.syncPositions();
    }, intervalMs);

    logger.info(`[PositionSync] Started sync job with interval: ${intervalMs}ms (${intervalMs / 1000}s)`);
  }

  /**
   * Stop the sync job
   */
  stop() {
    if (this.task) {
      clearInterval(this.task); // Clear setInterval timer
      this.task = null;
      logger.info('[PositionSync] Stopped sync job');
    }
  }
}

