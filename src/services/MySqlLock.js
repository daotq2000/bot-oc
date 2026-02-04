import pool from '../config/database.js';
import logger from '../utils/logger.js';

export class MySqlLock {
  // Store dedicated connections for locks to prevent connection reuse issues
  static _lockConnections = new Map();

  /**
   * Try to acquire a MySQL user-level lock
   * Uses a dedicated connection to ensure lock is properly maintained
   */
  static async tryAcquire(name, timeoutSec = 0) {
    const lockName = String(name || '').slice(0, 64);
    const t = Math.max(0, Number(timeoutSec) || 0);

    try {
      // Get a dedicated connection for this lock
      const connection = await pool.getConnection();
      
      const [rows] = await connection.execute('SELECT GET_LOCK(?, ?) AS ok', [lockName, t]);
      const ok = rows && rows[0] ? Number(rows[0].ok) : 0;
      
      if (ok === 1) {
        // Store connection so we can release lock on the same connection
        this._lockConnections.set(lockName, connection);
        return true;
      } else {
        // Lock not acquired, release connection back to pool
        connection.release();
        return false;
      }
    } catch (e) {
      logger.error(`[MySqlLock] GET_LOCK failed for ${lockName}: ${e?.message || e}`);
      return false;
    }
  }

  /**
   * Release a MySQL user-level lock
   * Must use the same connection that acquired the lock
   */
  static async release(name) {
    const lockName = String(name || '').slice(0, 64);
    const connection = this._lockConnections.get(lockName);
    
    try {
      if (connection) {
        try {
          // Release lock on the same connection that acquired it
          await connection.execute('SELECT RELEASE_LOCK(?)', [lockName]);
        } catch (releaseErr) {
          // Connection may have been lost - this is expected in some cases
          const errMsg = releaseErr?.message || String(releaseErr);
          if (errMsg.includes('Connection lost') || errMsg.includes('closed')) {
            logger.debug(`[MySqlLock] Connection lost during RELEASE_LOCK for ${lockName} (lock auto-released by MySQL)`);
          } else {
            logger.warn(`[MySqlLock] RELEASE_LOCK failed for ${lockName}: ${errMsg}`);
          }
        } finally {
          // Always try to release connection back to pool
          try {
            connection.release();
          } catch (_) {
            // Connection already destroyed, ignore
          }
          this._lockConnections.delete(lockName);
        }
      } else {
        // No dedicated connection found, try with pool (legacy behavior)
        // This can happen if lock was acquired with old code or connection was lost
        try {
          await pool.execute('SELECT RELEASE_LOCK(?)', [lockName]);
        } catch (poolErr) {
          const errMsg = poolErr?.message || String(poolErr);
          if (errMsg.includes('Connection lost') || errMsg.includes('closed')) {
            // When connection lost, MySQL automatically releases user-level locks
            // This is not an error - the lock is already released
            logger.debug(`[MySqlLock] Connection lost - lock ${lockName} auto-released by MySQL`);
          } else {
            logger.warn(`[MySqlLock] RELEASE_LOCK (pool) failed for ${lockName}: ${errMsg}`);
          }
        }
      }
      return true;
    } catch (e) {
      logger.warn(`[MySqlLock] RELEASE_LOCK failed for ${lockName}: ${e?.message || e}`);
      return false;
    }
  }

  /**
   * Force cleanup all lock connections
   * Useful during shutdown
   */
  static async cleanup() {
    for (const [lockName, connection] of this._lockConnections) {
      try {
        await connection.execute('SELECT RELEASE_LOCK(?)', [lockName]);
        connection.release();
      } catch (_) {
        // Ignore errors during cleanup
      }
    }
    this._lockConnections.clear();
  }
}


