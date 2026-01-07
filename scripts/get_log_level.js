#!/usr/bin/env node
/**
 * Get Current Log Level
 * 
 * This script shows the current LOG_LEVEL configuration
 * 
 * Usage:
 *   node scripts/get_log_level.js
 */

import pool from '../src/config/database.js';

async function main() {
  try {
    const [configs] = await pool.execute(
      'SELECT config_key, config_value, description, updated_at FROM app_configs WHERE config_key IN (?, ?, ?)',
      ['LOG_LEVEL', 'LOG_FILE_MAX_SIZE_MB', 'LOG_FILE_MAX_FILES']
    );

    console.log('\n═══════════════════════════════════════════════════════════════════════════════');
    console.log('                        CURRENT LOG CONFIGURATION');
    console.log('═══════════════════════════════════════════════════════════════════════════════\n');

    if (configs.length > 0) {
      console.table(configs.map(c => ({
        Setting: c.config_key,
        Value: c.config_value,
        Description: c.description,
        'Last Updated': c.updated_at
      })));

      const logLevel = configs.find(c => c.config_key === 'LOG_LEVEL');
      
      console.log('\nLog Level Details:');
      console.log('  Current Level:', logLevel?.config_value || 'unknown');
      console.log('  Console Output:', logLevel?.config_value || 'info');
      console.log('  combined.log:', logLevel?.config_value === 'debug' || logLevel?.config_value === 'verbose' ? 'debug' : 'info');
      console.log('  error.log: error (always)');
      console.log('');
      console.log('Valid Levels:');
      console.log('  - error: Only errors');
      console.log('  - warn: Warnings and errors');
      console.log('  - info: General information (default)');
      console.log('  - debug: Detailed debugging');
      console.log('  - verbose: Very detailed');
      console.log('');
      console.log('To change log level:');
      console.log('  node scripts/set_log_level.js <level>');
      console.log('');
    } else {
      console.log('⚠️ No log configs found in database');
      console.log('Run: node src/app.js to initialize');
    }

    console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

