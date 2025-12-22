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
 * Set LOG_LEVEL environment variable to control verbosity (default: 'info')
 * For production, use 'warn' or 'error' to reduce memory usage
 */
const logLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();

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
    // Combined file (warn and above by default, or all if LOG_LEVEL is debug)
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'combined.log'),
      level: logLevel === 'debug' || logLevel === 'verbose' ? 'debug' : 'warn', // Only log warnings and above unless debug mode
      maxsize: 5 * 1024 * 1024, // 5MB (reduced from 10MB to save memory)
      maxFiles: 3, // Reduced from 5 to save disk space
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

export default logger;
