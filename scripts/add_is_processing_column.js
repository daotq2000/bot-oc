#!/usr/bin/env node
/**
 * Script to add is_processing column to positions table
 * 
 * Run this script directly:
 *   node scripts/add_is_processing_column.js
 */

import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

async function main() {
  let connection;
  
  try {
    // Create connection
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306'),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'bot_oc'
    });

    console.log('✅ Connected to database');

    // Check if column already exists
    const [results] = await connection.execute(
      `SELECT COUNT(*) as count 
       FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() 
       AND TABLE_NAME = 'positions' 
       AND COLUMN_NAME = 'is_processing'`
    );

    if (results[0].count === '0') {
      console.log('Adding is_processing column to positions table...');
      
      // Add column
      await connection.execute(`
        ALTER TABLE positions 
        ADD COLUMN is_processing TINYINT(1) DEFAULT 0 NULL
        COMMENT 'Soft lock flag: 1 = position is being processed, 0 = available for processing'
      `);

      console.log('✅ Added is_processing column');

      // Create index
      try {
        await connection.execute(`
          CREATE INDEX idx_is_processing_status 
          ON positions (is_processing, status)
        `);
        console.log('✅ Created index idx_is_processing_status');
      } catch (indexError) {
        if (indexError.message.includes('Duplicate key name')) {
          console.log('⚠️  Index idx_is_processing_status already exists, skipping...');
        } else {
          throw indexError;
        }
      }

      console.log('\n✅ Migration completed successfully!');
    } else {
      console.log('⚠️  Column is_processing already exists, skipping...');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
      console.log('✅ Database connection closed');
    }
  }
}

main();

