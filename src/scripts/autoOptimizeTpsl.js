import { configService } from '../services/ConfigService.js';
import logger from '../utils/logger.js';
import pool from '../config/database.js';
import { AutoOptimizeService } from '../services/AutoOptimizeService.js';

/**
 * One-off optimizer runner:
 *   node src/scripts/autoOptimizeTpsl.js --strategyId=123
 *   node src/scripts/autoOptimizeTpsl.js --all
 */
async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const strategyArg = args.find(a => a.startsWith('--strategyId='));
  const strategyId = strategyArg ? Number(strategyArg.split('=')[1]) : null;

  if (!all && !Number.isFinite(strategyId)) {
    console.error('Usage: node src/scripts/autoOptimizeTpsl.js --all OR --strategyId=123');
    process.exit(1);
  }

  // Ensure enabled for this run
  process.env.ADV_TPSL_AUTO_OPTIMIZE_ENABLED = 'true';
  configService.reload?.();

  const svc = new AutoOptimizeService();
  if (all) {
    const [rows] = await pool.execute('SELECT id FROM strategies');
    const ids = (rows || []).map(r => Number(r.id)).filter(Boolean);
    logger.info(`[AutoOptimizeRunner] Running for ${ids.length} strategies...`);
    for (const id of ids) {
      await svc.maybeOptimize(id);
    }
  } else {
    await svc.maybeOptimize(strategyId);
  }
  logger.info('[AutoOptimizeRunner] done');
}

main().catch(e => {
  logger.error('[AutoOptimizeRunner] failed:', e?.message || e);
  process.exit(1);
});


