import cron from 'node-cron';
import { Position } from '../models/Position.js';
import { Strategy } from '../models/Strategy.js';
import { EntryOrder } from '../models/EntryOrder.js';
import { ExchangeService } from '../services/ExchangeService.js';
import { DEFAULT_CRON_PATTERNS } from '../config/constants.js';
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
    this.isRunning = false;
    this.task = null;
  }

  /**
   * Initialize services for all active bots
   */
  async initialize() {
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
   */
  async syncPositions() {
    if (this.isRunning) {
      logger.debug('[PositionSync] Sync already running, skipping...');
      return;
    }

    this.isRunning = true;
    try {
      logger.debug('[PositionSync] Starting position sync from exchange...');

      for (const [botId, exchangeService] of this.exchangeServices.entries()) {
        try {
          await this.syncBotPositions(botId, exchangeService);
        } catch (error) {
          logger.error(`[PositionSync] Error syncing positions for bot ${botId}:`, error?.message || error);
        }
      }

      logger.debug('[PositionSync] Position sync completed');
    } catch (error) {
      logger.error('[PositionSync] Error in syncPositions:', error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Sync positions for a specific bot
   * @param {number} botId - Bot ID
   * @param {ExchangeService} exchangeService - Exchange service instance
   */
  async syncBotPositions(botId, exchangeService) {
    try {
      // Fetch positions from exchange
      // Use exchangeService.getOpenPositions() which handles Binance DirectClient properly
      let exchangePositions;
      try {
        exchangePositions = await exchangeService.getOpenPositions();
        logger.debug(`[PositionSync] Fetched ${Array.isArray(exchangePositions) ? exchangePositions.length : 0} positions from exchange for bot ${botId}`);
      } catch (error) {
        logger.error(`[PositionSync] Failed to fetch positions from exchange for bot ${botId}:`, error?.message || error);
        return;
      }
      
      if (!Array.isArray(exchangePositions)) {
        logger.error(`[PositionSync] Invalid exchange positions data for bot ${botId}`);
        return;
      }
      
      // If no positions on exchange, all DB positions should be closed
      if (exchangePositions.length === 0) {
        logger.info(`[PositionSync] No positions on exchange for bot ${botId}, closing all open positions in DB`);
        let closedCount = 0;
        for (const dbPos of dbPositions) {
          try {
            const { pool } = await import('../config/database.js');
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
                  `[PositionSync] Position ${dbPos.id} (${dbPos.symbol} ${dbPos.side}) exists in DB but exchange has no positions, marking as closed`
                );
                await Position.update(dbPos.id, {
                  status: 'closed',
                  close_reason: 'sync_exchange_empty',
                  closed_at: new Date()
                });
                closedCount++;
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
            logger.error(`[PositionSync] Failed to close position ${dbPos.id}:`, error?.message || error);
          }
        }
        logger.info(`[PositionSync] Closed ${closedCount} positions for bot ${botId} (exchange has no positions)`);
        return;
      }

      // Get open positions from database for this bot
      const [dbPositions] = await pool.execute(
        `SELECT p.*, s.symbol as strategy_symbol, s.bot_id
         FROM positions p
         JOIN strategies s ON p.strategy_id = s.id
         WHERE s.bot_id = ? AND p.status = 'open'`,
        [botId]
      );

      // Helper to normalize symbol exactly like we do for exchange positions
      const normalizeSymbol = (symbol) => this.normalizeSymbol(symbol);

      // Create a map of DB positions by *normalized* symbol+side
      // This prevents duplicates like "H/USDT" vs "HUSDT" for the same underlying coin.
      // Use array to store multiple positions with same symbol+side
      const dbPositionsMap = new Map();
      for (const pos of dbPositions) {
        const rawSym = pos.symbol;
        const normSym = normalizeSymbol(rawSym);
        const keyRaw = `${rawSym}_${pos.side}`;
        const keyNorm = `${normSym}_${pos.side}`;
        
        // Store as array to handle multiple positions with same symbol+side
        if (!dbPositionsMap.has(keyRaw)) {
          dbPositionsMap.set(keyRaw, []);
        }
        if (!dbPositionsMap.has(keyNorm)) {
          dbPositionsMap.set(keyNorm, []);
        }
        dbPositionsMap.get(keyRaw).push(pos);
        if (keyRaw !== keyNorm) {
          dbPositionsMap.get(keyNorm).push(pos);
        }
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
          // Try multiple key formats for matching
          const key1 = `${normalizedSymbol}_${side}`;
          const key2 = `${symbol}_${side}`;
          const dbPosArray = dbPositionsMap.get(key1) || dbPositionsMap.get(key2) || [];

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
              await this.verifyPositionConsistency(dbPos, exPos, exchangeService);
            }
          }
          processedCount++;
        } catch (error) {
          logger.warn(`[PositionSync] Error processing exchange position ${exPos.symbol || 'unknown'}:`, error?.message || error);
        }
      }
      
      // CRITICAL: Close positions that exist in DB but not on exchange
      let closedCount = 0;
      for (const dbPos of dbPositions) {
        if (!matchedDbPositionIds.has(dbPos.id) && dbPos.status === 'open') {
          // This position exists in DB but not on exchange - close it
          try {
            const { pool } = await import('../config/database.js');
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
                logger.warn(
                  `[PositionSync] Position ${dbPos.id} (${dbPos.symbol} ${dbPos.side}) exists in DB but not on exchange, marking as closed`
                );
                await Position.update(dbPos.id, {
                  status: 'closed',
                  close_reason: 'sync_not_on_exchange',
                  closed_at: new Date()
                });
                closedCount++;
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
              logger.warn(
                `[PositionSync] Position ${dbPos.id} (${dbPos.symbol} ${dbPos.side}) exists in DB but not on exchange, marking as closed`
              );
              await Position.update(dbPos.id, {
                status: 'closed',
                close_reason: 'sync_not_on_exchange',
                closed_at: new Date()
              });
              closedCount++;
            } catch (updateError) {
              logger.error(`[PositionSync] Failed to close position ${dbPos.id}:`, updateError?.message || updateError);
            }
          }
        }
      }
      
      logger.info(
        `[PositionSync] Processed ${processedCount} exchange positions for bot ${botId}, ` +
        `created ${createdCount} missing positions, closed ${closedCount} orphan positions`
      );
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
          current_reduce: strategy.reduce
        });
        
        await EntryOrder.markFilled(entry.id);
        
        logger.info(`[PositionSync] ✅ Created Position ${position.id} from entry_order ${entry.id} for ${normalizedSymbol} ${side}`);
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
      logger.debug(`[PositionSync] No matching strategy found for missing position ${symbol} ${side} on bot ${botId}`);
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
    try {
      const position = await Position.create({
        strategy_id: strategy.id,
        bot_id: botId,
        order_id: `sync_${normalizedSymbol}_${side}_${Date.now()}`, // Traceable order_id
        symbol: normalizedSymbol, // Use normalized symbol for consistency
        side: side,
        entry_price: entryPrice || markPrice,
        amount: amount,
        take_profit_price: tpPrice,
        stop_loss_price: slPrice,
        current_reduce: strategy.reduce
      });

      logger.info(`[PositionSync] ✅ Created missing Position ${position.id} for ${normalizedSymbol} ${side} on bot ${botId} (synced from exchange)`);
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
  async verifyPositionConsistency(dbPos, exPos, exchangeService) {
    try {
      // Parse raw amount first to determine side correctly
      const rawAmt = parseFloat(exPos.positionAmt ?? exPos.contracts ?? 0);
      const contracts = Math.abs(rawAmt);
      const exSide = rawAmt > 0 ? 'long' : rawAmt < 0 ? 'short' : null;
      
      // 1. Check if exchange position is closed (contracts = 0) but DB position is open
      // CRITICAL FIX: Use soft lock to prevent race condition with PositionMonitor
      if (contracts <= 0 && dbPos.status === 'open') {
        try {
          const { pool } = await import('../config/database.js');
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
    } catch (error) {
      logger.warn(`[PositionSync] Error verifying position ${dbPos.id}:`, error?.message || error);
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

    const intervalMinutes = Number(configService.getNumber('POSITION_SYNC_INTERVAL_MINUTES', 5));
    const cronPattern = `*/${intervalMinutes} * * * *`; // Every N minutes

    this.task = cron.schedule(cronPattern, async () => {
      await this.syncPositions();
    }, {
      scheduled: true,
      timezone: 'UTC'
    });

    logger.info(`[PositionSync] Started sync job (every ${intervalMinutes} minutes)`);
    
    // Run immediately on start
    this.syncPositions().catch(err => {
      logger.error('[PositionSync] Error in initial sync:', err);
    });
  }

  /**
   * Stop the sync job
   */
  stop() {
    if (this.task) {
      this.task.stop();
      this.task = null;
      logger.info('[PositionSync] Stopped sync job');
    }
  }
}

