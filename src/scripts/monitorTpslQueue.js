import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// A simple logger for standalone script execution
const scriptLogger = {
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
};

/**
 * Script to monitor the status of TP/SL LIFO queues by fetching data from the /health/detailed API endpoint.
 */
async function monitorTpslQueues() {
  scriptLogger.info('='.repeat(60));
  scriptLogger.info('TP/SL Queue Monitor');
  scriptLogger.info('='.repeat(60));

  const port = process.env.PORT || 3000;
  const url = `http://localhost:${port}/health/detailed`;

  try {
    scriptLogger.info(`Fetching data from ${url}...`);
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch health data: ${response.status} ${response.statusText}`);
    }

    const healthData = await response.json();

    const modules = healthData?.modules;
    const positionMonitor = modules?.positionMonitor ?? modules?.position_monitor ?? null;

    if (positionMonitor === null) {
      scriptLogger.error('API returned null for positionMonitor. Please restart the main application to apply the latest changes in app.js.');
      return;
    }

    const queueData = positionMonitor?.tpslQueues ?? positionMonitor?.tpsl_queues;

    if (!queueData) {
      scriptLogger.warn('TP/SL queue data not found in API response. Is the PositionMonitor running and are there any active bots?');
      return;
    }

    if (queueData.length === 0) {
      scriptLogger.info('No active TP/SL queues found.');
      return;
    }

    scriptLogger.info(`Found ${queueData.length} active TP/SL queues:\n`);

    for (const queue of queueData) {
      const { botId, name, pending, inFlight, total } = queue;
      scriptLogger.info(`  [${name || `Bot ${botId}`}]`);
      scriptLogger.info(`    - Pending Tasks: ${pending}`);
      scriptLogger.info(`    - In-Flight Tasks: ${inFlight}`);
      scriptLogger.info(`    - Total Load: ${total}`);
      logger.info('');
    }

  } catch (error) {
    scriptLogger.error('Failed to connect to the application. Is the main application running?');
    scriptLogger.error(`Attempted to connect to: ${url}`);
    scriptLogger.error('Error details:', error.message);
  } finally {
    scriptLogger.info('='.repeat(60));
  }
}

// Run the monitor
monitorTpslQueues()
  .then(() => {
    scriptLogger.info('Queue monitoring script finished.');
    process.exit(0);
  })
  .catch(error => {
    scriptLogger.error('Error running queue monitor script:', error);
    process.exit(1);
  });
