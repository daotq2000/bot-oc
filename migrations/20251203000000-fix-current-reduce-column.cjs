/**
 * Migration: Fix current_reduce column size
 * 
 * Problem: current_reduce is DECIMAL(5,2) which can only store values up to 999.99
 * But the formula reduce + (minutesElapsed * up_reduce) can exceed this limit
 * 
 * Solution: Increase column size to DECIMAL(10,2) to support larger values
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
      console.log('Altering current_reduce column to DECIMAL(10,2)...');
      
      await pool.execute(`
        ALTER TABLE positions 
        MODIFY COLUMN current_reduce DECIMAL(10,2) NULL
      `);
      
      console.log('✅ Successfully altered current_reduce column');
    } catch (error) {
      // Check if column already has the correct type
      const [columns] = await pool.execute(`
        SELECT COLUMN_TYPE 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'positions' 
        AND COLUMN_NAME = 'current_reduce'
      `);
      
      if (columns.length > 0 && columns[0].COLUMN_TYPE.includes('decimal(10,2)')) {
        console.log('✅ Column already has correct type DECIMAL(10,2), skipping...');
      } else {
        console.error('❌ Error altering current_reduce column:', error);
        throw error;
      }
    } finally {
      await pool.end();
    }
  },

  down: async (queryInterface, Sequelize) => {
    const pool = await getPool();
    try {
      console.log('Reverting current_reduce column to DECIMAL(5,2)...');
      
      // First, clamp any values that exceed 999.99
      await pool.execute(`
        UPDATE positions 
        SET current_reduce = LEAST(current_reduce, 999.99)
        WHERE current_reduce > 999.99
      `);
      
      await pool.execute(`
        ALTER TABLE positions 
        MODIFY COLUMN current_reduce DECIMAL(5,2) NULL
      `);
      
      console.log('✅ Successfully reverted current_reduce column');
    } catch (error) {
      console.error('❌ Error reverting current_reduce column:', error);
      throw error;
    } finally {
      await pool.end();
    }
  }
};

