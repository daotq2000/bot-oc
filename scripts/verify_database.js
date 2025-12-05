#!/usr/bin/env node

/**
 * Database Verification Script
 * Verifies database integrity and shows statistics
 */

import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'bot_oc'
};

async function verifyDatabase() {
  let connection;

  try {
    console.log('\n🔍 Database Verification Tool');
    console.log('='.repeat(60));
    console.log(`📊 Database: ${dbConfig.database}`);
    console.log(`[object Object]Host: ${dbConfig.host}:${dbConfig.port}`);
    console.log('='.repeat(60));

    // Connect
    console.log('\n📡 Connecting to database...');
    connection = await mysql.createConnection(dbConfig);
    console.log('✅ Connected successfully\n');

    // Get table list
    console.log('📋 Table Statistics:');
    console.log('-'.repeat(60));

    const [tables] = await connection.query(
      `SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME`,
      [dbConfig.database]
    );

    let totalRows = 0;
    let totalSize = 0;

    for (const table of tables) {
      const tableName = table.TABLE_NAME;
      const rows = table.TABLE_ROWS || 0;
      const dataSize = (table.DATA_LENGTH / 1024 / 1024).toFixed(2);
      const indexSize = (table.INDEX_LENGTH / 1024 / 1024).toFixed(2);

      console.log(`\n  📌 ${tableName}`);
      console.log(`     Rows: ${rows.toLocaleString()}`);
      console.log(`     Data Size: ${dataSize} MB`);
      console.log(`     Index Size: ${indexSize} MB`);

      totalRows += rows;
      totalSize += table.DATA_LENGTH + table.INDEX_LENGTH;
    }

    console.log('\n' + '-'.repeat(60));
    console.log(`\n📊 Total Statistics:`);
    console.log(`   Tables: ${tables.length}`);
    console.log(`   Total Rows: ${totalRows.toLocaleString()}`);
    console.log(`   Total Size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);

    // Check foreign keys
    console.log('\n\n🔗 Foreign Key Relationships:');
    console.log('-'.repeat(60));

    const [fks] = await connection.query(
      `SELECT 
        CONSTRAINT_NAME,
        TABLE_NAME,
        COLUMN_NAME,
        REFERENCED_TABLE_NAME,
        REFERENCED_COLUMN_NAME
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY TABLE_NAME`,
      [dbConfig.database]
    );

    if (fks.length === 0) {
      console.log('  No foreign keys found');
    } else {
      for (const fk of fks) {
        console.log(`\n  ${fk.TABLE_NAME}.${fk.COLUMN_NAME}`);
        console.log(`    → ${fk.REFERENCED_TABLE_NAME}.${fk.REFERENCED_COLUMN_NAME}`);
      }
    }

    // Check indexes
    console.log('\n\n📑 Indexes:');
    console.log('-'.repeat(60));

    const [indexes] = await connection.query(
      `SELECT 
        TABLE_NAME,
        INDEX_NAME,
        COLUMN_NAME,
        SEQ_IN_INDEX
       FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME, INDEX_NAME`,
      [dbConfig.database]
    );

    let currentTable = '';
    let currentIndex = '';

    for (const idx of indexes) {
      if (idx.TABLE_NAME !== currentTable) {
        currentTable = idx.TABLE_NAME;
        console.log(`\n  📌 ${currentTable}`);
      }

      if (idx.INDEX_NAME !== currentIndex) {
        currentIndex = idx.INDEX_NAME;
        console.log(`     └─ ${currentIndex}`);
      }

      console.log(`        • ${idx.COLUMN_NAME}`);
    }

    // Check for data integrity issues
    console.log('\n\n🔐 Data Integrity Check:');
    console.log('-'.repeat(60));

    // Check for orphaned records
    console.log('\n  Checking for orphaned records...');

    // Check positions without strategies
    const [orphanedPositions] = await connection.query(
      `SELECT COUNT(*) as count FROM positions 
       WHERE strategy_id NOT IN (SELECT id FROM strategies)`
    );

    if (orphanedPositions[0].count > 0) {
      console.log(`  ⚠️  Found ${orphanedPositions[0].count} positions without strategies`);
    } else {
      console.log(`  ✅ No orphaned positions`);
    }

    // Check strategies without bots
    const [orphanedStrategies] = await connection.query(
      `SELECT COUNT(*) as count FROM strategies 
       WHERE bot_id NOT IN (SELECT id FROM bots)`
    );

    if (orphanedStrategies[0].count > 0) {
      console.log(`  ⚠️  Found ${orphanedStrategies[0].count} strategies without bots`);
    } else {
      console.log(`  ✅ No orphaned strategies`);
    }

    // Check transactions without bots
    const [orphanedTransactions] = await connection.query(
      `SELECT COUNT(*) as count FROM transactions 
       WHERE bot_id NOT IN (SELECT id FROM bots)`
    );

    if (orphanedTransactions[0].count > 0) {
      console.log(`  ⚠️  Found ${orphanedTransactions[0].count} transactions without bots`);
    } else {
      console.log(`  ✅ No orphaned transactions`);
    }

    // Summary
    console.log('\n\n' + '='.repeat(60));
    console.log('✅ Database verification complete!');
    console.log('='.repeat(60) + '\n');

  } catch (error) {
    console.error('\n❌ Verification failed:', error.message);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

verifyDatabase().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

