import pool from '../src/config/database.js';
import logger from '../src/utils/logger.js';

/**
 * Cleanup candle and prune related configs from app_config table
 */
async function cleanupCandleConfigs() {
  try {
    logger.info('[Cleanup] Starting cleanup of candle and prune related configs...');

    // List of config keys to delete
    const configsToDelete = [
      'CANDLE_UPDATE_INTERVAL_MS',
      'CANDLE_FETCH_LIMIT',
      'CANDLE_UPDATE_CONCURRENCY',
      'CANDLE_UPDATE_BATCH_DELAY_MS',
      'WS_CANDLE_FLUSH_INTERVAL_MS',
      'CANDLES_PRUNE_MODE',
      'CANDLES_RETENTION_DAYS',
      'CANDLES_KEEP_LAST_PER_INTERVAL',
      'CANDLES_PRUNE_BATCH_LIMIT',
      'CANDLES_PRUNE_CRON',
      'ENABLE_CANDLE_END_CANCEL_FOR_ENTRY',
      'ENABLE_PRUNE_DELISTED'
    ];

    let deletedCount = 0;

    for (const key of configsToDelete) {
      try {
        const [result] = await pool.execute(
          'DELETE FROM app_configs WHERE config_key = ?',
          [key]
        );
        
        if (result.affectedRows > 0) {
          deletedCount++;
          logger.info(`[Cleanup] ✅ Deleted config: ${key}`);
        } else {
          logger.debug(`[Cleanup] Config not found: ${key}`);
        }
      } catch (error) {
        logger.error(`[Cleanup] Failed to delete config ${key}:`, error?.message || error);
      }
    }

    logger.info(`[Cleanup] ✅ Cleanup completed. Deleted ${deletedCount} config(s) out of ${configsToDelete.length} checked.`);

    // Verify cleanup
    logger.info('[Cleanup] Verifying cleanup...');
    const placeholders = configsToDelete.map(() => '?').join(',');
    const [remaining] = await pool.execute(
      `SELECT config_key FROM app_configs WHERE config_key IN (${placeholders})`,
      configsToDelete
    );

    if (remaining.length > 0) {
      logger.warn(`[Cleanup] ⚠️  Warning: ${remaining.length} config(s) still exist in database:`);
      remaining.forEach(row => {
        logger.warn(`[Cleanup]   - ${row.config_key}`);
      });
    } else {
      logger.info('[Cleanup] ✅ Verification passed: All candle/prune configs have been removed.');
    }

    process.exit(0);
  } catch (error) {
    logger.error('[Cleanup] ❌ Cleanup failed:', error?.message || error);
    console.error(error);
    process.exit(1);
  }
}

cleanupCandleConfigs();

