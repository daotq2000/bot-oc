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

      for (const bot of bots) {
        await this.addBot(bot);
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
      const exchangePositions = await exchangeService.exchange.fetchPositions();
      if (!Array.isArray(exchangePositions) || exchangePositions.length === 0) {
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

      // Create a map of DB positions by symbol+side
      const dbPositionsMap = new Map();
      for (const pos of dbPositions) {
        const key = `${pos.symbol}_${pos.side}`;
        dbPositionsMap.set(key, pos);
      }

      // Process exchange positions
      for (const exPos of exchangePositions) {
        try {
          // Normalize position data
          const symbol = exPos.symbol || exPos.info?.symbol;
          const contracts = exPos.contracts ?? Math.abs(parseFloat(exPos.positionAmt || 0));
          const side = contracts > 0 ? 'long' : (contracts < 0 ? 'short' : null);
          
          if (!symbol || !side || Math.abs(contracts) <= 0) {
            continue; // Skip invalid positions
          }

          // Normalize symbol format (remove /USDT, etc)
          const normalizedSymbol = symbol.replace(/\/USDT$/, 'USDT').replace('/', '');

          // Check if position exists in database
          const key = `${normalizedSymbol}_${side}`;
          const dbPos = dbPositionsMap.get(key);

          if (!dbPos) {
            // Position exists on exchange but not in database - try to find matching entry_order or strategy
            await this.createMissingPosition(botId, normalizedSymbol, side, exPos, exchangeService);
          } else {
            // Position exists in both - verify consistency
            await this.verifyPositionConsistency(dbPos, exPos, exchangeService);
          }
        } catch (error) {
          logger.warn(`[PositionSync] Error processing exchange position ${exPos.symbol}:`, error?.message || error);
        }
      }
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
      // Try to find matching entry_order first
      const [entryOrders] = await pool.execute(
        `SELECT * FROM entry_orders 
         WHERE bot_id = ? AND symbol = ? AND side = ? AND status = 'open'
         ORDER BY created_at DESC LIMIT 1`,
        [botId, symbol, side]
      );

      if (entryOrders.length > 0) {
        const entry = entryOrders[0];
        logger.info(`[PositionSync] Found matching entry_order ${entry.id} for missing position ${symbol} ${side}, will trigger EntryOrderMonitor`);
        // EntryOrderMonitor will handle this, but we can also try to create Position directly
        // For now, just log - EntryOrderMonitor should pick it up
        return;
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
        return; // Can't create Position without strategy
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
      const canAccept = await concurrencyManager.canAcceptNewPosition(botId);
      if (!canAccept) {
        const status = await concurrencyManager.getStatus(botId);
        logger.warn(`[PositionSync] Cannot create Position for ${symbol} ${side}: max concurrent limit reached (${status.currentCount}/${status.maxConcurrent})`);
        return;
      }

      // Reserve slot
      const reservationToken = await concurrencyManager.reserveSlot(botId);
      if (!reservationToken) {
        const status = await concurrencyManager.getStatus(botId);
        logger.warn(`[PositionSync] Failed to reserve slot for ${symbol} ${side}: limit reached (${status.currentCount}/${status.maxConcurrent})`);
        return;
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
        await concurrencyManager.finalizeReservation(botId, reservationToken, 'released');

        logger.info(`[PositionSync] ✅ Created missing Position ${position.id} for ${symbol} ${side} on bot ${botId} (synced from exchange)`);
      } catch (error) {
        // Cancel reservation if Position creation failed
        await concurrencyManager.finalizeReservation(botId, reservationToken, 'cancelled');
        throw error;
      }
    } catch (error) {
      logger.error(`[PositionSync] Error creating missing position for ${symbol} ${side}:`, error?.message || error);
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

