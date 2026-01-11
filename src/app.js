import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { testConnection } from './config/database.js';
import { TelegramService } from './services/TelegramService.js';
import { TelegramBot } from './telegram/bot.js';
import { exchangeInfoService } from './services/ExchangeInfoService.js';
import { SymbolsUpdater } from './jobs/SymbolsUpdater.js';
import { configService } from './services/ConfigService.js';
import { AppConfig } from './models/AppConfig.js';

import routes from './routes/index.js';
import logger from './utils/logger.js';
import { webSocketManager } from './services/WebSocketManager.js';

// Load environment variables
dotenv.config();

// Global error handlers to avoid silent stalls (especially under pm2)
process.on('unhandledRejection', (reason) => {
  // Ignore EPIPE errors (pipe closed) - these are non-critical and happen when stdout/stderr is closed
  if (reason && typeof reason === 'object' && (reason.code === 'EPIPE' || reason.errno === -32)) {
    return; // Silently ignore EPIPE errors
  }
  logger.error('[GLOBAL] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  // Ignore EPIPE errors (pipe closed) - these are non-critical and happen when stdout/stderr is closed
  if (err && (err.code === 'EPIPE' || err.errno === -32 || err.syscall === 'write')) {
    return; // Silently ignore EPIPE errors
  }
  logger.error('[GLOBAL] Uncaught Exception:', err);
  // Do not exit here; pm2 can be configured to restart if needed.
});

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging (reduced to debug level to save memory)
app.use((req, res, next) => {
  logger.debug(`${req.method} ${req.path}`);
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
let priceAlertWorker = null;
let strategiesWorker = null;
let symbolsUpdaterJob = null;
let positionSyncJob = null;
let telegramBot = null;
let telegramService = null;

/**
 * Cleanup all caches and memory structures
 * This function should be called during graceful shutdown to free memory
 */
async function cleanupAllCaches() {
  logger.info('🧹 Starting cleanup of all caches and memory structures...');
  const cleanupStart = Date.now();
  let cleanedCount = 0;
  
  try {
    // 1. OrderStatusCache
    try {
      const { orderStatusCache } = await import('./services/OrderStatusCache.js');
      orderStatusCache.stopCleanupTimer();
      orderStatusCache.clear();
      cleanedCount++;
      logger.info('✅ Cleared OrderStatusCache');
    } catch (e) {
      logger.warn(`⚠️ Failed to clear OrderStatusCache: ${e?.message || e}`);
    }
    
    // 2. StrategyCache
    try {
      const { strategyCache } = await import('./services/StrategyCache.js');
      strategyCache.clear();
      cleanedCount++;
      logger.info('✅ Cleared StrategyCache');
    } catch (e) {
      logger.warn(`⚠️ Failed to clear StrategyCache: ${e?.message || e}`);
    }
    
    // 3. ExchangeInfoService
    try {
      const { exchangeInfoService } = await import('./services/ExchangeInfoService.js');
      exchangeInfoService.destroy();
      cleanedCount++;
      logger.info('✅ Destroyed ExchangeInfoService');
    } catch (e) {
      logger.warn(`⚠️ Failed to destroy ExchangeInfoService: ${e?.message || e}`);
    }
    
    // 4. ConfigService (optional - may want to keep for shutdown)
    // Skipping ConfigService as it may be needed during shutdown
    
    // 5. TelegramService
    try {
      if (telegramService) {
        await telegramService.stop();
        cleanedCount++;
        logger.info('✅ Stopped TelegramService');
      }
    } catch (e) {
      logger.warn(`⚠️ Failed to stop TelegramService: ${e?.message || e}`);
    }
    
    // 6. OrderService caches (if accessible)
    // Note: OrderService instances are per-bot, cleanup handled by service lifecycle
    
    // 7. RealtimeOCDetector
    try {
      const { RealtimeOCDetector } = await import('./services/RealtimeOCDetector.js');
      // RealtimeOCDetector is instantiated per worker, cleanup handled by worker stop
      cleanedCount++;
      logger.info('✅ RealtimeOCDetector cleanup handled by worker stop');
    } catch (e) {
      logger.warn(`⚠️ Failed to cleanup RealtimeOCDetector: ${e?.message || e}`);
    }
    
    // 8. PositionRealtimeCache
    try {
      const { positionRealtimeCache } = await import('./services/PositionRealtimeCache.js');
      positionRealtimeCache.cleanup();
      cleanedCount++;
      logger.info('✅ Cleaned PositionRealtimeCache');
    } catch (e) {
      logger.warn(`⚠️ Failed to cleanup PositionRealtimeCache: ${e?.message || e}`);
    }
    
    // 9. SymbolStateManager
    try {
      const { symbolStateManager } = await import('./services/SymbolStateManager.js');
      symbolStateManager.stopCleanup();
      symbolStateManager.cleanup();
      cleanedCount++;
      logger.info('✅ Cleaned SymbolStateManager');
    } catch (e) {
      logger.warn(`⚠️ Failed to cleanup SymbolStateManager: ${e?.message || e}`);
    }
    
    // 10. WebSocketManager (Binance)
    try {
      webSocketManager.disconnect();
      cleanedCount++;
      logger.info('✅ Disconnected Binance WebSocketManager');
    } catch (e) {
      logger.warn(`⚠️ Failed to disconnect Binance WebSocketManager: ${e?.message || e}`);
    }
    
    // 11. MexcWebSocketManager
    try {
      const { mexcPriceWs } = await import('./services/MexcWebSocketManager.js');
      mexcPriceWs.disconnect();
      cleanedCount++;
      logger.info('✅ Disconnected MEXC WebSocketManager');
    } catch (e) {
      logger.warn(`⚠️ Failed to disconnect MEXC WebSocketManager: ${e?.message || e}`);
    }
    
    // 12. BinanceDirectClient caches (per-instance, handled by service lifecycle)
    // Note: BinanceDirectClient instances are per-bot, cleanup handled by service lifecycle
    // However, we can clear the request queue if accessible
    
    // 13. PositionService internal caches
    // Note: PositionService instances are per-bot, cleanup handled by service lifecycle
    // However, we can clear crossEntryExitPending Map if accessible
    try {
      // PositionService has crossEntryExitPending Map that should be cleared
      // This is per-instance, but we log it for awareness
      logger.debug('PositionService caches are per-instance, cleanup handled by service lifecycle');
    } catch (e) {
      // Ignore - per-instance cleanup
    }
    
    // 14. PriceAlertWorker caches
    if (priceAlertWorker) {
      try {
        // PriceAlertWorker.stop() should handle internal cleanup
        cleanedCount++;
        logger.info('✅ PriceAlertWorker cleanup handled by stop()');
      } catch (e) {
        logger.warn(`⚠️ Failed to cleanup PriceAlertWorker: ${e?.message || e}`);
      }
    }
    
    // 15. StrategiesWorker caches
    if (strategiesWorker) {
      try {
        // StrategiesWorker.stop() should handle internal cleanup
        cleanedCount++;
        logger.info('✅ StrategiesWorker cleanup handled by stop()');
      } catch (e) {
        logger.warn(`⚠️ Failed to cleanup StrategiesWorker: ${e?.message || e}`);
      }
    }
    
    // 16. Clear any remaining intervals/timers
    // Note: Most timers are cleared by individual service stop() methods
    
    // 17. Force garbage collection hint (if available)
    if (global.gc) {
      try {
        global.gc();
        logger.info('✅ Triggered garbage collection');
      } catch (e) {
        logger.debug('Garbage collection not available or failed');
      }
    }
    
    const cleanupDuration = Date.now() - cleanupStart;
    logger.info(`✅ Cleanup completed: ${cleanedCount} caches/services cleaned in ${cleanupDuration}ms`);
    
  } catch (error) {
    logger.error(`❌ Error during cache cleanup: ${error?.message || error}`);
  }
}


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
      // Master alert toggle
      await AppConfig.set('ENABLE_ALERTS', 'true', 'Master switch to enable/disable all Telegram alerts from DB');
      await AppConfig.set('OC_REST_FETCH_MAX_QUEUE', '2000', 'Queue store OC prie value in heap');
      // Strategy and scanning configs
      await AppConfig.set('ENABLE_LIMIT_ON_EXTEND_MISS', 'true', 'Allow placing passive LIMIT when extend condition is not met');
      await AppConfig.set('EXTEND_LIMIT_MAX_DIFF_RATIO', '10', 'Max relative distance (0-1) between current and entry price (as fraction of full extend) to allow passive LIMIT on extend miss');
      await AppConfig.set('ENTRY_ORDER_TTL_MINUTES', '5', 'Minutes before auto-cancel unfilled entry LIMIT orders (applies to all LIMIT entry orders including extend-miss). You can change this in app_configs');
      await AppConfig.set('SIGNAL_SCAN_INTERVAL_MS', '5000', 'Signal scanner job interval in milliseconds');
      await AppConfig.set('NON_BINANCE_TICKER_CACHE_MS', '1500', 'Cache lifetime for non-Binance ticker REST calls (ms)');
      await AppConfig.set('PRICE_ALERT_MODULE_ENABLED', 'true', 'Enable/Disable the entire Price Alert module (workers, scanners, alerts)');
      await AppConfig.set('PRICE_ALERT_CHECK_ENABLED', 'true', 'Enable price alert checking for MEXC and other exchanges');
      await AppConfig.set('PRICE_ALERT_SYMBOL_REFRESH_INTERVAL_MS', '30000', 'Interval to refresh Price Alert symbols from config/DB (ms)');
      await AppConfig.set('PRICE_ALERT_WS_SUBSCRIBE_INTERVAL_MS', '60000', 'Interval to update WebSocket subscriptions for Price Alert (ms)');
      await AppConfig.set('STRATEGIES_CHECK_INTERVAL_MS', '30000', 'Interval to check for active strategies (ms)');
      await AppConfig.set('STRATEGIES_WS_SUBSCRIBE_INTERVAL_MS', '60000', 'Interval to update WebSocket subscriptions for Strategies (ms)');
      await AppConfig.set('WS_OC_SUBSCRIBE_INTERVAL_MS', '60000', 'Interval to update WebSocket subscriptions for OC detection (ms)');
      await AppConfig.set('REALTIME_OC_ENABLED', 'true', 'Enable realtime OC detection from WebSocket (no database candles)');

      // WebSocket OC high-performance configs
      await AppConfig.set('WS_MATCH_CONCURRENCY', '50', 'Max concurrency for processing matched strategies per tick (higher = faster entries, more CPU/API usage)');
      await AppConfig.set('PRICE_ALERTS_STRATEGY_FIRST', 'false', 'If true: when there are active strategies, PriceAlertScanner yields to SignalScanner (strategy-first). If false: always run standalone price alerts.');
      await AppConfig.set('OC_ALERT_SCAN_INTERVAL_MS', '1000', 'Interval for OC alert scan (ms)');
      await AppConfig.set('OC_ALERT_TICK_MIN_INTERVAL_MS', '0', 'Min interval per symbol/interval between alerts on WS tick (ms)');
      await AppConfig.set('PRICE_ALERT_MIN_INTERVAL_MS', '400', 'Min interval per symbol/interval between alerts (ms)');
      await AppConfig.set('PRICE_ALERT_USE_SYMBOL_FILTERS', 'true', 'Use symbol_filters table for price alerts when symbols not specified');
      await AppConfig.set('PRICE_ALERT_MAX_SYMBOLS', '5000', 'Max number of symbols to scan per exchange for price alerts');

      // Binance API rate limiting and timeout configs
      await AppConfig.set('BINANCE_MIN_REQUEST_INTERVAL_MS', '100', 'Minimum interval (ms) between Binance API requests for rate limiting');
      await AppConfig.set('BINANCE_REST_PRICE_COOLDOWN_MS', '5000', 'Cooldown (ms) before reusing cached REST price fallback');
      await AppConfig.set('BINANCE_REQUEST_TIMEOUT_MS', '10000', 'Timeout (ms) for Binance API requests');
      await AppConfig.set('BINANCE_MARKET_DATA_TIMEOUT_MS', '20000', 'Timeout (ms) for Binance market data requests (klines/ticker)');
      await AppConfig.set('BINANCE_POSITION_MODE_TTL_MS', '30000', 'TTL (ms) for cached position mode (hedge vs one-way)');
      await AppConfig.set('BINANCE_RECV_WINDOW_MS', '10000', 'RecvWindow for signed requests (ms)');
      await AppConfig.set('BINANCE_TIME_SYNC_TTL_MS', '600000', 'TTL (ms) for Binance server time sync');
      await AppConfig.set('BINANCE_FUTURES_ENDPOINT', 'https://testnet.binancefuture.com', 'Binance Futures API endpoint (testnet or production)');

      // MEXC API timeout config (higher timeout for slow connections)
      await AppConfig.set('MEXC_API_TIMEOUT_MS', '30000', 'Timeout (ms) for MEXC API requests (higher for slow connections)');

      // Position monitoring and order management configs
      await AppConfig.set('RECREATE_CANCELED_ENTRY_MINUTES', '2', 'Minutes to wait before recreating manually canceled entry orders');
      await AppConfig.set('SHORT_EXTEND_OVERRIDE', '0', 'Override extend value for SHORT entries (0 = use strategy extend)');

      // Position service and SL/TP update configs
      await AppConfig.set('SL_UPDATE_THRESHOLD_TICKS', '1', 'Minimum price ticks change to trigger SL update');
      await AppConfig.set('TP_UPDATE_THRESHOLD_TICKS', '1', 'Minimum price ticks change to trigger TP update');
      await AppConfig.set('TP_SL_PLACEMENT_DELAY_MS', '1000', 'Delay (ms) between TP and SL order placements to avoid rate limits');
      await AppConfig.set('WS_TICK_MIN_INTERVAL_MS', '50', 'Delay (ms) between TP and SL order placements to avoid rate limits');
      await AppConfig.set('WS_TICK_BATCH_SIZE', '150', 'Delay (ms) between TP and SL order placements to avoid rate limits');
      await AppConfig.set('WS_TICK_CONCURRENCY', '20', 'Delay (ms) between TP and SL order placements to avoid rate limits');

      // WebSocket and connection configs
      await AppConfig.set('BINANCE_TESTNET_WS_BASE', 'wss://stream.binancefuture.com/ws', 'Binance testnet WebSocket base URL');
      await AppConfig.set('LISTEN_KEY_KEEPALIVE_MS', '1800000', 'Interval (ms) to refresh WebSocket listen key (30 minutes)');
      await AppConfig.set('WS_RECONNECT_BACKOFF_MS', '3000', 'Backoff (ms) for WebSocket reconnection attempts');
      await AppConfig.set('MEXC_FUTURES_WS_URL', 'wss://contract.mexc.co/edge', 'MEXC Futures WebSocket endpoint (using .co domain for better connectivity)');
      await AppConfig.set('MEXC_WS_COM_FAILOVER_THRESHOLD', '2', 'After N consecutive .com connection failures, prefer .co endpoints until a .com connects successfully');
      await AppConfig.set('MEXC_FUTURES_DIRECT', 'false', 'Use direct REST client for MEXC Futures (bypass CCXT)');
      await AppConfig.set('MEXC_FUTURES_REST_BASE', 'https://contract.mexc.co', 'MEXC Futures REST base URL (using .co domain for better connectivity)');
      await AppConfig.set('WS_SUB_BATCH_SIZE', '150', 'Number of symbols/streams per subscribe batch');
      await AppConfig.set('WS_SUB_BATCH_DELAY_MS', '50', 'Delay between subscribe batches (ms)');
      await AppConfig.set('POSITION_MONITOR_INTERVAL_MS', '40000', 'Interval (ms) between position monitor cycles (increased from 25s to reduce rate limit)');
      await AppConfig.set('POSITION_SYNC_INTERVAL_MS', '60000', 'Interval (ms) between position sync cycles (increased from 40s to reduce rate limit)');

      // REST ticker fallbacks when WS has no price
      await AppConfig.set('BINANCE_TICKER_REST_FALLBACK', 'false', 'Enable REST fallback for Binance ticker price when WS has no price');
      await AppConfig.set('MEXC_TICKER_REST_FALLBACK', 'false', 'Enable REST fallback for MEXC ticker price when WS has no price (futures-only)');

      // Exchange initialization configs
      await AppConfig.set('BINANCE_TESTNET', 'true', 'Use Binance testnet for trading');
      await AppConfig.set('CCXT_SANDBOX', 'false', 'Use CCXT sandbox mode');
      await AppConfig.set('GATE_SANDBOX', 'false', 'Use Gate.io sandbox mode');
      await AppConfig.set('MEXC_SANDBOX', 'false', 'Use MEXC sandbox mode');
      await AppConfig.set('MEXC_ENABLED', 'true', 'Enable MEXC exchange for trading and price alerts');
      await AppConfig.set('MEXC_DEFAULT_LEVERAGE', '5', 'Default leverage for MEXC positions');
      await AppConfig.set('MEXC_FUTURES_ONLY', 'true', 'Futures-only mode for MEXC: disable all spot fallbacks');
      await AppConfig.set('BINANCE_DEFAULT_MARGIN_TYPE', 'CROSSED', 'Default margin type for Binance (ISOLATED or CROSSED)');
      await AppConfig.set('BINANCE_DEFAULT_LEVERAGE', '5', 'Default leverage for Binance positions');
      await AppConfig.set('PRICE_ALERT_USE_SCANNER', 'true', 'Default leverage for Binance positions');
      await AppConfig.set('PRICE_ALERT_USE_WEBSOCKET', 'false', 'Default leverage for Binance positions');
      await AppConfig.set('PRICE_ALERT_SCAN_INTERVAL_MS', '100', 'Default leverage for Binance positions');
      await AppConfig.set('PRICE_ALERT_CONFIG_BATCH_SIZE', '10', 'Default leverage for Binance positions');
      await AppConfig.set('PRICE_ALERT_SYMBOL_BATCH_SIZE', '20', 'Default leverage for Binance positions');

      // Logging configs
      await AppConfig.set('LOG_LEVEL', 'info', 'Log level: error, warn, info, debug, verbose (default: error)');
      await AppConfig.set('LOG_FILE_MAX_SIZE_MB', '10', 'Maximum size (MB) for each log file before rotation');
      await AppConfig.set('LOG_FILE_MAX_FILES', '5', 'Maximum number of rotated log files to keep');

      // Concurrency and locking configs
      await AppConfig.set('CONCURRENCY_RESERVATION_TTL_SEC', '120', 'TTL (seconds) for concurrency reservation locks');
      await AppConfig.set('CONCURRENCY_LOCK_TIMEOUT', '5', 'Timeout (seconds) for acquiring concurrency locks');
      
      // Position sync configs
      await AppConfig.set('POSITION_SYNC_INTERVAL_MINUTES', '1', 'Interval (minutes) to sync positions from exchange to database');

      // Batch processing configs
      await AppConfig.set('SIGNAL_SCAN_BATCH_SIZE', '200', 'Number of strategies to scan in parallel per batch');
      await AppConfig.set('SIGNAL_SCAN_BATCH_DELAY_MS', '300', 'Delay (ms) between signal scan batches');
      await AppConfig.set('POSITION_MONITOR_BATCH_SIZE', '2', 'Number of positions to monitor in parallel per batch (reduced from 3 to reduce rate limit)');
      await AppConfig.set('POSITION_MONITOR_BATCH_DELAY_MS', '2000', 'Delay (ms) between position monitor batches (increased from 300ms to reduce rate limit)');
      await AppConfig.set('BINANCE_MARKET_DATA_MIN_INTERVAL_MS', '200', 'Minimum interval (ms) between Binance market data requests');
      await AppConfig.set('BINANCE_REST_PRICE_COOLDOWN_MS', '10000', 'Cooldown (ms) before reusing cached REST price fallback');
      await AppConfig.set('POSITION_MONITOR_POSITION_DELAY_MS', '1000', 'Delay (ms) between each position in a batch (increased from 500ms to reduce rate limit)');

      // Symbols refresh configs
      await AppConfig.set('ENABLE_SYMBOLS_REFRESH', 'true', 'Enable periodic symbols/filters refresh for exchanges');
      await AppConfig.set('SYMBOLS_REFRESH_CRON', '*/15 * * * *', 'Cron for symbols refresh job (default every 15 minutes)');
      // NOTE: TREND_FILTER configs are now read from bot.config_filter (JSON column in bots table)
      // These AppConfig values are kept as fallback defaults if bot.config_filter is not set
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
    } catch (_) { }

    // Initialize exchange info service (load symbol filters)
    logger.info('Initializing exchange info service...');
    await exchangeInfoService.loadFiltersFromDB();

    // Delay API updates to reduce startup CPU load - run after critical services
    setTimeout(() => {
      // Update symbol filters from Binance API (async, don't wait)
      exchangeInfoService.updateFiltersFromExchange()
        .catch(error => logger.error('Failed to update symbol filters from Binance:', error));
    }, 10000); // Delay 10 seconds

    setTimeout(() => {
      // Update symbol filters from MEXC API (async, don't wait)
      exchangeInfoService.updateMexcFiltersFromExchange()
        .catch(error => logger.error('Failed to update symbol filters from MEXC:', error));
    }, 15000); // Delay 15 seconds


    // Initialize Telegram service
    logger.info('Initializing Telegram service...');
    telegramService = new TelegramService();
    await telegramService.initialize();

    // Delay Telegram bot startup to reduce CPU load
    setTimeout(() => {
      // Initialize Telegram bot
      logger.info('Initializing Telegram bot...');
      telegramBot = new TelegramBot();
      telegramBot.start()
        .then(() => logger.info('Telegram bot started'))
        .catch(error => logger.error('Telegram bot failed to start, continuing without it:', error));
    }, 2000); // Delay 2 seconds

    // Small delay before starting heavy operations
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Initialize and start cron jobs
    logger.info('Initializing cron jobs...');

    // Initialize Binance WebSocket connection for price data
    logger.info('Initializing Binance WebSocket manager...');
    webSocketManager.connect();

    // Initialize MEXC WebSocket connection for price data
    logger.info('Initializing MEXC WebSocket manager...');
    const { mexcPriceWs } = await import('./services/MexcWebSocketManager.js');
    // MEXC WebSocket will auto-connect when symbols are subscribed
    // But we can ensure it's ready by calling ensureConnected() if needed
    // For now, it will connect automatically when PriceAlertWorker subscribes symbols

    // Log WebSocket status after a short delay to allow connections to establish
    setTimeout(() => {
      const wsStatus = webSocketManager.getStatus();
      logger.info(`[Binance-WS] Status: ${wsStatus.connectedCount}/${wsStatus.totalConnections} connections open, ${wsStatus.totalStreams} total streams`);
      
      const mexcWsStatus = mexcPriceWs?.getStatus?.()?.connected ? 'CONNECTED' : 'DISCONNECTED';
      const mexcSubscribed = mexcPriceWs?.subscribed?.size || 0;
      logger.info(`[MEXC-WS] Status: ${mexcWsStatus}, subscribed symbols: ${mexcSubscribed}`);
    }, 2000);

    // ============================================
    // PRICE ALERT WORKER (Always-on, Independent)
    // ============================================
    const alertModuleEnabled = configService.getBoolean('PRICE_ALERT_MODULE_ENABLED', true);
    logger.info('='.repeat(60));
    logger.info(`Initializing Price Alert Worker (Always-on, Independent) - Enabled=${alertModuleEnabled}`);
    logger.info('='.repeat(60));

    if (alertModuleEnabled) {
      // Delay Price Alert Worker initialization to reduce startup CPU load
      setTimeout(async () => {
        try {
          // Pre-load PriceAlertConfig cache on startup (TTL: 30 minutes)
          logger.info('[App] Pre-loading PriceAlertConfig cache...');
          const { PriceAlertConfig } = await import('./models/PriceAlertConfig.js');
          await PriceAlertConfig.findAll(); // This will cache all configs
          logger.info('[App] ✅ PriceAlertConfig cache pre-loaded (TTL: 30 minutes)');
          
          // Small delay before initializing worker
          await new Promise(resolve => setTimeout(resolve, 500));
          
          const { PriceAlertWorker } = await import('./workers/PriceAlertWorker.js');
          priceAlertWorker = new PriceAlertWorker();
          await priceAlertWorker.initialize(telegramService);
          priceAlertWorker.start();
          logger.info('✅ Price Alert Worker started successfully');
        } catch (error) {
          logger.error('❌ CRITICAL: Failed to start Price Alert Worker:', error?.message || error);
          logger.error('Price Alert system is critical - application will continue but alerts may not work');
        }
      }, 3000); // Delay 3 seconds
    } else {
      logger.warn('[App] PRICE_ALERT_MODULE_ENABLED=false → Price Alert Worker not started');
    }

    // ============================================
    // STRATEGIES WORKER (Only when active strategies exist)
    // ============================================
    // Delay Strategies Worker initialization to reduce startup CPU load
    setTimeout(async () => {
      logger.info('='.repeat(60));
      logger.info('Initializing Strategies Worker (Conditional, Independent)...');
      logger.info('='.repeat(60));
      
      try {
        const { StrategiesWorker } = await import('./workers/StrategiesWorker.js');
        strategiesWorker = new StrategiesWorker();
        await strategiesWorker.initialize(telegramService);
        // Strategies worker will auto-start when active strategies are detected
        logger.info('✅ Strategies Worker initialized (will start when active strategies are detected)');
      } catch (error) {
        logger.error('❌ Failed to initialize Strategies Worker:', error?.message || error);
        logger.error('Strategies system failed - Price Alert will continue to work independently');
      }
    }, 5000); // Delay 5 seconds

    // Delay Symbols Updater to reduce startup CPU load
    setTimeout(async () => {
      // Symbols Updater (default every 15 minutes via SYMBOLS_REFRESH_CRON)
      symbolsUpdaterJob = new SymbolsUpdater();
      await symbolsUpdaterJob.initialize();
      symbolsUpdaterJob.start();
    }, 7000); // Delay 7 seconds

    // Position Sync Job - Sync positions from exchange to database
    // Delay to reduce startup CPU load - initialize bots sequentially
    setTimeout(async () => {
      logger.info('='.repeat(60));
      logger.info('Initializing Position Sync Job...');
      logger.info('='.repeat(60));
      try {
        const { PositionSync } = await import('./jobs/PositionSync.js');
        positionSyncJob = new PositionSync();
        await positionSyncJob.initialize();
        positionSyncJob.start();
        logger.info('✅ Position Sync Job started successfully');
      } catch (error) {
        logger.error('❌ Failed to start Position Sync Job:', error?.message || error);
        logger.error('Position sync will not run - positions may become inconsistent');
      }
    }, 8000); // Delay 8 seconds

    // Memory Monitor - Monitor and auto-cleanup when memory usage is high
    logger.info('='.repeat(60));
    logger.info('Initializing Memory Monitor...');
    logger.info('='.repeat(60));
    try {
      const { memoryMonitor } = await import('./utils/MemoryMonitor.js');
      memoryMonitor.start();
      logger.info('✅ Memory Monitor started successfully');
    } catch (error) {
      logger.error('❌ Failed to start Memory Monitor:', error?.message || error);
      // Don't exit - memory monitoring is optional
    }

    // Heartbeat (helps detect event-loop stalls / job stops)
    setInterval(() => {
      try {
        const mem = process.memoryUsage();
        logger.info(`[Heartbeat] alive pid=${process.pid} rssMB=${Math.round(mem.rss / 1024 / 1024)} heapMB=${Math.round(mem.heapUsed / 1024 / 1024)}`);
      } catch (_) {}
    }, 60000);

    // Start HTTP server
    app.listen(PORT, () => {
      logger.info(`Server started on port ${PORT}`);
      logger.info(`API available at http://localhost:${PORT}/api`);
      logger.info('Bot trading system is running...');
    }).on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        logger.error(`❌ Port ${PORT} is already in use. Please stop the existing process or use a different port.`);
        logger.error(`   To find and kill the process: lsof -ti:${PORT} | xargs kill -9`);
        process.exit(1);
      } else {
        logger.error(`❌ Failed to start server on port ${PORT}:`, err?.message || err);
        process.exit(1);
      }
    });

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received, shutting down gracefully...');
      
      // Stop Price Alert Worker
      if (priceAlertWorker) {
        try {
          priceAlertWorker.stop();
        } catch (error) {
          logger.error('Error stopping Price Alert Worker:', error?.message || error);
        }
      }
      
      // Stop Strategies Worker
      if (strategiesWorker) {
        try {
          strategiesWorker.stop();
        } catch (error) {
          logger.error('Error stopping Strategies Worker:', error?.message || error);
        }
      }
      
      // Stop Position Sync Job
      if (positionSyncJob) {
        try {
          positionSyncJob.stop();
        } catch (error) {
          logger.error('Error stopping Position Sync Job:', error?.message || error);
        }
      }
      
      // Cleanup all caches and memory structures
      await cleanupAllCaches();
      
      // Stop Memory Monitor
      try {
        const { memoryMonitor } = await import('./utils/MemoryMonitor.js');
        memoryMonitor.stop();
        logger.info('Stopped Memory Monitor');
      } catch (e) {
        logger.warn('Failed to stop Memory Monitor:', e?.message || e);
      }
      
      // Stop Telegram Bot
      if (telegramBot) {
        try {
          await telegramBot.stop();
          logger.info('Stopped Telegram Bot');
        } catch (e) {
          logger.warn('Failed to stop Telegram Bot:', e?.message || e);
        }
      }
      
      logger.info('✅ Graceful shutdown completed');
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      logger.info('SIGINT received, shutting down gracefully...');
      
      // Stop Price Alert Worker
      if (priceAlertWorker) {
        try {
          priceAlertWorker.stop();
        } catch (error) {
          logger.error('Error stopping Price Alert Worker:', error?.message || error);
        }
      }
      
      // Stop Strategies Worker
      if (strategiesWorker) {
        try {
          strategiesWorker.stop();
        } catch (error) {
          logger.error('Error stopping Strategies Worker:', error?.message || error);
        }
      }
      
      // Stop Position Sync Job
      if (positionSyncJob) {
        try {
          positionSyncJob.stop();
        } catch (error) {
          logger.error('Error stopping Position Sync Job:', error?.message || error);
        }
      }
      
      // Cleanup all caches and memory structures
      await cleanupAllCaches();
      
      // Stop Memory Monitor
      try {
        const { memoryMonitor } = await import('./utils/MemoryMonitor.js');
        memoryMonitor.stop();
        logger.info('Stopped Memory Monitor');
      } catch (e) {
        logger.warn('Failed to stop Memory Monitor:', e?.message || e);
      }
      
      // Stop Telegram Bot
      if (telegramBot) {
        try {
          await telegramBot.stop();
          logger.info('Stopped Telegram Bot');
        } catch (e) {
          logger.warn('Failed to stop Telegram Bot:', e?.message || e);
        }
      }
      
      logger.info('✅ Graceful shutdown completed');
      process.exit(0);
    });

  } catch (error) {
    logger.error('Failed to start application:', error);
    process.exit(1);
  }
}

// Global error handlers to prevent hard crashes on transient network/DNS issues
process.on('unhandledRejection', (reason) => {
  logger.error('[Global] unhandledRejection:', reason?.message || reason, reason?.stack);
});

process.on('uncaughtException', (err) => {
  logger.error('[Global] uncaughtException:', err?.message || err, err?.stack);

  // If it's a known transient network/DNS error, exit so PM2 can restart cleanly.
  const code = err?.code;
  if (code === 'EAI_AGAIN' || code === 'ETIMEDOUT') {
    logger.warn(`[Global] Transient network error (${code}). Exiting for PM2 restart.`);
    process.exit(1);
  }
});

// Start the application
start();

export default app;

