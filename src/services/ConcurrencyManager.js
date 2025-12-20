import pool from '../config/database.js';
import logger from '../utils/logger.js';

/**
 * ConcurrencyManager - Strong consistency with MySQL advisory locks + reservations
 * Guarantees no more than max_concurrent_trades open/reserved at any moment across threads/processes
 */
class ConcurrencyManager {
  constructor() {}

  /**
   * Initialize not strictly required in DB-backed version; kept for compatibility
   */
  initializeBot(botId, maxConcurrent) {
    // No-op: limit is stored in DB (bots.max_concurrent_trades)
    logger.info(`[ConcurrencyManager] Initialized bot ${botId} with max_concurrent_trades=${maxConcurrent}`);
  }

  /**
   * Get current open positions count for a bot
   */
  async getOpenPositionsCount(botId) {
    const [rows] = await pool.execute(
      `SELECT COUNT(*) as cnt
       FROM positions p
       JOIN strategies s ON p.strategy_id = s.id
       WHERE s.bot_id = ? AND p.status = 'open'`,
      [botId]
    );
    return Number(rows?.[0]?.cnt || 0);
  }

  /**
   * Get active reservations count for a bot
   */
  async getActiveReservationsCount(botId) {
    // Only count recent 'active' reservations to avoid stale locks after crashes
    const { configService } = await import('./ConfigService.js');
    const ttlSec = Number(configService.getNumber('CONCURRENCY_RESERVATION_TTL_SEC', 120));
    try {
      const [rows] = await pool.execute(
        `SELECT COUNT(*) as cnt
         FROM concurrency_reservations
         WHERE bot_id = ? AND status = 'active' AND created_at >= (NOW() - INTERVAL ? SECOND)`,
        [botId, ttlSec]
      );
      return Number(rows?.[0]?.cnt || 0);
    } catch (e) {
      // Fallback if created_at column not available
      const [fallback] = await pool.execute(
        `SELECT COUNT(*) as cnt
         FROM concurrency_reservations
         WHERE bot_id = ? AND status = 'active'`,
        [botId]
      );
      return Number(fallback?.[0]?.cnt || 0);
    }
  }

  /**
   * Read configured max_concurrent_trades for a bot
   */
  async getMaxConcurrent(botId) {
    const [rows] = await pool.execute(
      `SELECT COALESCE(max_concurrent_trades, 5) AS max_concurrent_trades FROM bots WHERE id = ?`,
      [botId]
    );
    return Number(rows?.[0]?.max_concurrent_trades || 5);
  }

  /**
   * Quick check without reservation (may race) used for early skip
   */
  async canAcceptNewPosition(botId) {
    const [maxConcurrent, openCnt, activeReservations] = await Promise.all([
      this.getMaxConcurrent(botId),
      this.getOpenPositionsCount(botId),
      this.getActiveReservationsCount(botId)
    ]);
    return (openCnt + activeReservations) < maxConcurrent;
  }

  /**
   * Reserve a slot atomically using advisory lock
   * Returns reservation token string if success, null otherwise
   */
  async reserveSlot(botId) {
    const lockName = `conc_bot_${botId}`;
    // Per-bot timeout override if set; else global config
    // Increased default timeout to handle high concurrency scenarios
    let timeoutSec = 10; // Increased from 5 to 10 seconds
    try {
      const [rows] = await pool.execute('SELECT concurrency_lock_timeout FROM bots WHERE id = ?', [botId]);
      const botTimeout = Number(rows?.[0]?.concurrency_lock_timeout);
      if (Number.isFinite(botTimeout) && botTimeout > 0) timeoutSec = botTimeout;
    } catch (_) {}
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
      const { configService } = await import('./ConfigService.js');
      timeoutSec = Number(configService.getNumber('CONCURRENCY_LOCK_TIMEOUT', 10)); // Increased default from 5 to 10
    }

