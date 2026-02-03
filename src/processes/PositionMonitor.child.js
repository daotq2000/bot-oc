import logger from '../utils/logger.js';
import { configService } from '../services/ConfigService.js';
import { TelegramService } from '../services/TelegramService.js';
import { MySqlLock } from '../services/MySqlLock.js';
import { PositionMonitor } from '../jobs/PositionMonitor.js';

let monitor = null;
let lockAcquired = false;
let lockName = 'worker:position_monitor';

function send(msg) {
  try {
    if (typeof process.send === 'function') process.send(msg);
  } catch (_) {}
}

function collectStats() {
  try {
    // UPGRADED: Use GlobalTPSLQueueManager instead of old LIFO queues
    const queueManager = monitor?._tpslQueueManager;
    if (queueManager && typeof queueManager.getMetrics === 'function') {
      const metrics = queueManager.getMetrics();
      
      // Convert to array format for backward compatibility
      const queues = Object.entries(metrics.perBot || {}).map(([botId, m]) => ({
        botId,
        name: `TPSLQueue(bot=${botId})`,
        pending: m.pending,
        inFlight: m.inFlight,
        total: m.pending + m.inFlight,
        processed: m.totalProcessed,
        dropped: m.totalDropped,
        timeout: m.totalTimeout,
        failed: m.totalFailed
      }));

      return {
        isRunning: Boolean(monitor?.isRunning),
        tpslQueues: queues,
        globalMetrics: {
          botsCount: metrics.botsCount,
          globalInFlight: metrics.globalInFlight,
          globalWaiters: metrics.globalWaiters,
          totalPending: metrics.totalPending,
          totalInFlight: metrics.totalInFlight,
          totalProcessed: metrics.totalProcessed,
          totalDropped: metrics.totalDropped,
          totalTimeout: metrics.totalTimeout,
          totalFailed: metrics.totalFailed
        }
      };
    }

    // Fallback for old queue structure
    const queues = [];
    const tpsl = monitor?._tpslQueues;
    if (tpsl && typeof tpsl.entries === 'function') {
      for (const [botId, q] of tpsl.entries()) {
        queues.push({
          botId,
          name: q?.name,
          pending: q?.size,
          inFlight: q?.inFlight,
          total: (Number(q?.size) || 0) + (Number(q?.inFlight) || 0)
        });
      }
    }

    return {
      isRunning: Boolean(monitor?.isRunning),
      tpslQueues: queues
    };
  } catch (_) {
    return { isRunning: Boolean(monitor?.isRunning), tpslQueues: [] };
  }
}

async function start() {
  try {
    lockName = String(process.env.WORKER_LOCK_NAME || lockName);
    const lockTimeoutSec = Math.max(0, Number(process.env.WORKER_LOCK_TIMEOUT_SEC || 0));

    lockAcquired = await MySqlLock.tryAcquire(lockName, lockTimeoutSec);
    if (!lockAcquired) {
      logger.warn(`[PositionMonitor.child] Could not acquire GET_LOCK(${lockName}). Exiting.`);
      send({ type: 'status', worker: 'position_monitor', status: 'lock_not_acquired' });
      process.exit(0);
      return;
    }

    send({ type: 'status', worker: 'position_monitor', status: 'starting' });

    await configService.loadAll();

    const telegramService = new TelegramService();
    await telegramService.initialize();

    monitor = new PositionMonitor();
    await monitor.initialize?.(telegramService);

    monitor.start?.();

    send({ type: 'status', worker: 'position_monitor', status: 'running' });

    const heartbeatMs = Math.max(1000, Number(configService.getNumber('WORKER_HEARTBEAT_MS', 5000)) || 5000);
    setInterval(() => {
      send({
        type: 'heartbeat',
        worker: 'position_monitor',
        ts: Date.now(),
        isRunning: Boolean(monitor?.isRunning)
      });
    }, heartbeatMs);

    const statsMs = Math.max(1000, Number(configService.getNumber('POSITION_MONITOR_CHILD_STATS_MS', 5000)) || 5000);
    setInterval(() => {
      const stats = collectStats();
      send({
        type: 'stats',
        worker: 'position_monitor',
        ts: Date.now(),
        stats
      });

      // UPGRADED: Use global metrics from queue manager
      const globalMetrics = stats?.globalMetrics;
      if (globalMetrics) {
        logger.info(
          `[PositionMonitor.child] TP/SL queues | bots=${globalMetrics.botsCount} ` +
          `pending=${globalMetrics.totalPending} inFlight=${globalMetrics.totalInFlight}/${globalMetrics.globalInFlight} ` +
          `processed=${globalMetrics.totalProcessed} dropped=${globalMetrics.totalDropped} ` +
          `timeout=${globalMetrics.totalTimeout} failed=${globalMetrics.totalFailed}`
        );
      } else {
        // Fallback for old format
        const qs = stats?.tpslQueues || [];
        const totalPending = qs.reduce((acc, x) => acc + (Number(x?.pending) || 0), 0);
        const totalInFlight = qs.reduce((acc, x) => acc + (Number(x?.inFlight) || 0), 0);
        logger.info(`[PositionMonitor.child] TP/SL queues | bots=${qs.length} pending=${totalPending} inFlight=${totalInFlight}`);
      }
    }, statsMs);
  } catch (e) {
    logger.error(`[PositionMonitor.child] Failed to start: ${e?.message || e}`, { stack: e?.stack });
    send({ type: 'status', worker: 'position_monitor', status: 'error', error: e?.message || String(e) });
    process.exit(1);
  }
}

async function shutdown(signal) {
  try {
    send({ type: 'status', worker: 'position_monitor', status: 'stopping', signal });
    if (monitor?.stop) {
      try { monitor.stop(); } catch (_) {}
    }
  } finally {
    if (lockAcquired) {
      await MySqlLock.release(lockName);
      lockAcquired = false;
    }
    send({ type: 'status', worker: 'position_monitor', status: 'stopped', signal });
    process.exit(0);
  }
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'shutdown') {
    shutdown('ipc').catch(() => process.exit(0));
  }
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
