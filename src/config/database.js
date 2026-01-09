import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Determine the environment
const env = process.env.NODE_ENV || 'development';

// Get current file directory (ESM way)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Construct the path to config.json relative to project root
// src/config/database.js -> config/config.json
const configPath = path.resolve(__dirname, '..', '..', 'config', 'config.json');

let dbConfig;
let actualConfigPath = null;
try {
  // Check if file exists at primary path
  if (!fs.existsSync(configPath)) {
    // Fallback: try from process.cwd() (for PM2 or different working directories)
    const fallbackPath = path.join(process.cwd(), 'config', 'config.json');
    if (fs.existsSync(fallbackPath)) {
      actualConfigPath = fallbackPath;
      const configFile = fs.readFileSync(fallbackPath, 'utf8');
      const config = JSON.parse(configFile);
      dbConfig = config[env];
    } else {
      throw new Error(`Config file not found at ${configPath} or ${fallbackPath}`);
    }
  } else {
    actualConfigPath = configPath;
    const configFile = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configFile);
    dbConfig = config[env];
  }
} catch (error) {
  console.error(`Failed to read or parse database configuration from config/config.json:`, error);
  console.error(`Environment: ${env}, Config path tried: ${configPath}`);
  if (actualConfigPath) {
    console.error(`Actual config path used: ${actualConfigPath}`);
  }
  console.error(`Current working directory: ${process.cwd()}`);
  console.error(`__dirname: ${__dirname}`);
  process.exit(1);
}

if (!dbConfig) {
  console.error(`Database configuration for environment '${env}' not found in config/config.json.`);
  if (actualConfigPath && fs.existsSync(actualConfigPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(actualConfigPath, 'utf8'));
      console.error(`Available environments in config: ${Object.keys(config).join(', ')}`);
    } catch (e) {
      // Ignore parse error
    }
  }
  process.exit(1);
}

const pool = mysql.createPool({
  host: dbConfig.host || 'localhost',
  port: parseInt(dbConfig.port || '3306'),
  user: dbConfig.username || 'root',
  password: dbConfig.password || '',
  database: dbConfig.database,
  waitForConnections: true,
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '30'),
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  connectTimeout: 10000 // 10 seconds connection timeout
});

/**
 * Test database connection
 */
export async function testConnection() {
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    return true;
  } catch (error) {
    console.error('Database connection failed:', error);
    return false;
  }
}

export default pool;
