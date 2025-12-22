#!/usr/bin/env node
/**
 * Script: test_tp_sl_flow_binance.js
 *
 * Mục tiêu:
 * - Cô lập và verify luồng: OPEN POSITION -> PLACE TP/SL -> TRAILING (reduce / up_reduce)
 * - Chạy trên Binance Futures TESTNET với bot_id = 3
 * - Mở 1 lệnh SHORT BTCUSDT với size nhỏ, dùng MARKET để khớp ngay
 * - Ngay sau khi position mở:
 *   + Đảm bảo Position được tạo trong DB
 *   + Gọi PositionMonitor.placeTpSlOrders() để đặt TP/SL trên sàn
 *   + Gọi PositionMonitor.monitorPosition() vài lần để quan sát log đuổi SL/TP
 *
 * Usage:
 *  node scripts/test_tp_sl_flow_binance.js --bot_id 3 --symbol BTCUSDT --side short --amount 30 --confirm
 */

import dotenv from 'dotenv';
import pool from '../src/config/database.js';
import logger from '../src/utils/logger.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import { OrderService } from '../src/services/OrderService.js';
import { PositionMonitor } from '../src/jobs/PositionMonitor.js';
import { TelegramService } from '../src/services/TelegramService.js';
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

function normalizeSymbol(sym) {
  const s = String(sym || '').toUpperCase().replace(/[\/:_]/g, '');
  if (s === 'BTC') return 'BTCUSDT';
  return s;
}

async function getBot(botId) {
  const bot = await Bot.findById(botId);
  if (!bot) throw new Error(`Bot id=${botId} not found`);
  if ((bot.exchange || '').toLowerCase() !== 'binance') {
    throw new Error(`Bot id=${botId} must be Binance, got exchange=${bot.exchange}`);
  }
  if (!bot.binance_testnet) {
    logger.warn(`[TP/SL Test] Bot ${botId} không bật testnet (binance_testnet=false). ĐẢM BẢO đây là tài khoản test nếu vẫn tiếp tục.`);
  }
  if (!bot.is_active) {
    throw new Error(`Bot id=${botId} is not active (is_active != 1)`);
  }
  return bot;
}

async function createTempStrategy(botId, symbol, amountUSDT, reduce, upReduce) {
  // Chiến lược tạm:
  // - interval: 15m
  // - oc: 2%
  // - take_profit: 20%
  // - reduce / up_reduce: cấu hình từ CLI để test trailing
  
  // Cleanup any existing temporary strategy for this bot/symbol to avoid duplicates
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
    `INSERT INTO strategies (bot_id, symbol, \`interval\`, amount, oc, take_profit, reduce, extend, up_reduce, stoploss, \`ignore\`, is_active, created_at, updated_at)
     VALUES (?, ?, '15m', ?, 2, 20, ?, 0, ?, 2, 0, 0, NOW(), NOW())`,
    [botId, symbol, amountUSDT, reduce, upReduce]
  );
  if (!res.insertId) {
    throw new Error('Failed to create temporary strategy for TP/SL test');
  }
  const id = res.insertId;
  logger.info(`[TP/SL Test] Created temporary strategy id=${id} bot_id=${botId} symbol=${symbol}`);
  return id;
}

async function deleteTempStrategy(strategyId) {
  if (!strategyId) return;
  try {
    const [res] = await pool.execute(
      `DELETE FROM strategies WHERE id = ?`,
      [strategyId]
    );
    if (res.affectedRows > 0) {
      logger.info(`[TP/SL Test] Cleaned up temporary strategy id=${strategyId}`);
    }
  } catch (e) {
    logger.warn(`[TP/SL Test] Failed to clean up temp strategy id=${strategyId}: ${e?.message || e}`);
  }
}