    let conn;
    try {
      conn = await pool.getConnection();
      // Acquire advisory lock on SAME connection
      const [lockRows] = await conn.execute(`SELECT GET_LOCK(?, ?) AS got`, [lockName, timeoutSec]);
      const got = Number(lockRows?.[0]?.got || 0);
      if (got !== 1) {
        logger.warn(`[ConcurrencyManager] Failed to acquire advisory lock for bot ${botId}`);
        const err = new Error('CONCURRENCY_LOCK_TIMEOUT');
        err.code = 'CONCURRENCY_LOCK_TIMEOUT';
        throw err;
      }

      try {
        // Re-check counts under lock using SAME connection
        const { configService } = await import('./ConfigService.js');
        const ttlSec = Number(configService.getNumber('CONCURRENCY_RESERVATION_TTL_SEC', 120));

        // Max concurrent
        const [[maxRows]] = await Promise.all([
          conn.execute(`SELECT COALESCE(max_concurrent_trades, 5) AS max_concurrent_trades FROM bots WHERE id = ?`, [botId])
        ]);
        const maxConcurrent = Number(maxRows?.[0]?.max_concurrent_trades || 5);

        // Open positions
        const [openRows] = await conn.execute(
          `SELECT COUNT(*) as cnt
           FROM positions p
           JOIN strategies s ON p.strategy_id = s.id
           WHERE s.bot_id = ? AND p.status = 'open'`,
          [botId]
        );
        const openCnt = Number(openRows?.[0]?.cnt || 0);

        // Active reservations with TTL, fallback if created_at not present
        let activeReservations = 0;
        try {
          const [resRows] = await conn.execute(
            `SELECT COUNT(*) as cnt
             FROM concurrency_reservations
             WHERE bot_id = ? AND status = 'active' AND created_at >= (NOW() - INTERVAL ? SECOND)`,
            [botId, ttlSec]
          );
          activeReservations = Number(resRows?.[0]?.cnt || 0);
        } catch (_) {
          const [resRows] = await conn.execute(
            `SELECT COUNT(*) as cnt
             FROM concurrency_reservations
             WHERE bot_id = ? AND status = 'active'`,
            [botId]
          );
          activeReservations = Number(resRows?.[0]?.cnt || 0);
        }

        if ((openCnt + activeReservations) >= maxConcurrent) {
          logger.warn(`[ConcurrencyManager] Limit reached for bot ${botId}: open=${openCnt}, reservations=${activeReservations}, max=${maxConcurrent}`);
          return null;
        }

        // Create reservation on SAME connection
        const token = this._generateToken(botId);
        await conn.execute(
          `INSERT INTO concurrency_reservations (bot_id, token, status) VALUES (?, ?, 'active')`,
          [botId, token]
        );
        logger.debug(`[ConcurrencyManager] Reserved slot for bot ${botId}, token=${token}`);
        return token;
      } finally {
        // Always release lock using SAME connection
        try { await conn.execute(`DO RELEASE_LOCK(?)`, [lockName]); } catch (_) {}
      }
    } catch (e) {
      logger.error(`[ConcurrencyManager] reserveSlot error: ${e?.message || e}`);
      return null;
    } finally {
      try { conn?.release?.(); } catch (_) {}
    }
  }

  /**
   * Finalize reservation: mark as released (position opened) or cancelled (failed)
   */
  async finalizeReservation(botId, token, outcome = 'released') {
    if (!token) return;
    const status = outcome === 'released' ? 'released' : 'cancelled';
    try {
      await pool.execute(
        `UPDATE concurrency_reservations
         SET status = ?, released_at = NOW()
         WHERE bot_id = ? AND token = ? AND status = 'active'`,
        [status, botId, token]
      );
      logger.debug(`[ConcurrencyManager] Finalized reservation ${token} for bot ${botId} -> ${status}`);
    } catch (e) {
      logger.warn(`[ConcurrencyManager] finalizeReservation failed for bot ${botId}, token=${token}: ${e?.message || e}`);
    }
  }

  /**
   * Get detailed status
   */
  async getStatus(botId) {
    const [maxConcurrent, openCnt, activeReservations] = await Promise.all([
      this.getMaxConcurrent(botId),
      this.getOpenPositionsCount(botId),
      this.getActiveReservationsCount(botId)
    ]);

    const total = openCnt + activeReservations;
    const utilizationPercent = Math.round((total / Math.max(maxConcurrent, 1)) * 100);
    const available = Math.max(0, maxConcurrent - total);

    return {
      botId,
      currentCount: total,
      openPositions: openCnt,
      reservations: activeReservations,
      maxConcurrent,
      available,
      isFull: total >= maxConcurrent,
      utilizationPercent
    };
  }

  _generateToken(botId) {
    return `${botId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export const concurrencyManager = new ConcurrencyManager();

