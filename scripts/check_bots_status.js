import pool from '../src/config/database.js';
import logger from '../src/utils/logger.js';

/**
 * Check bots status and identify issues
 */
async function checkBotsStatus() {
  try {
    console.log('='.repeat(60));
    console.log('BOT STATUS CHECK');
    console.log('='.repeat(60));

    // Get all bots
    const [allBots] = await pool.execute('SELECT id, bot_name, exchange, is_active FROM bots ORDER BY id');
    console.log(`\n📊 Total bots in database: ${allBots.length}`);

    // Get active bots
    const [activeBots] = await pool.execute('SELECT id, bot_name, exchange, is_active FROM bots WHERE is_active = TRUE ORDER BY id');
    console.log(`✅ Active bots: ${activeBots.length}`);

    // Get inactive bots
    const [inactiveBots] = await pool.execute('SELECT id, bot_name, exchange, is_active FROM bots WHERE is_active = FALSE ORDER BY id');
    console.log(`❌ Inactive bots: ${inactiveBots.length}`);

    console.log('\n' + '-'.repeat(60));
    console.log('ALL BOTS:');
    console.log('-'.repeat(60));
    allBots.forEach(bot => {
      const status = bot.is_active ? '✅ ACTIVE' : '❌ INACTIVE';
      console.log(`Bot ${bot.id}: ${bot.bot_name} (${bot.exchange}) - ${status}`);
    });

    // Check for Gate bots
    console.log('\n' + '-'.repeat(60));
    console.log('GATE BOTS:');
    console.log('-'.repeat(60));
    const [gateBots] = await pool.execute('SELECT id, bot_name, exchange, is_active FROM bots WHERE exchange = "gate" ORDER BY id');
    if (gateBots.length === 0) {
      console.log('❌ No Gate bots found!');
    } else {
      gateBots.forEach(bot => {
        const status = bot.is_active ? '✅ ACTIVE' : '❌ INACTIVE';
        console.log(`Bot ${bot.id}: ${bot.bot_name} - ${status}`);
      });
    }

    // Check for Binance bots
    console.log('\n' + '-'.repeat(60));
    console.log('BINANCE BOTS:');
    console.log('-'.repeat(60));
    const [binanceBots] = await pool.execute('SELECT id, bot_name, exchange, is_active FROM bots WHERE exchange = "binance" ORDER BY id');
    if (binanceBots.length === 0) {
      console.log('❌ No Binance bots found!');
    } else {
      binanceBots.forEach(bot => {
        const status = bot.is_active ? '✅ ACTIVE' : '❌ INACTIVE';
        console.log(`Bot ${bot.id}: ${bot.bot_name} - ${status}`);
      });
    }

    // Check for MEXC bots
    console.log('\n' + '-'.repeat(60));
    console.log('MEXC BOTS:');
    console.log('-'.repeat(60));
    const [mexcBots] = await pool.execute('SELECT id, bot_name, exchange, is_active FROM bots WHERE exchange = "mexc" ORDER BY id');
    if (mexcBots.length === 0) {
      console.log('❌ No MEXC bots found!');
    } else {
      mexcBots.forEach(bot => {
        const status = bot.is_active ? '✅ ACTIVE' : '❌ INACTIVE';
        console.log(`Bot ${bot.id}: ${bot.bot_name} - ${status}`);
      });
    }

    // Check for issues
    console.log('\n' + '-'.repeat(60));
    console.log('ISSUES DETECTED:');
    console.log('-'.repeat(60));

    let issuesFound = false;

    if (gateBots.length === 0) {
      console.log('⚠️  No Gate bots found - Gate feature is not configured');
      issuesFound = true;
    } else if (gateBots.every(b => !b.is_active)) {
      console.log('⚠️  All Gate bots are inactive - Gate feature is disabled');
      issuesFound = true;
    }

    if (inactiveBots.length > 0) {
      console.log(`⚠️  ${inactiveBots.length} inactive bot(s) found:`);
      inactiveBots.forEach(bot => {
        console.log(`   - Bot ${bot.id}: ${bot.bot_name} (${bot.exchange})`);
      });
      issuesFound = true;
    }

    if (!issuesFound) {
      console.log('✅ No issues detected!');
    }

    console.log('\n' + '='.repeat(60));

    process.exit(0);
  } catch (error) {
    console.error('Error checking bots status:', error);
    process.exit(1);
  }
}

checkBotsStatus();

