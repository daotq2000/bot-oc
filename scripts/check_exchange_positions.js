#!/usr/bin/env node

/**
 * Script to check positions on exchange vs database
 * 
 * Usage:
 *   node scripts/check_exchange_positions.js --bot_id 2 --symbol BEATUSDT
 */

import { Bot } from '../src/models/Bot.js';
import { Position } from '../src/models/Position.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import logger from '../src/utils/logger.js';

const args = process.argv.slice(2);
const botId = args.find(arg => arg.startsWith('--bot_id'))?.split('=')[1] || args[args.indexOf('--bot_id') + 1];
const symbol = args.find(arg => arg.startsWith('--symbol'))?.split('=')[1] || args[args.indexOf('--symbol') + 1];

if (!botId || !symbol) {
  console.error('Usage: node scripts/check_exchange_positions.js --bot_id <id> --symbol <SYMBOL>');
  process.exit(1);
}

async function checkPositions() {
  try {
    console.log('\n' + '='.repeat(80));
    console.log('EXCHANGE vs DATABASE POSITION COMPARISON');
    console.log('='.repeat(80));
    console.log(`Bot ID: ${botId}`);
    console.log(`Symbol: ${symbol.toUpperCase()}`);
    console.log('='.repeat(80) + '\n');
    
    // Load bot
    const bot = await Bot.findById(Number(botId));
    if (!bot) {
      console.error(`❌ Bot ${botId} not found`);
      process.exit(1);
    }
    console.log(`✅ Bot: ${bot.bot_name} (${bot.exchange})\n`);
    
    // Initialize ExchangeService
    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();
    
    // Get positions from exchange
    console.log('📋 Fetching positions from exchange...');
    let exchangePositions = [];
    try {
      if (exchangeService.binanceDirectClient) {
        // Use Binance Direct Client
        exchangePositions = await exchangeService.binanceDirectClient.getPositions();
      } else if (exchangeService.exchange && exchangeService.exchange.fetchPositions) {
        // Use CCXT
        exchangePositions = await exchangeService.exchange.fetchPositions([symbol.toUpperCase()]);
      } else {
        console.log('⚠️  Cannot fetch positions from exchange (method not available)');
      }
    } catch (e) {
      console.error(`❌ Error fetching positions: ${e?.message || e}`);
    }
    const symbolPositions = exchangePositions.filter(p => {
      const sym = p.symbol || p.info?.symbol || p.market || '';
      return sym.toUpperCase().replace('/', '').replace('_', '') === symbol.toUpperCase().replace('/', '').replace('_', '');
    });
    
    console.log(`✅ Found ${symbolPositions.length} position(s) on exchange:\n`);
    symbolPositions.forEach((exPos, idx) => {
      const rawAmt = parseFloat(exPos.positionAmt ?? exPos.contracts ?? exPos.size ?? 0);
      const side = rawAmt > 0 ? 'long' : rawAmt < 0 ? 'short' : null;
      const contracts = Math.abs(rawAmt);
      const entryPrice = parseFloat(exPos.entryPrice || exPos.info?.entryPrice || exPos.markPrice || 0);
      
      console.log(`Position ${idx + 1}:`);
      console.log(`  - Symbol: ${exPos.symbol || exPos.info?.symbol || exPos.market || 'N/A'}`);
      console.log(`  - Raw Amount: ${rawAmt}`);
      console.log(`  - Side: ${side} (calculated from rawAmt)`);
      console.log(`  - Contracts: ${contracts}`);
      console.log(`  - Entry Price: ${entryPrice}`);
      console.log(`  - Mark Price: ${parseFloat(exPos.markPrice || exPos.info?.markPrice || 0)}`);
      console.log(`  - Unrealized PnL: ${parseFloat(exPos.unrealizedPnl || exPos.info?.unrealizedPnl || 0)}`);
      console.log('');
    });
    
    // Get positions from database
    console.log('📋 Fetching positions from database...');
    const dbPositions = await Position.findAll({
      symbol: symbol.toUpperCase()
    });
    const botDbPositions = dbPositions.filter(p => p.bot_id === Number(botId));
    
    console.log(`✅ Found ${botDbPositions.length} position(s) in database:\n`);
    botDbPositions.forEach((dbPos, idx) => {
      console.log(`Position ${idx + 1}:`);
      console.log(`  - ID: ${dbPos.id}`);
      console.log(`  - Symbol: ${dbPos.symbol}`);
      console.log(`  - Side: ${dbPos.side} (type: ${typeof dbPos.side})`);
      console.log(`  - Status: ${dbPos.status}`);
      console.log(`  - Entry Price: ${dbPos.entry_price || 'N/A'}`);
      console.log(`  - TP Price: ${dbPos.take_profit_price || 'N/A'}`);
      console.log(`  - TP Order ID: ${dbPos.tp_order_id || 'N/A'}`);
      console.log(`  - Amount: ${dbPos.amount || 'N/A'}`);
      console.log('');
    });
    
    // Compare
    console.log('='.repeat(80));
    console.log('COMPARISON');
    console.log('='.repeat(80));
    
    if (symbolPositions.length === 0 && botDbPositions.length === 0) {
      console.log('✅ No positions found on exchange or database');
    } else if (symbolPositions.length === 0 && botDbPositions.length > 0) {
      console.log('⚠️  Positions exist in database but not on exchange (may be closed)');
    } else if (symbolPositions.length > 0 && botDbPositions.length === 0) {
      console.log('⚠️  Positions exist on exchange but not in database (need sync)');
    } else {
      // Try to match
      symbolPositions.forEach((exPos, idx) => {
        const rawAmt = parseFloat(exPos.positionAmt ?? exPos.contracts ?? exPos.size ?? 0);
        const exSide = rawAmt > 0 ? 'long' : rawAmt < 0 ? 'short' : null;
        
        const matched = botDbPositions.find(dbPos => {
          const dbSide = String(dbPos.side).toLowerCase();
          return dbSide === exSide && dbPos.status === 'open';
        });
        
        if (matched) {
          console.log(`\n✅ Exchange Position ${idx + 1} (${exSide}) matches DB Position ID ${matched.id}`);
          if (String(matched.side).toLowerCase() !== exSide) {
            console.log(`   ⚠️  WARNING: Side mismatch! Exchange: ${exSide}, DB: ${matched.side}`);
          }
        } else {
          console.log(`\n❌ Exchange Position ${idx + 1} (${exSide}) has NO match in database`);
          console.log(`   This position needs to be synced!`);
        }
      });
    }
    
    console.log('\n' + '='.repeat(80) + '\n');
    
  } catch (error) {
    console.error('\n❌ Error:');
    console.error(error);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

checkPositions().then(() => {
  process.exit(0);
}).catch(error => {
  console.error('❌ Failed:', error);
  process.exit(1);
});

