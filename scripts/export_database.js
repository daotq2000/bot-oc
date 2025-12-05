#!/usr/bin/env node

/**
 * Database Export Script
 * Exports the entire bot-oc database to a SQL file for cloud migration
 * 
 * Usage: node scripts/export_database.js [output_file]
 * Example: node scripts/export_database.js data.sql
 */

import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database configuration
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'bot_oc'
};

// Output file path
const outputFile = process.argv[2] || 'data.sql';
const outputPath = path.resolve(outputFile);

console.log('🔄 Database Export Tool');
console.log('='.repeat(50));
console.log(`📊 Database: ${dbConfig.database}`);
console.log(`[object Object]Host: ${dbConfig.host}:${dbConfig.port}`);
console.log(`[object Object]: ${outputPath}`);
console.log('='.repeat(50));

async function exportDatabase() {
  let connection;
  let outputStream;

  try {
    // Create connection
    console.log('\n📡 Connecting to database...');
    connection = await mysql.createConnection(dbConfig);
    console.log('✅ Connected successfully');

    // Create output stream
    outputStream = fs.createWriteStream(outputPath);

    // Write header
    const timestamp = new Date().toISOString();
    outputStream.write(`-- Database Export: ${dbConfig.database}\n`);
    outputStream.write(`-- Exported at: ${timestamp}\n`);
    outputStream.write(`-- Host: ${dbConfig.host}\n`);
    outputStream.write(`-- Database: ${dbConfig.database}\n`);
    outputStream.write('-- ============================================\n\n');

    // Set SQL mode and charset
    outputStream.write('SET NAMES utf8mb4;\n');
    outputStream.write('SET CHARACTER SET utf8mb4;\n');
    outputStream.write('SET FOREIGN_KEY_CHECKS=0;\n\n');

    // Get all tables
    console.log('\n📋 Fetching table list...');
    const [tables] = await connection.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?`,
      [dbConfig.database]
    );

    if (tables.length === 0) {
      console.log('⚠️  No tables found in database');
      return;
    }

    console.log(`✅ Found ${tables.length} tables`);

    // Export each table
    for (const table of tables) {
      const tableName = table.TABLE_NAME;
      console.log(`\n📤 Exporting table: ${tableName}`);

      // Get CREATE TABLE statement
      const [createTableResult] = await connection.query(
        `SHOW CREATE TABLE ${tableName}`
      );
      const createTableStatement = createTableResult[0]['Create Table'];

      // Write CREATE TABLE statement
      outputStream.write(`\n-- Table: ${tableName}\n`);
      outputStream.write(`DROP TABLE IF EXISTS \`${tableName}\`;\n`);
      outputStream.write(`${createTableStatement};\n\n`);

      // Get table data
      const [rows] = await connection.query(`SELECT * FROM \`${tableName}\``);

      if (rows.length > 0) {
        console.log(`   └─ Exporting ${rows.length} rows`);

        // Get column names
        const columns = Object.keys(rows[0]);
        const columnNames = columns.map(col => `\`${col}\``).join(', ');

        // Write INSERT statements
        outputStream.write(`-- Data for table: ${tableName}\n`);
        for (const row of rows) {
          const values = columns.map(col => {
            const value = row[col];
            if (value === null) {
              return 'NULL';
            } else if (typeof value === 'string') {
              return `'${value.replace(/'/g, "''")}'`;
            } else if (typeof value === 'boolean') {
              return value ? '1' : '0';
            } else if (Buffer.isBuffer(value)) {
              return `0x${value.toString('hex')}`;
            } else {
              return value;
            }
          }).join(', ');

          outputStream.write(`INSERT INTO \`${tableName}\` (${columnNames}) VALUES (${values});\n`);
        }
        outputStream.write('\n');
      } else {
        console.log(`   └─ No data to export`);
      }
    }

    // Write footer
    outputStream.write('\n-- ============================================\n');
    outputStream.write('-- Export completed\n');
    outputStream.write('SET FOREIGN_KEY_CHECKS=1;\n');

    // Close stream
    await new Promise((resolve, reject) => {
      outputStream.end(resolve);
      outputStream.on('error', reject);
    });

    console.log('\n' + '='.repeat(50));
    console.log('✅ Export completed successfully!');
    console.log(`📁 File saved to: ${outputPath}`);
    console.log(`📊 File size: ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(2)} MB`);
    console.log('='.repeat(50));

  } catch (error) {
    console.error('\n❌ Export failed:', error.message);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

// Run export
exportDatabase().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

