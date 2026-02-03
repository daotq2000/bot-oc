import pool from '../config/database.js';
import logger from '../utils/logger.js';

export class MySqlLock {
  static async tryAcquire(name, timeoutSec = 0) {
    const lockName = String(name || '').slice(0, 64);
    const t = Math.max(0, Number(timeoutSec) || 0);

    try {
      const [rows] = await pool.execute('SELECT GET_LOCK(?, ?) AS ok', [lockName, t]);
      const ok = rows && rows[0] ? Number(rows[0].ok) : 0;
      return ok === 1;
    } catch (e) {
      logger.error(`[MySqlLock] GET_LOCK failed for ${lockName}: ${e?.message || e}`);
      return false;
    }
  }

  static async release(name) {
    const lockName = String(name || '').slice(0, 64);
    try {
      await pool.execute('SELECT RELEASE_LOCK(?)', [lockName]);
      return true;
    } catch (e) {
      logger.warn(`[MySqlLock] RELEASE_LOCK failed for ${lockName}: ${e?.message || e}`);
      return false;
    }
  }
}

