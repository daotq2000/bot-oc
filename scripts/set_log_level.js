#!/usr/bin/env node
/**
 * Set Log Level
 * 
 * This script updates the LOG_LEVEL in app_configs and restarts the bot
 * 
 * Usage:
 *   node scripts/set_log_level.js <level>
 *   
 * Valid levels: error, warn, info, debug, verbose
 * 
 * Examples:
 *   node scripts/set_log_level.js info
 *   node scripts/set_log_level.js debug
 *   node scripts/set_log_level.js warn
 */

import pool from '../src/config/database.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const validLevels = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];

async function main() {
  const args = process.argv.slice(2);
  const newLevel = args[0];

  if (!newLevel) {
    console.log('Usage: node scripts/set_log_level.js <level>');
    console.log('');
    console.log('Valid levels:', validLevels.join(', '));
    console.log('');
    console.log('Examples:');
    console.log('  node scripts/set_log_level.js info    # Standard logging');
    console.log('  node scripts/set_log_level.js debug   # Detailed debugging');
    console.log('  node scripts/set_log_level.js warn    # Production (minimal logs)');
    process.exit(1);
  }

  const level = newLevel.toLowerCase();
  
  if (!validLevels.includes(level)) {
    console.error('❌ Invalid log level:', newLevel);
    console.error('Valid levels:', validLevels.join(', '));
    process.exit(1);
  }

  try {
    // Get current level
    const [current] = await pool.execute(
      'SELECT config_value FROM app_configs WHERE config_key = ?',
      ['LOG_LEVEL']
    );

    const currentLevel = current.length > 0 ? current[0].config_value : 'unknown';

    console.log('\n═══════════════════════════════════════════════════════════════════════════════');
    console.log('                          SET LOG LEVEL');
    console.log('═══════════════════════════════════════════════════════════════════════════════\n');

    console.log('Current Level:', currentLevel);
    console.log('New Level:', level);
    console.log('');

    // Update database
    await pool.execute(
      'UPDATE app_configs SET config_value = ? WHERE config_key = ?',
      [level, 'LOG_LEVEL']
    );

    console.log('✅ Updated LOG_LEVEL in database');

    // Restart bot
    console.log('\nRestarting bot to apply changes...');
    const { stdout, stderr } = await execAsync('pm2 restart bot-oc');
    
    if (stderr && !stderr.includes('Use --update-env')) {
      console.error('⚠️ PM2 stderr:', stderr);
    }

    console.log('✅ Bot restarted');
    console.log('');
    console.log('Log Level Changes:');
    console.log('  - Console: ' + level);
    console.log('  - combined.log: ' + (level === 'debug' || level === 'verbose' ? 'debug' : 'info'));
    console.log('  - error.log: error (always)');
    console.log('');
    console.log('To view logs:');
    console.log('  pm2 logs bot-oc');
    console.log('  tail -f logs/combined.log');
    console.log('');
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

