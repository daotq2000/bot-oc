/**
 * Migration: Add is_reverse_strategy column to bots table
 * 
 * This column determines the trading strategy:
 * - true (default): Reverse strategy - bullish → SHORT, bearish → LONG
 * - false: Trend-following strategy - bullish → LONG, bearish → SHORT
 * 
 * Created: 2025-12-26
 */

'use strict';

const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config();

async function getPool() {
  return mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'bot_oc',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });
}

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const pool = await getPool();
    try {
      // Check if column already exists
      const [results] = await pool.execute(
        `SELECT COUNT(*) as count 
         FROM INFORMATION_SCHEMA.COLUMNS 
         WHERE TABLE_SCHEMA = DATABASE() 
         AND TABLE_NAME = 'bots' 
         AND COLUMN_NAME = 'is_reverse_strategy'`
      );

      if (results[0].count === '0') {
        console.log('Adding is_reverse_strategy column to bots table...');
        
        await pool.execute(`
          ALTER TABLE bots 
          ADD COLUMN is_reverse_strategy TINYINT(1) DEFAULT 1 NOT NULL
          COMMENT 'Trading strategy: 1 = reverse (bullish→SHORT, bearish→LONG), 0 = trend-following (bullish→LONG, bearish→SHORT)'
        `);

        console.log('✅ Added is_reverse_strategy column to bots table');
      } else {
        console.log('⚠️  Column is_reverse_strategy already exists, skipping...');
      }
    } catch (error) {
      console.error('❌ Error adding is_reverse_strategy column:', error.message);
      throw error;
    } finally {
      await pool.end();
    }
  },

  down: async (queryInterface, Sequelize) => {
    const pool = await getPool();
    try {
      // Remove column
      await pool.execute(`ALTER TABLE bots DROP COLUMN is_reverse_strategy`);
      console.log('✅ Removed is_reverse_strategy column from bots table');
    } catch (error) {
      console.error('❌ Error removing is_reverse_strategy column:', error.message);
      throw error;
    } finally {
      await pool.end();
    }
  }
};

