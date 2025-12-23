#!/usr/bin/env node
/**
 * Sync Position từ Exchange về Database
 * 
 * Script này sẽ:
 * 1. Lấy bot từ database theo bot_id
 * 2. Khởi tạo ExchangeService cho bot
 * 3. Sync positions từ exchange về database
 * 
 * Usage:
 *   node scripts/sync_position_bot5.js --bot-id <bot_id>
 *   node scripts/sync_position_bot5.js <bot_id>
 * 
 * Examples:
 *   node scripts/sync_position_bot5.js --bot-id 5
 *   node scripts/sync_position_bot5.js 5
 */

import dotenv from 'dotenv';
dotenv.config();

import { Bot } from '../src/models/Bot.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import { PositionSync } from '../src/jobs/PositionSync.js';
import { configService } from '../src/services/ConfigService.js';
import logger from '../src/utils/logger.js';

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  let botId = null;
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--bot-id' || arg === '--bot_id' || arg === '-b') {
      if (i + 1 < args.length) {
        botId = parseInt(args[++i], 10);
      }
    } else if (!isNaN(parseInt(arg, 10)) && botId === null) {
      // Nếu argument là số và chưa có bot_id, dùng nó làm bot_id
      botId = parseInt(arg, 10);
    }
  }
  
  return { botId };
}

async function syncPosition(botId) {
  try {
    if (!botId) {
      console.error('❌ Vui lòng cung cấp bot_id!');
      console.log('');
      console.log('Usage:');
      console.log('  node scripts/sync_position_bot5.js --bot-id <bot_id>');
      console.log('  node scripts/sync_position_bot5.js <bot_id>');
      console.log('');
      console.log('Examples:');
      console.log('  node scripts/sync_position_bot5.js --bot-id 5');
      console.log('  node scripts/sync_position_bot5.js 5');
      process.exit(1);
    }

    console.log('\n' + '='.repeat(80));
    console.log(`SYNC POSITION CHO BOT ID = ${botId} TỪ EXCHANGE VỀ DATABASE`);
    console.log('='.repeat(80) + '\n');

    // Load configs
    await configService.loadAll();

    // 1. Lấy bot từ database
    console.log(`📋 [1] Đang lấy thông tin bot_id = ${botId}...`);
    const bot = await Bot.findById(botId);
    
    if (!bot) {
      console.error(`❌ Không tìm thấy bot_id = ${botId} trong database!`);
      process.exit(1);
    }

    console.log(`✅ Tìm thấy bot:`);
    console.log(`   ID: ${bot.id}`);
    console.log(`   Tên: ${bot.bot_name || 'N/A'}`);
    console.log(`   Exchange: ${bot.exchange}`);
    console.log(`   Is Active: ${bot.is_active ? 'Yes' : 'No'}`);
    console.log('');

    // Kiểm tra exchange
    if (bot.exchange?.toLowerCase() !== 'binance') {
      console.log(`⚠️  Cảnh báo: Bot này không phải Binance (exchange: ${bot.exchange})`);
      console.log(`   Script sẽ vẫn tiếp tục sync...`);
      console.log('');
    }

    // 2. Khởi tạo ExchangeService
    console.log('📋 [2] Đang khởi tạo ExchangeService...');
    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();
    console.log('✅ ExchangeService đã được khởi tạo');
    console.log('');

    // 3. Fetch positions từ exchange
    console.log(`📋 [3] Đang fetch positions từ ${bot.exchange.toUpperCase()} exchange...`);
    let exchangePositions = [];
    try {
      exchangePositions = await exchangeService.getOpenPositions();
      console.log(`✅ Đã fetch ${exchangePositions.length} positions từ exchange`);
      
      if (exchangePositions.length > 0) {
        console.log('');
        console.log('📊 Positions trên exchange:');
        exchangePositions.forEach((pos, idx) => {
          const symbol = pos.symbol || pos.info?.symbol || 'N/A';
          const contracts = pos.contracts ?? Math.abs(parseFloat(pos.positionAmt || 0));
          const side = contracts > 0 ? 'long' : (contracts < 0 ? 'short' : 'N/A');
          const entryPrice = pos.entryPrice || pos.entry_price || pos.markPrice || 'N/A';
          console.log(`   ${idx + 1}. ${symbol} - ${side} - Contracts: ${Math.abs(contracts)} - Entry: ${entryPrice}`);
        });
        console.log('');
      }
    } catch (error) {
      console.error(`❌ Lỗi khi fetch positions từ exchange:`, error?.message || error);
      throw error;
    }

    // 4. Sync positions
    console.log('📋 [4] Đang sync positions từ exchange về database...');
    console.log('-'.repeat(80));
    
    const positionSync = new PositionSync();
    await positionSync.syncBotPositions(bot.id, exchangeService);
    
    console.log('-'.repeat(80));
    console.log('✅ Đã hoàn thành sync positions!');
    console.log('');

    // 5. Kiểm tra kết quả
    console.log('📋 [5] Kiểm tra kết quả trong database...');
    const pool = await import('../src/config/database.js');
    const [positions] = await pool.default.execute(
      `SELECT p.*, s.symbol as strategy_symbol, s.bot_id
       FROM positions p
       JOIN strategies s ON p.strategy_id = s.id
       WHERE s.bot_id = ? AND p.status = 'open'
       ORDER BY p.id DESC`,
      [bot.id]
    );

    console.log(`✅ Tìm thấy ${positions.length} open positions trong database cho bot_id = ${bot.id}`);
    
    if (positions.length > 0) {
      console.log('');
      console.log('📊 Danh sách positions:');
      positions.forEach((pos, idx) => {
        console.log(`   ${idx + 1}. Position ID: ${pos.id}`);
        console.log(`      Symbol: ${pos.symbol}`);
        console.log(`      Side: ${pos.side}`);
        console.log(`      Amount: ${pos.amount}`);
        console.log(`      Entry Price: ${pos.entry_price}`);
        console.log(`      Status: ${pos.status}`);
        console.log('');
      });
    } else {
      console.log('   ℹ️  Không có open positions nào trong database');
    }

    console.log('='.repeat(80));
    console.log('✅ HOÀN TẤT!');
    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('\n❌ LỖI:', error);
    logger.error(`Error syncing position for bot ${botId}:`, error);
    process.exit(1);
  }
}

// Parse arguments and run sync
const { botId } = parseArgs();
syncPosition(botId)
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

