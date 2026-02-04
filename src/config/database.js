import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'bot_oc',
  waitForConnections: true,
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '30'), // Increased from 15 to 30 for high-frequency WebSocket processing
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000, // Send keepalive after 10 seconds of inactivity
  connectTimeout: 10000, // 10 seconds connection timeout
  // Auto-reconnect settings for better resilience
  maxIdle: 10, // Max idle connections to keep in pool
  idleTimeout: 60000 // Close idle connections after 60 seconds
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

