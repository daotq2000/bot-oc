import pool from '../src/config/database.js';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Script to log detailed database information
 */
async function checkDatabaseInfo() {
  console.log('='.repeat(80));
  console.log('DATABASE INFORMATION - DETAILED LOG');
  console.log('='.repeat(80));
  console.log();

  // 1. Database Type & Configuration
  console.log('DATABASE TYPE & CONFIGURATION');
  console.log('-'.repeat(80));
  console.log('Database Type:        MySQL/MariaDB');
  console.log('Driver:               mysql2/promise');
  console.log('Host:                ', process.env.DB_HOST || 'localhost');
  console.log('Port:                ', process.env.DB_PORT || '3306');
  console.log('Database Name:       ', process.env.DB_NAME || 'bot_oc');
  console.log('User:                ', process.env.DB_USER || 'root');
  console.log('Connection Limit:    ', process.env.DB_CONNECTION_LIMIT || '30');
  console.log('Connection Timeout:  ', '10000ms (10 seconds)');
  console.log('Keep Alive:          ', 'Enabled');
  console.log();

  try {
    // 2. Test Connection
    console.log('CONNECTION TEST');
    console.log('-'.repeat(80));
    const connection = await pool.getConnection();
    console.log('Connection Status:    CONNECTED');
    
    // 3. Database Version
    const [versionResult] = await connection.query('SELECT VERSION() as version');
    console.log('Database Version:    ', versionResult[0].version);
    
    // 4. Current Database Info
    const [dbInfo] = await connection.query('SELECT DATABASE() as current_db');
    console.log('Current Database:    ', dbInfo[0].current_db);
    
    // 5. Connection Info
    const [connInfo] = await connection.query('SELECT CONNECTION_ID() as conn_id, USER() as user, @@hostname as hostname');
    console.log('Connection ID:       ', connInfo[0].conn_id);
    console.log('Connected User:      ', connInfo[0].user);
    console.log('Server Hostname:     ', connInfo[0].hostname);
    console.log();

    // 6. Database Size
    console.log('DATABASE SIZE & STATISTICS');
    console.log('-'.repeat(80));
    const [sizeInfo] = await connection.query(`
      SELECT 
        table_schema as 'Database',
        ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) as 'Size_MB',
        COUNT(*) as 'Tables'
      FROM information_schema.tables 
      WHERE table_schema = ?
      GROUP BY table_schema
    `, [dbInfo[0].current_db]);
    
    if (sizeInfo.length > 0) {
      console.log('Database Size:       ', sizeInfo[0].Size_MB, 'MB');
      console.log('Total Tables:        ', sizeInfo[0].Tables);
    }
    console.log();

    // 7. Tables Information
    console.log('TABLES INFORMATION');
    console.log('-'.repeat(80));
    const [tables] = await connection.query(`
      SELECT 
        table_name as 'Table',
        table_rows as 'Rows',
        ROUND((data_length + index_length) / 1024 / 1024, 2) as 'Size_MB',
        engine as 'Engine',
        table_collation as 'Collation'
      FROM information_schema.tables
      WHERE table_schema = ?
      ORDER BY (data_length + index_length) DESC
    `, [dbInfo[0].current_db]);
    
    console.table(tables);
    console.log();

    // 8. Connection Pool Status
    console.log('CONNECTION POOL STATUS');
    console.log('-'.repeat(80));
    const [processlist] = await connection.query(`
      SELECT 
        COUNT(*) as total_connections,
        SUM(CASE WHEN command = 'Sleep' THEN 1 ELSE 0 END) as idle_connections,
        SUM(CASE WHEN command != 'Sleep' THEN 1 ELSE 0 END) as active_connections
      FROM information_schema.processlist
      WHERE db = ?
    `, [dbInfo[0].current_db]);
    
    console.log('Pool Limit:          ', process.env.DB_CONNECTION_LIMIT || '30');
    console.log('Total Connections:   ', processlist[0].total_connections);
    console.log('Active Connections:  ', processlist[0].active_connections);
    console.log('Idle Connections:    ', processlist[0].idle_connections);
    console.log();

    // 9. Key Tables Row Counts
    console.log('KEY TABLES ROW COUNTS');
    console.log('-'.repeat(80));
    
    const keyTables = ['bots', 'positions', 'symbols', 'app_configs', 'strategies'];
    for (const table of keyTables) {
      try {
        const [count] = await connection.query(`SELECT COUNT(*) as count FROM ${table}`);
        console.log(`${table.padEnd(20)}: ${count[0].count} rows`);
      } catch (err) {
        console.log(`${table.padEnd(20)}: Table not found or error`);
      }
    }
    console.log();

    // 10. Active Bots
    console.log('ACTIVE BOTS');
    console.log('-'.repeat(80));
    try {
      const [activeBots] = await connection.query(`
        SELECT *
        FROM bots
        WHERE is_active = 1
        ORDER BY id
      `);
      console.table(activeBots);
    } catch (err) {
      console.log('Error fetching active bots:', err.message);
    }
    console.log();

    // 11. Open Positions Summary
    console.log('OPEN POSITIONS SUMMARY');
    console.log('-'.repeat(80));
    try {
      const [openPositions] = await connection.query(`
        SELECT 
          bot_id,
          COUNT(*) as open_positions,
          AVG(entry_price) as avg_entry_price
        FROM positions
        WHERE status = 'open'
        GROUP BY bot_id
        ORDER BY bot_id
      `);
      
      if (openPositions.length > 0) {
        console.table(openPositions);
      } else {
        console.log('No open positions found.');
      }
    } catch (err) {
      console.log('Error fetching open positions:', err.message);
    }
    console.log();

    // 12. Recent Positions (Last 10)
    console.log('RECENT POSITIONS (Last 10)');
    console.log('-'.repeat(80));
    try {
      const [recentPositions] = await connection.query(`
        SELECT 
          id,
          bot_id,
          symbol,
          side,
          status,
          entry_price,
          created_at
        FROM positions
        ORDER BY created_at DESC
        LIMIT 10
      `);
      console.table(recentPositions);
    } catch (err) {
      console.log('Error fetching recent positions:', err.message);
    }
    console.log();

    // 13. Database Character Set
    console.log('CHARACTER SET & COLLATION');
    console.log('-'.repeat(80));
    const [charset] = await connection.query(`
      SELECT 
        @@character_set_database as charset,
        @@collation_database as collation
    `);
    console.log('Character Set:       ', charset[0].charset);
    console.log('Collation:           ', charset[0].collation);
    console.log();

    // 14. Database Variables (Important ones)
    console.log('IMPORTANT DATABASE VARIABLES');
    console.log('-'.repeat(80));
    const [variables] = await connection.query(`
      SHOW VARIABLES WHERE Variable_name IN (
        'max_connections',
        'wait_timeout',
        'interactive_timeout',
        'max_allowed_packet',
        'innodb_buffer_pool_size'
      )
    `);
    console.table(variables);
    console.log();

    connection.release();

    console.log('='.repeat(80));
    console.log('DATABASE CHECK COMPLETED SUCCESSFULLY');
    console.log('='.repeat(80));

  } catch (error) {
    console.error('ERROR:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    await pool.end();
  }
}

// Run the check
checkDatabaseInfo().catch(console.error);
