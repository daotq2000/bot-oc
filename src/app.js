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
import { watchdogService } from './services/WatchdogService.js';
import { candleDbFlusher } from './services/CandleDbFlusher.js';
import { logMonitorService } from './services/LogMonitorService.js';
import { ChildProcessManager } from './services/ChildProcessManager.js';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// ✅ ENHANCED: Detailed health check endpoint for monitoring
app.get('/health/detailed', async (req, res) => {
  try {
    const { webSocketOCConsumer } = await import('./consumers/WebSocketOCConsumer.js');
    const wsStatus = webSocketManager.getStatus();
    const ocStats = webSocketOCConsumer.getStats();
    const candleFlushStats = candleDbFlusher.getStats();
    
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      childProcesses: childProcessManager.getStatus(),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024)
      },
      modules: {
        priceAlertWorker: priceAlertWorker ? {
          isRunning: priceAlertWorker.isRunning || false,
          scannerRunning: priceAlertWorker.scanner?.isRunning || false
        } : null,
        positionSync: positionSyncJob ? {
          isRunning: positionSyncJob.isRunning || false
        } : null,
        webSocketOC: {
          isRunning: ocStats.isRunning,
          ticksReceived: ocStats.stats?.ticksReceived || 0,
          ticksProcessed: ocStats.stats?.ticksProcessed || 0,
          matchesFound: ocStats.stats?.matchesFound || 0,
          queueSize: ocStats.queueSize,
          timeSinceLastTick: ocStats.stats?.timeSinceLastTick || null,
          timeSinceLastProcessed: ocStats.stats?.timeSinceLastProcessed || null,
          timeSinceLastMatch: ocStats.stats?.timeSinceLastMatch || null
        },
        webSocketManager: {
          connections: wsStatus.connectedCount,
          totalConnections: wsStatus.totalConnections,
          totalStreams: wsStatus.totalStreams,
          tickQueue: wsStatus.tickQueue,
          reconnectQueue: wsStatus.reconnectQueue,
          messageStats: wsStatus.messageStats
        },
        candleDbFlusher: candleFlushStats,
        positionMonitor: positionMonitor ? {
          tpslQueues: Array.from(positionMonitor._tpslQueues.entries()).map(([botId, queue]) => ({
            botId,
            name: queue.name,
            pending: queue.size,
            inFlight: queue.inFlight,
            total: queue.size + queue.inFlight
          }))
        } : null
      }
    };
    
    // Determine overall health status
    const isHealthy = 
      ocStats.isRunning &&
      wsStatus.connectedCount > 0 &&
      (ocStats.stats?.timeSinceLastTick === null || ocStats.stats.timeSinceLastTick < 60000); // Last tick within 1 minute
    
    health.status = isHealthy ? 'ok' : 'degraded';
    
    res.json(health);
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error?.message || String(error),
      timestamp: new Date().toISOString()
    });
  }
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
export let positionMonitor = null;

