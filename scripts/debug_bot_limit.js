/**
 * Debug script để check bot limit configuration
 * 
 * Usage: node scripts/debug_bot_limit.js [bot_id]
 */

import pool from '../src/config/database.js';
import { Bot } from '../src/models/Bot.js';
import { Strategy } from '../src/models/Strategy.js';

async function debugBotLimit(botId) {
  try {
    console.log('='.repeat(60));
    console.log(`Debug Bot ${botId} Limit Configuration`);
    console.log('='.repeat(60));
    
    // Get bot info
    const bot = await Bot.findById(botId);
    if (!bot) {
      console.error(`❌ Bot ${botId} not found!`);
      process.exit(1);
    }
    
    console.log('\n📊 Bot Configuration:');
    console.log(`  Bot ID: ${bot.id}`);
    console.log(`  Bot Name: ${bot.bot_name}`);
    console.log(`  Exchange: ${bot.exchange}`);
    console.log(`  is_reverse_strategy: ${bot.is_reverse_strategy}`);
    console.log(`  max_amount_per_coin: ${bot.max_amount_per_coin}`);
    console.log(`  max_concurrent_trades: ${bot.max_concurrent_trades}`);
    console.log(`  is_active: ${bot.is_active}`);
    
    // Get strategies
    const strategies = await Strategy.findAll(botId, true);
    console.log(`\n📈 Active Strategies: ${strategies.length}`);
    
    // Group by symbol
    const bySymbol = {};
    for (const s of strategies) {
      if (!bySymbol[s.symbol]) {
        bySymbol[s.symbol] = [];
      }
      bySymbol[s.symbol].push(s);
    }
    
    console.log(`\n📋 Strategies by Symbol:`);
    for (const [symbol, strats] of Object.entries(bySymbol)) {
      console.log(`\n  ${symbol}:`);
      for (const s of strats) {
        console.log(`    - Strategy ${s.id}: ${s.interval}, OC=${s.oc}%, Amount=${s.amount}, is_reverse_strategy=${s.is_reverse_strategy}`);
      }
      
      // Check current positions
      const [posRows] = await pool.execute(
        `SELECT 
          COALESCE(SUM(CASE WHEN p.status = 'open' THEN p.amount ELSE 0 END), 0) AS positions_amount,
          COALESCE(SUM(CASE WHEN eo.status = 'open' THEN eo.amount ELSE 0 END), 0) AS pending_orders_amount
         FROM strategies s
         LEFT JOIN positions p ON p.strategy_id = s.id AND p.status = 'open' AND p.symbol = ?
         LEFT JOIN entry_orders eo ON eo.strategy_id = s.id AND eo.status = 'open' AND eo.symbol = ?
         WHERE s.bot_id = ? AND s.symbol = ?
         GROUP BY s.bot_id, s.symbol`,
        [symbol, symbol, botId, symbol]
      );
      
      const positionsAmount = Number(posRows?.[0]?.positions_amount || 0);
      const pendingOrdersAmount = Number(posRows?.[0]?.pending_orders_amount || 0);
      const currentTotal = positionsAmount + pendingOrdersAmount;
      
      console.log(`    Current Total: ${currentTotal.toFixed(2)} USDT`);
      console.log(`    Max Allowed: ${bot.max_amount_per_coin || 'No limit'} USDT`);
      
      if (bot.max_amount_per_coin) {
        const remaining = bot.max_amount_per_coin - currentTotal;
        console.log(`    Remaining: ${remaining.toFixed(2)} USDT`);
        
        if (remaining <= 0) {
          console.log(`    ⚠️  LIMIT REACHED! Cannot open new orders.`);
        } else {
          console.log(`    ✅ Can open orders up to ${remaining.toFixed(2)} USDT`);
        }
      }
    }
    
    console.log('\n' + '='.repeat(60));
    
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    pool.end();
  }
}

// Get bot ID from command line
const botId = process.argv[2] ? parseInt(process.argv[2]) : null;

if (!botId) {
  console.error('Usage: node scripts/debug_bot_limit.js <bot_id>');
  process.exit(1);
}

debugBotLimit(botId);

