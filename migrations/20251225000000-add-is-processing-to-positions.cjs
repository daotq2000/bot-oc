/**
 * Migration: Add is_processing column to positions table
 * 
 * This column is used as a soft lock to prevent race conditions when
 * multiple processes try to update the same position concurrently.
 * 
 * Created: 2025-12-25
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
         AND TABLE_NAME = 'positions' 
         AND COLUMN_NAME = 'is_processing'`
      );

      if (results[0].count === '0') {
        console.log('Adding is_processing column to positions table...');
        
        await pool.execute(`
          ALTER TABLE positions 
          ADD COLUMN is_processing TINYINT(1) DEFAULT 0 NULL
          COMMENT 'Soft lock flag: 1 = position is being processed, 0 = available for processing'
        `);

        // Create index for better performance on lock queries
        try {
          await pool.execute(`
            CREATE INDEX idx_is_processing_status 
            ON positions (is_processing, status)
          `);
        } catch (indexError) {
          // Index might already exist, ignore
          if (!indexError.message.includes('Duplicate key name')) {
            throw indexError;
          }
        }

        console.log('✅ Added is_processing column to positions table');
      } else {
        console.log('⚠️  Column is_processing already exists, skipping...');
      }
    } catch (error) {
      console.error('❌ Error adding is_processing column:', error.message);
      throw error;
    } finally {
      await pool.end();
    }
  },

  down: async (queryInterface, Sequelize) => {
    const pool = await getPool();
    try {
      // Remove index first
      try {
        await pool.execute(`DROP INDEX idx_is_processing_status ON positions`);
      } catch (e) {
        console.log('Index idx_is_processing_status does not exist, skipping...');
      }
      
      // Remove column
      await pool.execute(`ALTER TABLE positions DROP COLUMN is_processing`);
      console.log('✅ Removed is_processing column from positions table');
    } catch (error) {
      console.error('❌ Error removing is_processing column:', error.message);
      throw error;
    } finally {
      await pool.end();
    }
  }
};
