import { parentPort } from 'worker_threads';
import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';
import { PositionMonitor } from '../jobs/PositionMonitor.js';
import { TelegramService } from '../services/TelegramService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create a dedicated logger for this worker to avoid blocking the main thread's I/O
const workerLogger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'bot-oc-pm-worker' },
  transports: [
    new winston.transports.File({
      filename: path.join(__dirname, '../../../logs', 'position-monitor.log'),
      level: 'info',
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 3,
      tailable: true
    })
  ]
});

let positionMonitor;

async function initializeAndStart() {
  try {
    workerLogger.info('[PositionMonitorWorker] Initializing...');
    
    // The worker thread should be self-contained, so it initializes its own services.
    const telegramService = new TelegramService();
    // We pass the dedicated worker logger to the service
    await telegramService.initialize(workerLogger);

    positionMonitor = new PositionMonitor(workerLogger);
    await positionMonitor.initialize(telegramService);
    positionMonitor.start();

    workerLogger.info('[PositionMonitorWorker] ✅ Started successfully.');
    parentPort.postMessage({ status: 'started' });
  } catch (error) {
    workerLogger.error('❌ CRITICAL: Failed to start Position Monitor Worker:', { message: error?.message || error, stack: error?.stack });
    parentPort.postMessage({ status: 'error', error: error.message });
    process.exit(1);
  }
}

parentPort.on('message', (message) => {
  if (message === 'start') {
    initializeAndStart().catch(err => {
        workerLogger.error(`[PositionMonitorWorker] Unhandled exception on start: ${err.message}`);
    });
  }
});
