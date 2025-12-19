#!/usr/bin/env node
/**
 * Script: test_and_monitor_sl.js
 * 
 * Mục đích: Tạo position và monitor SL movement ngay sau đó
 * 
 * Usage:
 *   node scripts/test_and_monitor_sl.js --bot_id 3 --symbol BTC --side long --amount 200 --reduce 5 --up_reduce 5 --confirm
 */

import dotenv from 'dotenv';
import pool from '../src/config/database.js';
import logger from '../src/utils/logger.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import { OrderService } from '../src/services/OrderService.js';
import { PositionMonitor } from '../src/jobs/PositionMonitor.js';
import { Position } from '../src/models/Position.js';
import { Bot } from '../src/models/Bot.js';

dotenv.config();

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.replace(/^--/, '');
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function createTempStrategy(botId, symbol, amountUSDT, reduce, upReduce) {
  try {
    await pool.execute(
      `DELETE FROM strategies 
       WHERE bot_id = ? AND symbol = ? AND \`interval\` = '15m' AND oc = 2 AND take_profit = 20 
       AND is_active = 0`,
      [botId, symbol]
    );
  } catch (e) {
    // Ignore cleanup errors
  }
  
  const [res] = await pool.execute(
    `INSERT INTO strategies (bot_id, symbol, \`interval\`, amount, oc, take_profit, reduce, extend, up_reduce, \`ignore\`, is_active, created_at, updated_at)
     VALUES (?, ?, '15m', ?, 2, 20, ?, 0, ?, 0, 0, NOW(), NOW())`,
    [botId, symbol, amountUSDT, reduce, upReduce]
  );
  return res.insertId;
}

