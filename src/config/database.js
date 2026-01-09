import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';

// Determine the environment
const env = process.env.NODE_ENV || 'development';

// Construct the path to config.json
// Assuming the project root is two levels up from src/config
const configPath = path.join(process.cwd(), 'config', 'config.json');

let dbConfig;
try {
  const configFile = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(configFile);
  dbConfig = config[env];
} catch (error) {
  console.error('Failed to read or parse database configuration from config/config.json:', error);
  process.exit(1);
}

if (!dbConfig) {
  console.error(`Database configuration for environment '${env}' not found in config/config.json.`);
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
