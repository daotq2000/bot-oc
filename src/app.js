import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { testConnection } from './config/database.js';
import { TelegramService } from './services/TelegramService.js';
import { TelegramBot } from './telegram/bot.js';
import { CandleUpdater } from './jobs/CandleUpdater.js';
import { SignalScanner } from './jobs/SignalScanner.js';
import { PositionMonitor } from './jobs/PositionMonitor.js';
import { BalanceManager } from './jobs/BalanceManager.js';
import { exchangeInfoService } from './services/ExchangeInfoService.js';
import { configService } from './services/ConfigService.js';
import { AppConfig } from './models/AppConfig.js';

import routes from './routes/index.js';
import logger from './utils/logger.js';
import { webSocketManager } from './services/WebSocketManager.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api', routes);

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

// Global references for graceful shutdown
let signalScanner = null;


// Initialize services and start server
async function start() {
  try {
    // Test database connection
    logger.info('Testing database connection...');
    const dbConnected = await testConnection();
    if (!dbConnected) {
      logger.error('Database connection failed. Please check your configuration.');
      process.exit(1);
    }
    logger.info('Database connected successfully');

    // Seed required configs into DB (idempotent)
    try {
      logger.info('Seeding default application configs...');
      // Strategy and scanning configs
      await AppConfig.set('ENABLE_LIMIT_ON_EXTEND_MISS', 'true', 'Allow placing passive LIMIT when extend condition is not met');
      await AppConfig.set('ENTRY_ORDER_TTL_MINUTES', '10', 'Minutes before auto-cancel unfilled entry LIMIT orders');
      await AppConfig.set('SIGNAL_SCAN_INTERVAL_MS', '10000', 'Signal scanner job interval in milliseconds');
      await AppConfig.set('CANDLE_UPDATE_INTERVAL_MS', '10000', 'Candle updater job interval in milliseconds');
      
      // Binance API rate limiting and timeout configs
      await AppConfig.set('BINANCE_MIN_REQUEST_INTERVAL_MS', '100', 'Minimum interval (ms) between Binance API requests for rate limiting');
      await AppConfig.set('BINANCE_REST_PRICE_COOLDOWN_MS', '5000', 'Cooldown (ms) before reusing cached REST price fallback');
      await AppConfig.set('BINANCE_REQUEST_TIMEOUT_MS', '10000', 'Timeout (ms) for Binance API requests');
      await AppConfig.set('BINANCE_POSITION_MODE_TTL_MS', '30000', 'TTL (ms) for cached position mode (hedge vs one-way)');
      await AppConfig.set('BINANCE_FUTURES_ENDPOINT', 'https://testnet.binancefuture.com', 'Binance Futures API endpoint (testnet or production)');
      
      // Position monitoring and order management configs
      await AppConfig.set('ENABLE_CANDLE_END_CANCEL_FOR_ENTRY', 'false', 'Enable auto-cancel unfilled entry orders at candle end');
      await AppConfig.set('RECREATE_CANCELED_ENTRY_MINUTES', '2', 'Minutes to wait before recreating manually canceled entry orders');
      await AppConfig.set('SHORT_EXTEND_OVERRIDE', '0', 'Override extend value for SHORT entries (0 = use strategy extend)');
      
      // Position service and SL/TP update configs
      await AppConfig.set('SL_UPDATE_THRESHOLD_TICKS', '1', 'Minimum price ticks change to trigger SL update');
      await AppConfig.set('TP_UPDATE_THRESHOLD_TICKS', '1', 'Minimum price ticks change to trigger TP update');
      
      // WebSocket and connection configs
      await AppConfig.set('BINANCE_TESTNET_WS_BASE', 'wss://stream.binancefuture.com/ws', 'Binance testnet WebSocket base URL');
      await AppConfig.set('LISTEN_KEY_KEEPALIVE_MS', '1800000', 'Interval (ms) to refresh WebSocket listen key (30 minutes)');
      await AppConfig.set('WS_RECONNECT_BACKOFF_MS', '3000', 'Backoff (ms) for WebSocket reconnection attempts');
      
      // Exchange initialization configs
      await AppConfig.set('BINANCE_TESTNET', 'true', 'Use Binance testnet for trading');
      await AppConfig.set('CCXT_SANDBOX', 'false', 'Use CCXT sandbox mode');
      await AppConfig.set('GATE_SANDBOX', 'false', 'Use Gate.io sandbox mode');
      await AppConfig.set('MEXC_SANDBOX', 'false', 'Use MEXC sandbox mode');
      await AppConfig.set('BINANCE_DEFAULT_MARGIN_TYPE', 'CROSSED', 'Default margin type for Binance (ISOLATED or CROSSED)');
      await AppConfig.set('BINANCE_DEFAULT_LEVERAGE', '5', 'Default leverage for Binance positions');
      
      // Concurrency and locking configs
      await AppConfig.set('CONCURRENCY_RESERVATION_TTL_SEC', '120', 'TTL (seconds) for concurrency reservation locks');
      await AppConfig.set('CONCURRENCY_LOCK_TIMEOUT', '5', 'Timeout (seconds) for acquiring concurrency locks');
      
      // Batch processing configs
      await AppConfig.set('SIGNAL_SCAN_BATCH_SIZE', '200', 'Number of strategies to scan in parallel per batch');
      await AppConfig.set('SIGNAL_SCAN_BATCH_DELAY_MS', '300', 'Delay (ms) between signal scan batches');
      await AppConfig.set('POSITION_MONITOR_BATCH_SIZE', '200', 'Number of positions to monitor in parallel per batch');
      await AppConfig.set('POSITION_MONITOR_BATCH_DELAY_MS', '300', 'Delay (ms) between position monitor batches');
      
      // Maintenance
      await AppConfig.set('ENABLE_PRUNE_DELISTED', 'true', 'Enable pruning delisted/non-tradable symbols from strategies and alerts at startup');
    } catch (e) {
      logger.warn(`Failed seeding default configs: ${e?.message || e}`);
    }

    // Load application configs from DB
    logger.info('Loading application configs...');
    await configService.loadAll();

    // Override logger level from DB config if present
    try {
      const newLevel = configService.getString('LOG_LEVEL', null);
      if (newLevel) {
        logger.level = newLevel;
        logger.info(`[Config] Logger level set to ${newLevel} from app_configs`);
      }
    } catch (_) {}

    // Initialize exchange info service (load symbol filters)
    logger.info('Initializing exchange info service...');
    await exchangeInfoService.loadFiltersFromDB();
    
    // Update symbol filters from Binance API (async, don't wait)
    exchangeInfoService.updateFiltersFromExchange()
      .catch(error => logger.error('Failed to update symbol filters from Binance:', error));

    // Prune delisted/non-tradable symbols (strategies & alerts) before starting jobs
    try {
      const enablePrune = configService.getBoolean('ENABLE_PRUNE_DELISTED', true);
      if (enablePrune) {
        logger.info('Pruning delisted/non-tradable Binance symbols from DB...');
        await exchangeInfoService.pruneDelistedSymbols();
      } else {
        logger.info('Delisted symbols pruning is disabled via config ENABLE_PRUNE_DELISTED=false');
      }
    } catch (e) {
      logger.warn(`Pruning step failed: ${e?.message || e}`);
    }

    // Initialize Telegram service
    logger.info('Initializing Telegram service...');
    const telegramService = new TelegramService();
    await telegramService.initialize();

    // Initialize Telegram bot
    logger.info('Initializing Telegram bot...');
    const telegramBot = new TelegramBot();
    telegramBot.start()
      .then(() => logger.info('Telegram bot started'))
      .catch(error => logger.error('Telegram bot failed to start, continuing without it:', error));

    // Initialize and start cron jobs
    logger.info('Initializing cron jobs...');

    // Candle Updater
    const candleUpdater = new CandleUpdater();
    await candleUpdater.initialize();
    candleUpdater.start();

    // Signal Scanner
    signalScanner = new SignalScanner();
    await signalScanner.initialize(telegramService);
    signalScanner.start();

    // Position Monitor
    const positionMonitor = new PositionMonitor();
    await positionMonitor.initialize(telegramService);
    positionMonitor.start();

    // Balance Manager
    const balanceManager = new BalanceManager();
    await balanceManager.initialize(telegramService);
    balanceManager.start();



    // Start HTTP server
    app.listen(PORT, () => {
      logger.info(`Server started on port ${PORT}`);
      logger.info(`API available at http://localhost:${PORT}/api`);
      logger.info('Bot trading system is running...');
    });

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received, shutting down gracefully...');
      if (signalScanner) signalScanner.stop();
      webSocketManager.disconnect();
      await telegramBot.stop();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      logger.info('SIGINT received, shutting down gracefully...');
      if (signalScanner) signalScanner.stop();
      webSocketManager.disconnect();
      await telegramBot.stop();
      process.exit(0);
    });

  } catch (error) {
    logger.error('Failed to start application:', error);
    process.exit(1);
  }
}

// Start the application
start();

export default app;