async function main() {
  const botId = args.bot_id ? Number(args.bot_id) : 3;
  let symbol = args.symbol || 'BTCUSDT';
  // Normalize symbol: BTC -> BTCUSDT
  if (symbol === 'BTC') symbol = 'BTCUSDT';
  const side = args.side || 'long';
  const amount = args.amount ? Number(args.amount) : 200;
  const reduce = args.reduce ? Number(args.reduce) : 5;
  const upReduce = args.up_reduce ? Number(args.up_reduce) : 5;
  const confirm = args.confirm === true || args.confirm === 'true';
  const monitorDuration = args.duration ? Number(args.duration) : 180; // 3 minutes
  const monitorInterval = args.interval ? Number(args.interval) : 5; // 5 seconds

  if (!confirm) {
    console.log('⚠️  DRY-RUN MODE: Add --confirm to actually create position');
    process.exit(0);
  }

  console.log('\n🚀 Creating Position and Monitoring SL Movement\n');
  console.log(`Bot ID: ${botId}`);
  console.log(`Symbol: ${symbol}`);
  console.log(`Side: ${side}`);
  console.log(`Amount: ${amount} USDT`);
  console.log(`Reduce: ${reduce}`);
  console.log(`Up Reduce: ${upReduce}`);
  console.log(`Monitor Duration: ${monitorDuration} seconds`);
  console.log(`Monitor Interval: ${monitorInterval} seconds\n`);

  let tempStrategyId = null;
  let positionId = null;

  try {
    // 1. Get bot
    const bot = await Bot.findById(botId);
    if (!bot) {
      throw new Error(`Bot ${botId} not found`);
    }

    // 2. Create temp strategy
    tempStrategyId = await createTempStrategy(botId, symbol, amount, reduce, upReduce);
    console.log(`✅ Created temporary strategy id=${tempStrategyId}\n`);

    // 3. Get strategy with bot info
    const [strategyRows] = await pool.execute(
      `SELECT * FROM strategies WHERE id = ?`,
      [tempStrategyId]
    );
    const strategy = strategyRows[0];
    strategy.bot = bot;

    // 4. Initialize services
    const exSvc = new ExchangeService(bot);
    await exSvc.initialize(); // Initialize exchange service
    const entryPrice = await exSvc.getTickerPrice(symbol);
    console.log(`📊 Current price for ${symbol}: ${entryPrice}\n`);

    // 5. Initialize Telegram and OrderService
    const { TelegramService } = await import('../src/services/TelegramService.js');
    const telegram = new TelegramService();
    await telegram.initialize();
    
    // 6. Create position via OrderService
    console.log('📝 Creating position via OrderService.executeSignal...\n');
    const orderSvc = new OrderService(exSvc, telegram);
    const signal = {
      strategy,
      side,
      entryPrice,
      amount
    };

    let res = null;
    const maxRetries = 5;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      res = await orderSvc.executeSignal(signal);
      if (res && res.id) {
        break;
      }
      if (attempt < maxRetries) {
        console.log(`[Retry ${attempt}/${maxRetries}] Waiting 2s...\n`);
        await sleep(2000);
      }
    }

    if (!res || !res.id) {
      throw new Error(`Failed to create position after ${maxRetries} attempts`);
    }

    positionId = res.id;
    console.log(`✅ Position created: id=${positionId}, entry_price=${res.entry_price}\n`);

    // 7. Initialize PositionMonitor
    const posMonitor = new PositionMonitor();
    posMonitor.telegramService = telegram;
    await posMonitor.addBot(bot);
    
    // 8. Place TP/SL orders
    console.log('📌 Placing TP/SL orders...\n');
    let pos = await Position.findById(positionId);
    await posMonitor.placeTpSlOrders(pos);
    await sleep(3000);

    // 9. Reload position
    pos = await Position.findById(positionId);
    console.log(`✅ TP/SL placed: TP=${pos.tp_order_id}, SL=${pos.sl_order_id}\n`);

    // 10. Start monitoring
    console.log('='.repeat(100));
    console.log('🔍 Starting SL Movement Monitor\n');
    console.log('='.repeat(100) + '\n');

    const startTime = Date.now();
    const endTime = startTime + (monitorDuration * 1000);
    let iteration = 0;
    let prevSL = Number(pos.stop_loss_price || 0);
    let prevMinutes = Number(pos.minutes_elapsed || 0);
    let prevTP = Number(pos.take_profit_price || 0);

    while (Date.now() < endTime) {
      iteration++;
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const remaining = monitorDuration - elapsed;

      // Reload position
      const fresh = await Position.findById(positionId);
      if (!fresh || fresh.status !== 'open') {
        console.log(`\n⚠️  Position ${positionId} is no longer open (status: ${fresh?.status}). Stopping monitor.`);
        break;
      }

      // Get current price
      let currentPrice;
      try {
        currentPrice = await exSvc.getTickerPrice(fresh.symbol);
      } catch (e) {
        currentPrice = null;
      }

      const currentSL = Number(fresh.stop_loss_price || 0);
      const currentTP = Number(fresh.take_profit_price || 0);
      const currentMinutes = Number(fresh.minutes_elapsed || 0);

      // Calculate time since position opened
      const openedAt = fresh.opened_at ? new Date(fresh.opened_at).getTime() : null;
      const actualMinutesElapsed = openedAt ? Math.floor((Date.now() - openedAt) / (60 * 1000)) : null;

      // Check for changes
      const slChanged = Math.abs(currentSL - prevSL) > 0.01;
      const tpChanged = Math.abs(currentTP - prevTP) > 0.01;
      const minutesChanged = currentMinutes !== prevMinutes;

      // Display status
      const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`\n[${timestamp}] Iteration ${iteration} | Elapsed: ${elapsed}s | Remaining: ${remaining}s`);
      console.log(`  Current Price: ${currentPrice ? currentPrice.toFixed(2) : 'N/A'}`);
      console.log(`  Stop Loss: ${currentSL.toFixed(2)} ${slChanged ? `(CHANGED from ${prevSL.toFixed(2)})` : ''}`);
      console.log(`  Take Profit: ${currentTP.toFixed(2)} ${tpChanged ? `(CHANGED from ${prevTP.toFixed(2)})` : ''}`);
      console.log(`  Minutes Elapsed (DB): ${currentMinutes} ${minutesChanged ? `(CHANGED from ${prevMinutes})` : ''}`);
      console.log(`  Minutes Elapsed (Actual): ${actualMinutesElapsed !== null ? actualMinutesElapsed : 'N/A'}`);

      if (slChanged || tpChanged || minutesChanged) {
        console.log(`  ✅ CHANGES DETECTED!`);
        if (slChanged) {
          const slDelta = currentSL - prevSL;
          const slDeltaPercent = ((slDelta / prevSL) * 100).toFixed(4);
          console.log(`     SL moved: ${prevSL.toFixed(2)} → ${currentSL.toFixed(2)} (Δ${slDelta > 0 ? '+' : ''}${slDelta.toFixed(2)}, ${slDeltaPercent > 0 ? '+' : ''}${slDeltaPercent}%)`);
        }
        if (tpChanged) {
          const tpDelta = currentTP - prevTP;
          const tpDeltaPercent = ((tpDelta / prevTP) * 100).toFixed(4);
          console.log(`     TP moved: ${prevTP.toFixed(2)} → ${currentTP.toFixed(2)} (Δ${tpDelta > 0 ? '+' : ''}${tpDelta.toFixed(2)}, ${tpDeltaPercent > 0 ? '+' : ''}${tpDeltaPercent}%)`);
        }
        if (minutesChanged) {
          console.log(`     Minutes elapsed: ${prevMinutes} → ${currentMinutes}`);
        }
      } else {
        console.log(`  ⏳ No changes detected`);
      }

      // Update previous values
      prevSL = currentSL;
      prevTP = currentTP;
      prevMinutes = currentMinutes;

      // Call monitorPosition to trigger updates
      try {
        await posMonitor.monitorPosition(fresh);
      } catch (e) {
        logger.error(`Error in monitorPosition: ${e?.message || e}`);
      }

      // Wait before next iteration
      if (remaining > 0) {
        await sleep(monitorInterval * 1000);
      }
    }

    console.log('\n' + '='.repeat(100));
    console.log('\n✅ Monitoring completed!');
    console.log(`   Total iterations: ${iteration}`);
    console.log(`   Total duration: ${Math.floor((Date.now() - startTime) / 1000)} seconds`);

    // Final state
    const final = await Position.findById(positionId);
    if (final) {
      console.log('\n📊 Final Position State:');
      console.log(`   Stop Loss Price: ${final.stop_loss_price || 'N/A'}`);
      console.log(`   Take Profit Price: ${final.take_profit_price || 'N/A'}`);
      console.log(`   Minutes Elapsed: ${final.minutes_elapsed || 0}`);
      console.log(`   Status: ${final.status}`);
    }

  } catch (error) {
    logger.error('Failed:', error);
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  } finally {
    if (tempStrategyId) {
      try {
        await pool.execute(`DELETE FROM strategies WHERE id = ?`, [tempStrategyId]);
        console.log(`\n🧹 Cleaned up temporary strategy id=${tempStrategyId}`);
      } catch (e) {
        // Ignore
      }
    }
    // Don't close pool - let it stay open for monitoring
    console.log('\n✨ Done.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