async function main() {
  const botId = Number(args.bot_id || 3);
  const symbol = normalizeSymbol(args.symbol || 'BTCUSDT');
  const side = String(args.side || 'short').toLowerCase();
  const amount = Number(args.amount || 30); // USDT
  const reduce = Number(args.reduce ?? 5);
  const upReduce = Number(args.up_reduce ?? 5);
  const confirm = !!args.confirm;

  if (!['long', 'short'].includes(side)) {
    throw new Error(`Invalid --side=${side}, must be long|short`);
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid --amount=${amount}`);
  }
  if (!Number.isFinite(reduce) || reduce < 0) {
    throw new Error(`Invalid --reduce=${reduce}`);
  }
  if (!Number.isFinite(upReduce) || upReduce < 0) {
    throw new Error(`Invalid --up_reduce=${upReduce}`);
  }

  let tempStrategyId;

  try {
    const bot = await getBot(botId);
    console.log(`[INFO] Using bot id=${bot.id}: name=${bot.bot_name || 'N/A'}, exchange=${bot.exchange}, testnet=${bot.binance_testnet}`);

    const telegram = new TelegramService();
    await telegram.initialize();

    const exSvc = new ExchangeService(bot);
    await exSvc.initialize();
    const orderSvc = new OrderService(exSvc, telegram);
    const posMonitor = new PositionMonitor();
    // Inject telegram + add only this bot
    posMonitor.telegramService = telegram;
    await posMonitor.addBot(bot);

    tempStrategyId = await createTempStrategy(bot.id, symbol, amount, reduce, upReduce);

    // Mock strategy object như StrategyService trả về
    const strategy = {
      id: tempStrategyId,
      bot_id: bot.id,
      symbol,
      amount,
      oc: 2,
      take_profit: 20,
      reduce,
      up_reduce: upReduce,
      bot
    };

    const current = await exSvc.getTickerPrice(symbol);
    if (!Number.isFinite(Number(current)) || Number(current) <= 0) {
      throw new Error(`Cannot fetch current price for ${symbol}: ${current}`);
    }
    console.log(`[INFO] Current price for ${symbol}: ${current}`);

    const entryPrice = Number(current); // dùng MARKET, nên entry ~ current

    console.log('\n=== TP/SL Flow Test (Binance testnet) ===');
    console.log(`Bot ID      : ${bot.id}`);
    console.log(`Symbol      : ${symbol}`);
    console.log(`Side        : ${side.toUpperCase()}`);
    console.log(`Amount(USDT): ${amount}`);
    console.log(`Entry Price : ${entryPrice}`);
    console.log(`Mode        : ${confirm ? 'CONFIRMED - WILL PLACE REAL MARKET ORDER' : 'DRY-RUN'}`);
    console.log(`Strategy    : { oc=2, take_profit=20, reduce=${reduce}, up_reduce=${upReduce} }`);

    if (!confirm) {
      console.log('\nPass --confirm để thực sự gửi lệnh MARKET lên Binance testnet.');
      return;
    }

    // 1) Snapshot BEFORE
    const beforePositions = await Position.findOpenBySymbol(symbol);
    console.log('\n[0] Open positions BEFORE:', beforePositions.filter(p => Number(p.bot_id) === bot.id));

    // 2) Place ENTRY MARKET via OrderService.executeSignal
    console.log('\n[1] Placing ENTRY MARKET order via OrderService.executeSignal...');
    const signal = {
      strategy,
      side,
      entryPrice,
      amount
    };
    
    // Retry logic for concurrency lock timeout
    let res = null;
    const maxRetries = 5;
    const retryDelay = 2000; // 2 seconds
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      res = await orderSvc.executeSignal(signal);
      if (res && res.id) {
        break; // Success
      }
      
      if (attempt < maxRetries) {
        console.log(`[Retry ${attempt}/${maxRetries}] Concurrency lock timeout or limit reached, waiting ${retryDelay}ms before retry...`);
        console.log(`[Info] This may be due to many open positions or concurrent requests. Consider closing some positions if this persists.`);
        await sleep(retryDelay);
      } else {
        // Get concurrency status for better error message
        const { concurrencyManager } = await import('../src/services/ConcurrencyManager.js');
        const status = await concurrencyManager.getStatus(bot.id);
        throw new Error(
          `OrderService.executeSignal failed after ${maxRetries} attempts.\n` +
          `Last result: ${JSON.stringify(res)}\n` +
          `Concurrency status: ${status.currentCount}/${status.maxConcurrent} positions open.\n` +
          `This may be due to:\n` +
          `  1. Concurrency lock timeout (too many concurrent requests)\n` +
          `  2. Max concurrent trades limit reached\n` +
          `  3. Too many open positions (${status.currentCount}/${status.maxConcurrent})\n` +
          `Solution: Close some positions or wait a few seconds and retry.`
        );
      }
    }
    
    if (!res || !res.id) {
      throw new Error(`OrderService.executeSignal did not return a Position: ${JSON.stringify(res)}`);
    }
    console.log(`[OK] Position opened: id=${res.id}, order_id=${res.order_id}, side=${res.side}, entry_price=${res.entry_price}`);

    // 3) Reload position from DB
    let pos = await Position.findById(res.id);
    console.log('\n[2] Position from DB right after open:', {
      id: pos.id,
      bot_id: pos.bot_id,
      symbol: pos.symbol,
      side: pos.side,
      entry_price: pos.entry_price,
      take_profit_price: pos.take_profit_price,
      stop_loss_price: pos.stop_loss_price,
      tp_order_id: pos.tp_order_id,
      sl_order_id: pos.sl_order_id
    });

    // 4) Force TP/SL placement via PositionMonitor.placeTpSlOrders
    console.log('\n[3] Forcing TP/SL placement via PositionMonitor.placeTpSlOrders() ...');
    await posMonitor.placeTpSlOrders(pos);
    await sleep(3000);

    // 5) Reload position to inspect TP/SL orders
    pos = await Position.findById(res.id);
    console.log('\n[4] Position AFTER TP/SL placement attempt:', {
      id: pos.id,
      bot_id: pos.bot_id,
      symbol: pos.symbol,
      side: pos.side,
      entry_price: pos.entry_price,
      take_profit_price: pos.take_profit_price,
      stop_loss_price: pos.stop_loss_price,
      tp_order_id: pos.tp_order_id,
      sl_order_id: pos.sl_order_id
    });

    if (!pos.tp_order_id || !pos.sl_order_id) {
      console.log('\n[WARN] TP hoặc SL vẫn chưa được gắn vào position trong DB. Kiểm tra log [Place TP/SL] và Binance open orders để debug thêm.');
    } else {
      console.log('\n[OK] TP/SL đã được tạo và gắn vào position trong DB.');
    }

    // 6) Chạy vài vòng monitorPosition để xem log đuổi giá (reduce / up_reduce)
    console.log('\n[5] Running monitorPosition() vài lần để quan sát log SL Update / TP Chase ...');
    for (let i = 1; i <= 5; i++) {
      console.log(`\n[Monitor Iteration ${i}]`);
      const fresh = await Position.findById(res.id);
      if (!fresh || fresh.status !== 'open') {
        console.log(`[INFO] Position ${res.id} không còn open (status=${fresh?.status}). Dừng monitor.`);
        break;
      }
      
      // Log position state BEFORE monitoring
      const openedAt = fresh.opened_at ? new Date(fresh.opened_at).getTime() : Date.now();
      const now = Date.now();
      const actualMinutesElapsed = Math.floor((now - openedAt) / (60 * 1000));
      const currentPrice = await exSvc.getTickerPrice(fresh.symbol);
      
      console.log(`[BEFORE Monitor] Position State:`);
      console.log(`  - ID: ${fresh.id}`);
      console.log(`  - Status: ${fresh.status}`);
      console.log(`  - Side: ${fresh.side}`);
      console.log(`  - Entry Price: ${fresh.entry_price}`);
      console.log(`  - Current Market Price: ${currentPrice}`);
      console.log(`  - Take Profit Price: ${fresh.take_profit_price}`);
      console.log(`  - Stop Loss Price: ${fresh.stop_loss_price}`);
      console.log(`  - TP Order ID: ${fresh.tp_order_id || 'N/A'}`);
      console.log(`  - SL Order ID: ${fresh.sl_order_id || 'N/A'}`);
      console.log(`  - Minutes Elapsed (DB): ${fresh.minutes_elapsed || 0}`);
      console.log(`  - Minutes Elapsed (Actual): ${actualMinutesElapsed}`);
      console.log(`  - Reduce: ${fresh.reduce || 'N/A'}`);
      console.log(`  - Up Reduce: ${fresh.up_reduce || 'N/A'}`);
      console.log(`  - Opened At: ${fresh.opened_at}`);
      console.log(`  - Time Since Open: ${Math.floor((now - openedAt) / 1000)} seconds`);
      
      // Call monitorPosition
      console.log(`\n[Calling monitorPosition...]`);
      try {
        await posMonitor.monitorPosition(fresh);
      } catch (error) {
        console.error(`[ERROR] monitorPosition failed:`, error?.message || error);
        console.error(error?.stack);
      }
      
      // Wait and reload position
      await sleep(2000);
      const afterFresh = await Position.findById(res.id);
      
      // Log position state AFTER monitoring
      console.log(`\n[AFTER Monitor] Position State:`);
      console.log(`  - Status: ${afterFresh?.status || 'N/A'}`);
      console.log(`  - Take Profit Price: ${afterFresh?.take_profit_price || 'N/A'} (was: ${fresh.take_profit_price})`);
      console.log(`  - Stop Loss Price: ${afterFresh?.stop_loss_price || 'N/A'} (was: ${fresh.stop_loss_price})`);
      console.log(`  - TP Order ID: ${afterFresh?.tp_order_id || 'N/A'} (was: ${fresh.tp_order_id || 'N/A'})`);
      console.log(`  - SL Order ID: ${afterFresh?.sl_order_id || 'N/A'} (was: ${fresh.sl_order_id || 'N/A'})`);
      console.log(`  - Minutes Elapsed (DB): ${afterFresh?.minutes_elapsed || 0} (was: ${fresh.minutes_elapsed || 0})`);
      console.log(`  - PnL: ${afterFresh?.pnl || 'N/A'}`);
      
      // Check if TP/SL changed
      const tpChanged = afterFresh?.take_profit_price !== fresh.take_profit_price;
      const slChanged = afterFresh?.stop_loss_price !== fresh.stop_loss_price;
      const tpOrderChanged = afterFresh?.tp_order_id !== fresh.tp_order_id;
      const slOrderChanged = afterFresh?.sl_order_id !== fresh.sl_order_id;
      
      if (tpChanged || slChanged || tpOrderChanged || slOrderChanged) {
        console.log(`\n[CHANGES DETECTED]`);
        if (tpChanged) console.log(`  ✅ TP Price changed: ${fresh.take_profit_price} → ${afterFresh?.take_profit_price}`);
        if (slChanged) console.log(`  ✅ SL Price changed: ${fresh.stop_loss_price} → ${afterFresh?.stop_loss_price}`);
        if (tpOrderChanged) console.log(`  ✅ TP Order changed: ${fresh.tp_order_id || 'N/A'} → ${afterFresh?.tp_order_id || 'N/A'}`);
        if (slOrderChanged) console.log(`  ✅ SL Order changed: ${fresh.sl_order_id || 'N/A'} → ${afterFresh?.sl_order_id || 'N/A'}`);
      } else {
        console.log(`\n[NO CHANGES] TP/SL prices and orders remain unchanged.`);
        console.log(`  - Actual minutes elapsed: ${actualMinutesElapsed}`);
        console.log(`  - DB minutes elapsed: ${afterFresh?.minutes_elapsed || 0}`);
        if (actualMinutesElapsed > (afterFresh?.minutes_elapsed || 0)) {
          console.log(`  ⚠️  WARNING: Actual time (${actualMinutesElapsed} min) > DB time (${afterFresh?.minutes_elapsed || 0} min) - SL/TP should have moved!`);
        }
      }
      
      await sleep(3000); // Wait 3 seconds between iterations
    }

    console.log('\n=== TP/SL Flow Test FINISHED ===');
  } finally {
    if (tempStrategyId) {
      await deleteTempStrategy(tempStrategyId);
    }
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal error in test_tp_sl_flow_binance:', err?.message || err);
  console.error(err?.stack || '');
  pool.end();
  process.exit(1);
});


