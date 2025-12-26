#!/usr/bin/env node
/**
 * Test TP Trailing with Time-based Movement
 * 
 * This script tests that TP moves exactly once per minute based on reduce/up_reduce
 * 
 * Usage:
 *   node scripts/test_tp_trail_with_time.js --bot_id 3 --symbol BTCUSDT --side long --amount 300 --reduce 40 --up_reduce 40 --confirm
 */

import { Bot } from '../src/models/Bot.js';
import { Strategy } from '../src/models/Strategy.js';
import { Position } from '../src/models/Position.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import { OrderService } from '../src/services/OrderService.js';
import { PositionMonitor } from '../src/jobs/PositionMonitor.js';
import { TelegramService } from '../src/services/TelegramService.js';
import { calculateTakeProfit } from '../src/utils/calculator.js';
import logger from '../src/utils/logger.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const args = process.argv.slice(2);
  const botId = parseInt(args[args.indexOf('--bot_id') + 1] || '3');
  const symbol = args[args.indexOf('--symbol') + 1] || 'BTCUSDT';
  const side = args[args.indexOf('--side') + 1] || 'long';
  const amount = parseFloat(args[args.indexOf('--amount') + 1] || '300');
  const reduce = parseFloat(args[args.indexOf('--reduce') + 1] || '40');
  const upReduce = parseFloat(args[args.indexOf('--up_reduce') + 1] || '40');
  const confirm = args.includes('--confirm');
  const waitMinutes = parseInt(args[args.indexOf('--wait') + 1] || '2'); // Default wait 2 minutes

  if (!confirm) {
    console.log('[ERROR] This script requires --confirm flag to run (will place real orders on testnet)');
    process.exit(1);
  }

  // 1) Load bot
  const bot = await Bot.findById(botId);
  if (!bot) {
    throw new Error(`Bot ${botId} not found`);
  }
  console.log(`[INFO] Using bot id=${bot.id}: name=${bot.name}, exchange=${bot.exchange}, testnet=${bot.testnet}`);

  // 2) Initialize services
  const exSvc = new ExchangeService(bot);
  await exSvc.initialize();
  
  const telegramSvc = new TelegramService();
  await telegramSvc.initialize();
  
  const orderSvc = new OrderService(exSvc, telegramSvc);
  const posMonitor = new PositionMonitor();
  await posMonitor.addBot(bot);

  // 3) Create temporary strategy
  const strategyData = {
    bot_id: bot.id,
    symbol,
    trade_type: 'both',
    interval: '1m',
    oc: 2,
    extend: 0,
    amount: 0,
    take_profit: 20,
    reduce,
    up_reduce: upReduce,
    ignore: 0,
    is_active: true
  };
  const strategy = await Strategy.create(strategyData);
  console.log(`[INFO] Created temporary strategy id=${strategy.id} bot_id=${bot.id} symbol=${symbol}`);

  try {
    // 4) Get current price
    const entryPrice = await exSvc.getTickerPrice(symbol);
    console.log(`[INFO] Current price for ${symbol}: ${entryPrice}`);

    console.log('\n=== TP Trailing Test (Time-based) ===');
    console.log(`Bot ID      : ${bot.id}`);
    console.log(`Symbol      : ${symbol}`);
    console.log(`Side        : ${side.toUpperCase()}`);
    console.log(`Amount(USDT): ${amount}`);
    console.log(`Entry Price : ${entryPrice}`);
    console.log(`Strategy    : { oc=${strategy.oc}, take_profit=${strategy.take_profit}, reduce=${reduce}, up_reduce=${upReduce} }`);
    console.log(`Wait Time   : ${waitMinutes} minutes`);
    console.log('');

    // 5) Place entry order
    console.log('[1] Placing ENTRY MARKET order...');
    const signal = {
      strategy,
      side,
      entryPrice,
      amount
    };
    
    const res = await orderSvc.executeSignal(signal);
    if (!res || !res.id) {
      throw new Error(`Failed to place entry order: ${JSON.stringify(res)}`);
    }
    console.log(`[OK] Position opened: id=${res.id}, order_id=${res.order_id}`);

    // 6) Place TP/SL orders
    console.log('\n[2] Placing TP/SL orders...');
    let pos = await Position.findById(res.id);
    await posMonitor.placeExitOrder(pos);
    await sleep(3000);

    pos = await Position.findById(res.id);
    console.log(`[OK] TP/SL placed:`);
    console.log(`  - Entry Price: ${pos.entry_price}`);
    console.log(`  - TP Price: ${pos.take_profit_price}`);
    console.log(`  - SL Price: ${pos.stop_loss_price || 'N/A'}`);
    console.log(`  - TP Order ID: ${pos.tp_order_id || 'N/A'}`);
    console.log(`  - SL Order ID: ${pos.sl_order_id || 'N/A'}`);

    const initialTP = parseFloat(pos.take_profit_price);
    const entryPriceActual = parseFloat(pos.entry_price);

    // 7) Monitor position over time
    console.log(`\n[3] Monitoring position for ${waitMinutes} minutes...`);
    console.log(`[INFO] TP should move from ${initialTP.toFixed(2)} towards ${entryPriceActual.toFixed(2)} every minute`);
    console.log(`[INFO] Expected movement per minute: ${side === 'long' ? upReduce : reduce}%\n`);

    const startTime = Date.now();
    const endTime = startTime + (waitMinutes * 60 * 1000);
    let lastMinute = -1;
    let iteration = 0;

    while (Date.now() < endTime) {
      iteration++;
      const currentTime = Date.now();
      const elapsedSeconds = Math.floor((currentTime - startTime) / 1000);
      const elapsedMinutes = Math.floor((currentTime - startTime) / (60 * 1000));

      // Only log when minute changes
      if (elapsedMinutes !== lastMinute) {
        lastMinute = elapsedMinutes;
        
        console.log(`\n[Monitor - ${elapsedMinutes}m ${elapsedSeconds % 60}s elapsed]`);
        
        // Reload position
        pos = await Position.findById(res.id);
        if (!pos || pos.status !== 'open') {
          console.log(`[INFO] Position ${res.id} is no longer open (status=${pos?.status}). Stopping monitor.`);
          break;
        }

        const currentPrice = await exSvc.getTickerPrice(symbol);
        const currentTP = parseFloat(pos.take_profit_price);
        const minutesElapsedDB = pos.minutes_elapsed || 0;

        console.log(`  Position State:`);
        console.log(`    - Status: ${pos.status}`);
        console.log(`    - Entry Price: ${pos.entry_price}`);
        console.log(`    - Current Price: ${currentPrice}`);
        console.log(`    - TP Price: ${currentTP.toFixed(2)} (initial: ${initialTP.toFixed(2)})`);
        console.log(`    - Minutes Elapsed (DB): ${minutesElapsedDB}`);
        console.log(`    - Minutes Elapsed (Actual): ${elapsedMinutes}`);
        console.log(`    - PnL: ${pos.pnl || 'N/A'}`);

        // Call monitorPosition to trigger TP trailing
        console.log(`  Calling monitorPosition()...`);
        try {
          await posMonitor.monitorPosition(pos);
        } catch (error) {
          console.error(`  [ERROR] monitorPosition failed:`, error?.message || error);
        }

        // Reload and check if TP changed
        await sleep(2000);
        const afterPos = await Position.findById(res.id);
        const afterTP = parseFloat(afterPos.take_profit_price);
        const afterMinutesDB = afterPos.minutes_elapsed || 0;

        if (afterTP !== currentTP) {
          const tpMovement = Math.abs(afterTP - currentTP);
          const tpMovementPercent = (tpMovement / entryPriceActual) * 100;
          console.log(`  ✅ TP MOVED: ${currentTP.toFixed(2)} → ${afterTP.toFixed(2)} (${tpMovementPercent.toFixed(2)}%)`);
        } else {
          console.log(`  ⚠️ TP NOT MOVED: ${currentTP.toFixed(2)} (expected to move after ${elapsedMinutes} minutes)`);
        }

        if (afterMinutesDB !== minutesElapsedDB) {
          console.log(`  ✅ minutes_elapsed updated: ${minutesElapsedDB} → ${afterMinutesDB}`);
        }
      }

      // Sleep for 10 seconds before next check
      await sleep(10000);
    }

    console.log(`\n[4] Test completed after ${waitMinutes} minutes`);
    
    // Final position state
    pos = await Position.findById(res.id);
    if (pos && pos.status === 'open') {
      const finalTP = parseFloat(pos.take_profit_price);
      const tpTotalMovement = Math.abs(finalTP - initialTP);
      const tpTotalMovementPercent = (tpTotalMovement / entryPriceActual) * 100;
      
      console.log(`\n=== Final Position State ===`);
      console.log(`  - Initial TP: ${initialTP.toFixed(2)}`);
      console.log(`  - Final TP: ${finalTP.toFixed(2)}`);
      console.log(`  - Total Movement: ${tpTotalMovement.toFixed(2)} (${tpTotalMovementPercent.toFixed(2)}%)`);
      console.log(`  - Expected Movement: ${waitMinutes} × ${side === 'long' ? upReduce : reduce}% = ${waitMinutes * (side === 'long' ? upReduce : reduce)}%`);
      console.log(`  - Minutes Elapsed (DB): ${pos.minutes_elapsed || 0}`);
      console.log(`  - PnL: ${pos.pnl || 'N/A'}`);
      
      if (Math.abs(tpTotalMovementPercent - (waitMinutes * (side === 'long' ? upReduce : reduce))) < 1) {
        console.log(`\n✅ TEST PASSED: TP moved as expected!`);
      } else {
        console.log(`\n⚠️ TEST WARNING: TP movement doesn't match expected value`);
      }
    }

  } finally {
    // Cleanup: DO NOT delete strategy to preserve position data for analysis
    // Strategy can be manually deleted later if needed
    console.log(`\n[INFO] Test completed. Strategy id=${strategy.id} and position data preserved for analysis.`);
    console.log(`[INFO] To clean up manually, run: DELETE FROM strategies WHERE id=${strategy.id};`);
  }
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