const childProcessManager = new ChildProcessManager();


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
      await AppConfig.set('WS_OC_GATE_LOG_ENABLED', 'true', 'Enable detailed gate decision logs for OC entries (pass/fail reasons). WARNING: can be noisy');
      await AppConfig.set('RVOL_FILTER_ENABLED', 'true', 'Enable/Disable RVOL (relative volume) gate for FOLLOWING_TREND entries');
      await AppConfig.set('RVOL_MIN', '1.2', 'Minimum RVOL (5m) required for FOLLOWING_TREND entries');
      await AppConfig.set('RVOL_PERIOD', '20', 'Lookback length for RVOL SMA(volume) on 5m candles');
      await AppConfig.set('DONCHIAN_FILTER_ENABLED', 'true', 'Enable/Disable Donchian breakout gate (5m) for FOLLOWING_TREND entries');
      await AppConfig.set('DONCHIAN_PERIOD', '20', 'Lookback length for Donchian channel on 5m candles');

      // WebSocket OC high-performance configs
      await AppConfig.set('WS_MATCH_CONCURRENCY', '50', 'Max concurrency for processing matched strategies per tick (higher = faster entries, more CPU/API usage)');
      await AppConfig.set('PRICE_ALERTS_STRATEGY_FIRST', 'false', 'If true: when there are active strategies, PriceAlertScanner yields to SignalScanner (strategy-first). If false: always run standalone price alerts.');
      await AppConfig.set('OC_ALERT_SCAN_INTERVAL_MS', '5000', 'Interval for OC alert scan (ms)');
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
      
      // Debug configs
      await AppConfig.set('DEBUG_OC_DETECTION', 'true', 'Enable detailed OC detection debug logs (very noisy)');
      await AppConfig.set('DEBUG_OC_SYMBOL', '', 'Only debug OC for this specific symbol (empty = all symbols)');

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
      await AppConfig.set('PRICE_ALERT_USE_WEBSOCKET', 'true', 'Default leverage for Binance positions');
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
      // Position Monitor - Optimized for high-volume processing
      await AppConfig.set('POSITION_MONITOR_BATCH_SIZE', '5', 'Number of positions per batch for general processing (increased for better throughput)');
      await AppConfig.set('POSITION_MONITOR_TP_BATCH_SIZE', '10', 'Number of positions per batch for TP/SL placement (larger batch for urgent TP placement)');
      await AppConfig.set('POSITION_MONITOR_MONITORING_BATCH_SIZE', '8', 'Number of positions per batch for monitoring (parallel monitoring)');
      await AppConfig.set('POSITION_MONITOR_TP_BATCH_DELAY_MS', '300', 'Delay (ms) between TP/SL placement batches (reduced for faster processing)');
      await AppConfig.set('POSITION_MONITOR_MONITORING_BATCH_DELAY_MS', '200', 'Delay (ms) between monitoring batches (reduced for faster processing)');
      await AppConfig.set('POSITION_MONITOR_MAX_TIME_PER_BOT_MS', '300000', 'Max processing time (ms) per bot before moving to next bot (5 minutes)');
      await AppConfig.set('BINANCE_MARKET_DATA_MIN_INTERVAL_MS', '200', 'Minimum interval (ms) between Binance market data requests');
      await AppConfig.set('BINANCE_REST_PRICE_COOLDOWN_MS', '10000', 'Cooldown (ms) before reusing cached REST price fallback');

      // Symbols refresh configs
      await AppConfig.set('ENABLE_SYMBOLS_REFRESH', 'true', 'Enable periodic symbols/filters refresh for exchanges');
      await AppConfig.set('SYMBOLS_REFRESH_CRON', '*/15 * * * *', 'Cron for symbols refresh job (default every 15 minutes)');
      await AppConfig.set('ADV_TPSL_MTF_ENABLED', 'true', 'Cron for symbols refresh job (default every 15 minutes)');
      await AppConfig.set('ADV_TPSL_AUTO_OPTIMIZE_ENABLED', 'true', 'Cron for symbols refresh job (default every 15 minutes)');
      await AppConfig.set('ADV_TPSL_ENABLED', 'true', 'Cron for symbols refresh job (default every 15 minutes)');
      await AppConfig.set('ADV_TPSL_SR_ENABLED', 'true', 'Cron for symbols refresh job (default every 15 minutes)');
      await AppConfig.set('BINANCE_WS_TICK_WORKER_COUNT', '10', 'Cron for symbols refresh job (default every 15 minutes)');
      await AppConfig.set('BINANCE_WS_TICK_DRAIN_BATCH_SIZE', '2000', 'Cron for symbols refresh job (default every 15 minutes)');
      await AppConfig.set('BINANCE_WS_TICK_DRAIN_TIME_BUDGET_MS', '25', 'Cron for symbols refresh job (default every 15 minutes)');
      await AppConfig.set('BINANCE_WS_PONG_TIMEOUT_MS', '30000', 'Cron for symbols refresh job (default every 15 minutes)');
      await AppConfig.set('BINANCE_WS_MAX_CONCURRENT_RECONNECTS', '1', 'Cron for symbols refresh job (default every 15 minutes)');
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
        .catch(error => logger.error('Failed to update symbol filters from Binance', { err: error?.message, stack: error?.stack }));
    }, 10000); // Delay 10 seconds

    setTimeout(() => {
      // Update symbol filters from MEXC API (async, don't wait)
      exchangeInfoService.updateMexcFiltersFromExchange()
        .catch(error => logger.error('Failed to update symbol filters from MEXC', { err: error?.message, stack: error?.stack }));
    }, 15000); // Delay 15 seconds


    // Initialize Telegram service
    logger.info('Initializing Telegram service...');
    const telegramService = new TelegramService();
    await telegramService.initialize();

    // Delay Telegram bot startup to reduce CPU load
    setTimeout(() => {
      // Initialize Telegram bot
      logger.info('Initializing Telegram bot...');
      telegramBot = new TelegramBot();
      telegramBot.start()
        .then(() => logger.info('Telegram bot started'))
        .catch(error => logger.error('Telegram bot failed to start, continuing without it', { err: error?.message, stack: error?.stack }));
    }, 2000); // Delay 2 seconds

    // Small delay before starting heavy operations
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Initialize and start cron jobs
    logger.info('Initializing cron jobs...');

    // Initialize Binance WebSocket connection for price data
    logger.info('Initializing Binance WebSocket manager...');
    // webSocketManager.connect(); // Connect is now called implicitly by consumer subscriptions

    // ✅ FIX: Initialize and start WebSocket OC Consumer independently and unconditionally
    logger.info('Initializing WebSocket OC Consumer...');
    const { webSocketOCConsumer } = await import('./consumers/WebSocketOCConsumer.js');
    await webSocketOCConsumer.initialize(); // Initialize with empty OrderServices first
    webSocketOCConsumer.start();
    logger.info('✅ WebSocket OC Consumer started.');

    // ✅ Log monitor: detect WS errors in combined.log/error.log and auto-recover
    try {
      const projectRoot = process.cwd();
      const combinedPath = process.env.LOG_MONITOR_COMBINED_PATH || path.join(projectRoot, 'logs', 'combined.log');
      const errorPath = process.env.LOG_MONITOR_ERROR_PATH || path.join(projectRoot, 'logs', 'error.log');

      logMonitorService.configure({
        logFiles: [combinedPath, errorPath],
        pollIntervalMs: Number(process.env.LOG_MONITOR_POLL_MS || 1000),
        defaultCooldownMs: Number(process.env.LOG_MONITOR_COOLDOWN_MS || 15000),
        onEvent: (evt) => {
          try {
            const type = evt?.type;

            if (type === 'recover_binance_ws' || type === 'recover_network') {
              logger.warn(`[LogMonitor] Auto-fix: ${type} | ${evt?.message || ''}`);
              // Best-effort: reconnect all shards
              try {
                for (const conn of webSocketManager.connections || []) {
                  if (!conn) continue;
                  // Use existing safe reconnect logic
                  webSocketManager._scheduleReconnect?.(conn);
                }
              } catch (_) {}
            }

            if (type === 'recover_mexc_ws') {
              logger.warn(`[LogMonitor] Auto-fix: ${type} | ${evt?.message || ''}`);
              import('./services/MexcWebSocketManager.js').then(({ mexcPriceWs }) => {
                mexcPriceWs?.ensureConnected?.();
              }).catch(() => {});
            }

            if (type === 'recover_tick_starvation') {
              logger.warn(`[LogMonitor] Auto-fix: ${type} | ${evt?.message || ''}`);
              // Force refresh subscriptions (idempotent)
              webSocketOCConsumer.subscribeWebSockets?.().catch(() => {});
              import('./services/MexcWebSocketManager.js').then(({ mexcPriceWs }) => {
                mexcPriceWs?.ensureConnected?.();
              }).catch(() => {});
            }
          } catch (e) {
            logger.warn(`[LogMonitor] handler error: ${e?.message || e}`);
          }
        },
        tickStarvation: {
          enabled: true,
          thresholdMs: Number(process.env.LOG_MONITOR_TICK_STARVATION_MS || 60000),
          checkEveryMs: Number(process.env.LOG_MONITOR_TICK_STARVATION_CHECK_MS || 10000),
          getState: () => {
            try {
              const st = webSocketOCConsumer.getStats?.();
              const timeSinceLastTick = st?.stats?.timeSinceLastTick ?? null;
              return {
                isRunning: Boolean(st?.isRunning),
                timeSinceLastTick
              };
            } catch (_) {
              return null;
            }
          }
        }
      });
      logMonitorService.start();
    } catch (e) {
      logger.warn(`[LogMonitor] Failed to start (non-critical): ${e?.message || e}`);
    }

    // Start auto DB persistence for closed candles (Aggregator -> DB) after WS init
    setTimeout(() => {
      try {
        candleDbFlusher.start();
      } catch (e) {
        logger.warn(`[App] Failed to start CandleDbFlusher (non-critical): ${e?.message || e}`);
      }
    }, 3000);

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
          const { alertMode } = await import('./services/AlertMode.js');
          const useScanner = alertMode.useScanner();
          const useWebSocket = alertMode.useWebSocket();
          logger.info(`[App] Price Alert Mode: scanner=${useScanner} (polling), websocket=${useWebSocket} (realtime)`);

          // Pre-load PriceAlertConfig cache on startup (TTL: 30 minutes)
          logger.info('[App] Pre-loading PriceAlertConfig cache...');
          const { PriceAlertConfig } = await import('./models/PriceAlertConfig.js');
          await PriceAlertConfig.findAll(); // This will cache all configs
          logger.info('[App] ✅ PriceAlertConfig cache pre-loaded (TTL: 30 minutes)');
          
          // Small delay before initializing worker
          await new Promise(resolve => setTimeout(resolve, 500));
          
          logger.info('[App] Starting Price Alert Worker...');
          const { PriceAlertWorker } = await import('./workers/PriceAlertWorker.js');
          priceAlertWorker = new PriceAlertWorker();
          await priceAlertWorker.initialize(telegramService);
          await priceAlertWorker.start();

          // ✅ Verify worker status after start()
          const workerStatus = priceAlertWorker.getStatus();
          if (workerStatus.isRunning) {
            logger.info('✅ Price Alert Worker started successfully');
            logger.info(`[App] Worker Status: ${JSON.stringify(workerStatus)}`);
          } else {
            logger.error('❌ CRITICAL: Price Alert Worker start() was called but isRunning is false. The system may be disabled by other settings.');
          }
        } catch (error) {
          logger.error('❌ CRITICAL: Failed to start Price Alert Worker:', { message: error?.message || error, stack: error?.stack });
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

    // ============================================
    // POSITION MONITOR (Always-on, in a separate Worker Thread)
    // ============================================
    setTimeout(() => {
      logger.info('='.repeat(60));
      logger.info('Initializing Position Monitor as a child process (fork)...');
      logger.info('='.repeat(60));

      try {
        childProcessManager.start(
          'positionMonitor',
          'processes/PositionMonitor.child.js',
          {
            WORKER_LOCK_NAME: 'worker:position_monitor',
            WORKER_LOCK_TIMEOUT_SEC: '0'
          },
          { autoRestart: true }
        );
      } catch (error) {
        logger.error('❌ CRITICAL: Failed to start Position Monitor child process:', { message: error?.message || error, stack: error?.stack });
      }
    }, 6000); // Delay 6 seconds

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
        await positionSyncJob.initialize(telegramService); // Pass TelegramService for alert notifications
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

    // Start HTTP server
    app.listen(PORT, () => {
      logger.info(`Server started on port ${PORT}`);
      logger.info(`API available at http://localhost:${PORT}/api`);
      logger.info('Bot trading system is running...');
      // Start watchdog after server is up
      watchdogService.start({
        sampleIntervalMs: Number(process.env.WATCHDOG_SAMPLE_MS || 10000),
        thresholdMs: Number(process.env.WATCHDOG_DELAY_THRESHOLD_MS || 400),
        consecutiveTriggers: Number(process.env.WATCHDOG_CONSECUTIVE || 3),
        degradeDurationMs: Number(process.env.WATCHDOG_DEGRADE_MS || 10 * 60 * 1000)
      });
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
      
      // Stop CandleDbFlusher
      try {
        candleDbFlusher.stop();
      } catch (e) {
        logger.warn('Error stopping CandleDbFlusher:', e?.message || e);
      }

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
      
      // Cleanup WebSocket connections
      webSocketManager.disconnect();
      // Cleanup MEXC WebSocket
      try {
        const { mexcPriceWs } = await import('./services/MexcWebSocketManager.js');
        mexcPriceWs.disconnect();
        logger.info('Disconnected MEXC WebSocket');
      } catch (e) {
        logger.warn('Failed to disconnect MEXC WebSocket:', e?.message || e);
      }
      
      // Cleanup all caches to free memory
      try {
        const { orderStatusCache } = await import('./services/OrderStatusCache.js');
        orderStatusCache.clear();
        logger.info('Cleared OrderStatusCache');
      } catch (e) {
        logger.warn('Failed to clear OrderStatusCache:', e?.message || e);
      }
      
      // Stop Memory Monitor
      try {
        const { memoryMonitor } = await import('./utils/MemoryMonitor.js');
        memoryMonitor.stop();
        logger.info('Stopped Memory Monitor');
      } catch (e) {
        logger.warn('Failed to stop Memory Monitor:', e?.message || e);
      }
      
      try {
        childProcessManager.stopAll();
      } catch (_) {}

      if (telegramBot) {
        if (telegramBot) {
        await telegramBot.stop();
      }
      }
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      logger.info('SIGINT received, shutting down gracefully...');
      
      // Stop CandleDbFlusher
      try {
        candleDbFlusher.stop();
      } catch (e) {
        logger.warn('Error stopping CandleDbFlusher:', e?.message || e);
      }

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
      
      // Cleanup WebSocket connections
      webSocketManager.disconnect();
      // Cleanup MEXC WebSocket
      try {
        const { mexcPriceWs } = await import('./services/MexcWebSocketManager.js');
        mexcPriceWs.disconnect();
        logger.info('Disconnected MEXC WebSocket');
      } catch (e) {
        logger.warn('Failed to disconnect MEXC WebSocket:', e?.message || e);
      }
      
      // Cleanup all caches to free memory
      try {
        const { orderStatusCache } = await import('./services/OrderStatusCache.js');
        orderStatusCache.clear();
        logger.info('Cleared OrderStatusCache');
      } catch (e) {
        logger.warn('Failed to clear OrderStatusCache:', e?.message || e);
      }

      // Stop Memory Monitor
      try {
        const { memoryMonitor } = await import('./utils/MemoryMonitor.js');
        memoryMonitor.stop();
        logger.info('Stopped Memory Monitor');
      } catch (e) {
        logger.warn('Failed to stop Memory Monitor:', e?.message || e);
      }
      
      try {
        childProcessManager.stopAll();
      } catch (_) {}

      await telegramBot.stop();
      process.exit(0);
    });

  } catch (error) {
    logger.error('Failed to start application', { err: error?.message, stack: error?.stack });
    process.exit(1);
  }
}

// Start the application
start();

export default app;

