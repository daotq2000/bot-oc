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
      
      if (!Array.isArray(exchangePositions) || exchangePositions.length === 0) {
        logger.debug(`[PositionSync] No positions on exchange for bot ${botId}`);
        return; // No positions on exchange
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
      const normalizeSymbol = (symbol) => {
        if (!symbol) return symbol;
        let normalizedSymbol = symbol;
        normalizedSymbol = normalizedSymbol.replace(/\/USDT:USDT$/, 'USDT'); // MEXC format
        normalizedSymbol = normalizedSymbol.replace(/\/USDT$/, 'USDT'); // Standard format with slash
        normalizedSymbol = normalizedSymbol.replace(/_USDT$/, 'USDT'); // Gate format
        normalizedSymbol = normalizedSymbol.replace(/\//g, ''); // Remove any remaining slashes
        return normalizedSymbol;
      };

      // Create a map of DB positions by *normalized* symbol+side
      // This prevents duplicates like "H/USDT" vs "HUSDT" for the same underlying coin.
      const dbPositionsMap = new Map();
      for (const pos of dbPositions) {
        const rawSym = pos.symbol;
        const normSym = normalizeSymbol(rawSym);
        const keyRaw = `${rawSym}_${pos.side}`;
        const keyNorm = `${normSym}_${pos.side}`;
        dbPositionsMap.set(keyRaw, pos);
        dbPositionsMap.set(keyNorm, pos);
      }

      // Process exchange positions
      let processedCount = 0;
      let createdCount = 0;
      for (const exPos of exchangePositions) {
        try {
          // Normalize position data
          const symbol = exPos.symbol || exPos.info?.symbol || exPos.market;
          const contracts = exPos.contracts ?? Math.abs(parseFloat(exPos.positionAmt || exPos.size || 0));
          const side = contracts > 0 ? 'long' : (contracts < 0 ? 'short' : null);
          
          if (!symbol || !side || Math.abs(contracts) <= 0) {
            logger.debug(`[PositionSync] Skipping invalid position: symbol=${symbol}, side=${side}, contracts=${contracts}`);
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
          const dbPos = dbPositionsMap.get(key1) || dbPositionsMap.get(key2);

          if (!dbPos) {
            // Position exists on exchange but not in database - try to find matching entry_order or strategy
            logger.info(`[PositionSync] Position ${normalizedSymbol} ${side} exists on exchange but not in database, attempting to create...`);
            try {
              const created = await this.createMissingPosition(botId, normalizedSymbol, side, exPos, exchangeService);
              if (created) createdCount++;
            } catch (createError) {
              logger.error(`[PositionSync] Failed to create position ${normalizedSymbol} ${side}:`, createError?.message || createError);
            }
          } else {
            // Position exists in both - verify consistency
            await this.verifyPositionConsistency(dbPos, exPos, exchangeService);
          }
          processedCount++;
        } catch (error) {
          logger.warn(`[PositionSync] Error processing exchange position ${exPos.symbol || 'unknown'}:`, error?.message || error);
        }
      }
      
      logger.info(`[PositionSync] Processed ${processedCount} exchange positions for bot ${botId}, created ${createdCount} missing positions`);
    } catch (error) {
      logger.error(`[PositionSync] Error syncing bot ${botId}:`, error?.message || error);
      throw error;
    }
  }

  /**
   * Create Position record for position that exists on exchange but not in database
   * @param {number} botId - Bot ID
   * @param {string} symbol - Symbol (normalized)
   * @param {string} side - 'long' or 'short'
   * @param {Object} exPos - Exchange position data
   * @param {ExchangeService} exchangeService - Exchange service instance
   */
  async createMissingPosition(botId, symbol, side, exPos, exchangeService) {
    try {
      // SAFEGUARD: ensure we never create more than one open Position
      // per (botId, normalized symbol, side). This prevents cases where
      // the same net position on exchange is represented by many DB rows.
      const normalizeSymbol = (sym) => {
        if (!sym) return sym;
        let normalizedSymbol = sym;
        normalizedSymbol = normalizedSymbol.replace(/\/USDT:USDT$/, 'USDT');
        normalizedSymbol = normalizedSymbol.replace(/\/USDT$/, 'USDT');
        normalizedSymbol = normalizedSymbol.replace(/_USDT$/, 'USDT');
        normalizedSymbol = normalizedSymbol.replace(/\//g, '');
        return normalizedSymbol;
      };

      const normalizedSymbol = normalizeSymbol(symbol);

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

      // Try to find matching entry_order first
      const [entryOrders] = await pool.execute(
        `SELECT * FROM entry_orders 
         WHERE bot_id = ? AND symbol = ? AND side = ? AND status = 'open'
         ORDER BY created_at DESC LIMIT 1`,
        [botId, symbol, side]
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
          const tpPrice = calculateTakeProfit(entryPrice, strategy.oc, strategy.take_profit, side);
          const rawStoploss = strategy.stoploss !== undefined ? Number(strategy.stoploss) : NaN;
          const isStoplossValid = Number.isFinite(rawStoploss) && rawStoploss > 0;
          const slPrice = isStoplossValid ? calculateInitialStopLoss(entryPrice, rawStoploss, side) : null;
          
          // Check concurrency
          // Concurrency management removed
          const reservationToken = entry.reservation_token 
            ? entry.reservation_token 
            : 'disabled'; // Concurrency disabled
          
          if (!reservationToken) {
            const status = await concurrencyManager.getStatus(botId);
            logger.warn(`[PositionSync] Cannot create Position from entry_order ${entry.id}: limit reached (${status.currentCount}/${status.maxConcurrent})`);
            return false;
          }
          
          try {
            const position = await Position.create({
              strategy_id: entry.strategy_id,
              bot_id: botId,
              order_id: entry.order_id,
              symbol: entry.symbol,
              side: side,
              entry_price: entryPrice,
              amount: entry.amount,
              take_profit_price: tpPrice,
              stop_loss_price: slPrice,
              current_reduce: strategy.reduce
            });
            
            await EntryOrder.markFilled(entry.id);
            // await concurrencyManager.finalizeReservation(botId, reservationToken, 'released');
            
            logger.info(`[PositionSync] ✅ Created Position ${position.id} from entry_order ${entry.id} for ${symbol} ${side}`);
            return true;
          } catch (posError) {
            // await concurrencyManager.finalizeReservation(botId, reservationToken, 'cancelled');
            throw posError;
          }
        } catch (error) {
          logger.error(`[PositionSync] Error creating Position from entry_order ${entry.id}:`, error?.message || error);
          return false;
        }
      }

      // Try to find matching strategy
      const [strategies] = await pool.execute(
        `SELECT * FROM strategies 
         WHERE bot_id = ? AND symbol = ? AND is_active = TRUE
         ORDER BY created_at DESC LIMIT 1`,
        [botId, symbol]
      );

      if (strategies.length === 0) {
        logger.debug(`[PositionSync] No matching strategy found for missing position ${symbol} ${side} on bot ${botId}`);
        return false; // Can't create Position without strategy
      }

      const strategy = strategies[0];

      // Get position details from exchange
      const entryPrice = parseFloat(exPos.entryPrice || exPos.info?.entryPrice || exPos.markPrice || 0);
      const contracts = exPos.contracts ?? Math.abs(parseFloat(exPos.positionAmt || 0));
      const markPrice = parseFloat(exPos.markPrice || exPos.info?.markPrice || entryPrice || 0);
      
      // Calculate amount in USDT (approximate)
      const amount = Math.abs(contracts * markPrice);

      // Calculate TP/SL
      const { calculateTakeProfit, calculateInitialStopLoss } = await import('../utils/calculator.js');
      const tpPrice = calculateTakeProfit(entryPrice || markPrice, strategy.oc, strategy.take_profit, side);
      const rawStoploss = strategy.stoploss !== undefined ? Number(strategy.stoploss) : NaN;
      const isStoplossValid = Number.isFinite(rawStoploss) && rawStoploss > 0;
      const slPrice = isStoplossValid ? calculateInitialStopLoss(entryPrice || markPrice, rawStoploss, side) : null;

      // Check concurrency limit before creating
      const { concurrencyManager } = await import('../services/ConcurrencyManager.js');
      // const canAccept = await concurrencyManager.canAcceptNewPosition(botId);
      const canAccept = true; // Concurrency disabled
      if (!canAccept) {
        const status = await concurrencyManager.getStatus(botId);
        logger.warn(`[PositionSync] Cannot create Position for ${symbol} ${side}: max concurrent limit reached (${status.currentCount}/${status.maxConcurrent})`);
        return false;
      }

      // Reserve slot
      // const reservationToken = await concurrencyManager.reserveSlot(botId);
      const reservationToken = 'disabled'; // Concurrency disabled
      if (!reservationToken) {
        const status = await concurrencyManager.getStatus(botId);
        logger.warn(`[PositionSync] Failed to reserve slot for ${symbol} ${side}: limit reached (${status.currentCount}/${status.maxConcurrent})`);
        return false;
      }

      try {
        // Create Position record
        const position = await Position.create({
          strategy_id: strategy.id,
          bot_id: botId,
          order_id: `sync_${Date.now()}`, // Placeholder order_id
          symbol: symbol,
          side: side,
          entry_price: entryPrice || markPrice,
          amount: amount,
          take_profit_price: tpPrice,
          stop_loss_price: slPrice,
          current_reduce: strategy.reduce
        });

        // Finalize reservation
        // await concurrencyManager.finalizeReservation(botId, reservationToken, 'released');

        logger.info(`[PositionSync] ✅ Created missing Position ${position.id} for ${symbol} ${side} on bot ${botId} (synced from exchange)`);
        return true;
      } catch (error) {
        // Cancel reservation if Position creation failed
        // await concurrencyManager.finalizeReservation(botId, reservationToken, 'cancelled');
        logger.error(`[PositionSync] Failed to create Position for ${symbol} ${side}:`, error?.message || error);
        throw error;
      }
    } catch (error) {
      logger.error(`[PositionSync] Error creating missing position for ${symbol} ${side}:`, error?.message || error);
      return false;
    }
  }

  /**
   * Verify consistency between database and exchange position
   * @param {Object} dbPos - Database position
   * @param {Object} exPos - Exchange position
   * @param {ExchangeService} exchangeService - Exchange service instance
   */
  async verifyPositionConsistency(dbPos, exPos, exchangeService) {
    try {
      const contracts = exPos.contracts ?? Math.abs(parseFloat(exPos.positionAmt || 0));
      
      // If exchange position is closed (contracts = 0) but DB position is open, mark as closed
      if (Math.abs(contracts) <= 0 && dbPos.status === 'open') {
        logger.warn(`[PositionSync] Position ${dbPos.id} is open in DB but closed on exchange, marking as closed`);
        await Position.update(dbPos.id, {
          status: 'closed',
          close_reason: 'sync_exchange_closed',
          closed_at: new Date()
        });
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

