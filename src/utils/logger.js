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
  transports: [
    // Write all logs to console
    new winston.transports.Console({
      handleExceptions: true,
      handleRejections: true,
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          let msg = `${timestamp} [${level}]: ${message}`;
          const rest = Object.keys(meta || {}).length > 0 ? ` ${JSON.stringify(meta)}` : '';
          return msg + rest;
        })
      )
    }),
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

export default logger;
