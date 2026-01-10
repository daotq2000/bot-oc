import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure logs directory exists
const LOG_DIR = path.join(__dirname, '../../logs');
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
} catch (_) {
  // ignore
}

/**
 * Winston logger configuration
 * 
 * Log levels: error, warn, info, http, verbose, debug, silly
 * Set LOG_LEVEL environment variable or app_configs to control verbosity (default: 'info')
 * For production, use 'warn' or 'error' to reduce memory usage
 * 
 * Priority: app_configs > env variable > default
 */
const logLevel = (process.env.LOG_LEVEL || 'error').toLowerCase();

const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'bot-oc' },
  // Ignore EPIPE errors silently (pipe closed errors are non-critical)
  exitOnError: false,
  transports: [
    // Write all logs to console
    (() => {
      const consoleTransport = new winston.transports.Console({
      handleExceptions: true,
      handleRejections: true,
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          let msg = `${timestamp} [${level}]: ${message}`;
          const rest = Object.keys(meta || {}).length > 0 ? ` ${typeof meta === 'string' ? meta : JSON.stringify(meta)}` : '';
          return msg + rest;
        })
      )
      });
      
      // Wrap log method to silently handle EPIPE errors (pipe closed when stdout/stderr is closed by PM2)
      const originalLog = consoleTransport.log.bind(consoleTransport);
      consoleTransport.log = function(info, callback) {
        try {
          originalLog(info, (err) => {
            // Ignore EPIPE errors (non-critical - happens when stdout/stderr pipe is closed)
            if (err && (err.code === 'EPIPE' || err.errno === -32 || err.syscall === 'write')) {
              return; // Silently ignore
            }
            if (callback) callback(err);
          });
        } catch (err) {
          // Ignore EPIPE errors in try-catch as well
          if (err && (err.code === 'EPIPE' || err.errno === -32 || err.syscall === 'write')) {
            return; // Silently ignore
          }
          if (callback) callback(err);
        }
      };
      
      return consoleTransport;
    })(),
    // Error file (only errors)
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024, // 5MB (reduced from 10MB to save memory)
      maxFiles: 3, // Reduced from 5 to save disk space
      tailable: true,
      handleExceptions: true,
      handleRejections: true
    }),
    // Combined file (info and above by default, or all if LOG_LEVEL is debug)
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'combined.log'),
      level: logLevel === 'debug' || logLevel === 'verbose' ? 'debug' : 'info', // Log info and above (changed from 'warn')
      maxsize: 10 * 1024 * 1024, // 10MB (increased for more detailed logs)
      maxFiles: 5, // Increased to keep more history
      tailable: true
    })
  ],
  exceptionHandlers: [
    new winston.transports.File({ 
      filename: path.join(LOG_DIR, 'exceptions.log'),
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 2
    })
  ],
  rejectionHandlers: [
    new winston.transports.File({ 
      filename: path.join(LOG_DIR, 'rejections.log'),
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 2
    })
  ]
});

/**
 * Update logger level dynamically
 * @param {string} level - New log level (error, warn, info, debug, verbose)
 */
logger.setLevel = function(level) {
  const validLevels = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];
  const newLevel = level.toLowerCase();
  
  if (!validLevels.includes(newLevel)) {
    logger.warn(`Invalid log level: ${level}. Valid levels: ${validLevels.join(', ')}`);
    return false;
  }
  
  this.level = newLevel;
  this.transports.forEach(transport => {
    if (transport.filename && transport.filename.includes('combined.log')) {
      transport.level = newLevel === 'debug' || newLevel === 'verbose' ? 'debug' : 'info';
    }
  });
  
  logger.info(`Log level updated to: ${newLevel}`);
  return true;
};

/**
 * Order-specific logger
 * - orders.log: info and warning logs for order creation
 * - orders-error.log: error logs for order creation
 */
const orderLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      // Simple format: timestamp level: message
      let msg = `${timestamp} [${level.toUpperCase()}]: ${message}`;
      const rest = Object.keys(meta || {}).filter(k => k !== 'service').length > 0 
        ? ` ${JSON.stringify(Object.fromEntries(Object.entries(meta).filter(([k]) => k !== 'service')))}` 
        : '';
      return msg + rest;
    })
  ),
  defaultMeta: { service: 'bot-oc-orders' },
  transports: [
    // orders.log: info and warning
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'orders.log'),
      level: 'warn', // warn and info (warn includes info)
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      tailable: true
    }),
    // orders-error.log: errors only
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'orders-error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 3,
      tailable: true,
      handleExceptions: false,
      handleRejections: false
    })
  ]
});

export { orderLogger };
export default logger;
