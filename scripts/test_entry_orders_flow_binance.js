#!/usr/bin/env node
/**
 * Test script: verify entry_orders + monitor flow on Binance Futures testnet (bot_id=3)
 *
 * Flow:
 *  - Create a temporary strategy in DB for bot 3
 *  - Place a SMALL LIMIT entry order using the real strategy_id
 *  - Immediately inspect:
 *      - entry_orders: new row should appear with status='open'
 *      - positions: should NOT have new open position yet (if order not filled)
 *  - Then:
 *      - Wait some seconds and re-check; if order filled, EntryOrderMonitor should have:
 *          - created a Position
 *          - marked entry_orders.status='filled'
 *      - If cancelled/expired, entry_orders.status should become 'canceled'/'expired' and still no Position
 *  - Finally, clean up (delete) the temporary strategy
 *
 * Usage:
 *  node scripts/test_entry_orders_flow_binance.js --symbol ETHUSDT --side long|short --amount 50 --offset_pct 0.5 --confirm
 */

import dotenv from 'dotenv';
import logger from '../src/utils/logger.js';
import pool from '../src/config/database.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import { OrderService } from '../src/services/OrderService.js';
import { TelegramService } from '../src/services/TelegramService.js';

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

function usage(msg = null) {
  if (msg) console.error(`Error: ${msg}`);
  console.log(`\nUsage: node scripts/test_entry_orders_flow_binance.js --symbol ETHUSDT --side long|short --amount 50 --offset_pct 0.5 --confirm\n`);
  process.exit(msg ? 1 : 0);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getBot3() {
  const { Bot } = await import('../src/models/Bot.js');
  const bot = await Bot.findById(3);
  if (!bot) {
    throw new Error('Bot id=3 not found in database');
  }
  if ((bot.exchange || '').toLowerCase() !== 'binance') {
    throw new Error(`Bot id=3 must be Binance, got exchange=${bot.exchange}`);
  }
  if (!bot.is_active) {
    throw new Error('Bot id=3 is not active (is_active != 1)');
  }
  return bot;
}

async function getCurrentPrice(exSvc, symbol) {
  try {
    const p = await exSvc.getTickerPrice(symbol);
    if (Number.isFinite(Number(p)) && Number(p) > 0) return Number(p);
  } catch (_) {}

  try {
    if (exSvc.binanceDirectClient?.makeMarketDataRequest) {
      const normalized = exSvc.binanceDirectClient.normalizeSymbol(symbol);
      const data = await exSvc.binanceDirectClient.makeMarketDataRequest('/fapi/v1/ticker/price', 'GET', { symbol: normalized });
      const price = Number(data?.price);
      if (Number.isFinite(price) && price > 0) return price;
    }
  } catch (e) {
    logger.warn(`[test_entry_orders_flow] Market data fallback failed: ${e?.message || e}`);
  }

  throw new Error(`Cannot fetch current price for ${symbol}`);
}

async function queryEntryOrdersAndPositions(botId, symbol) {
  const [entryRows] = await pool.execute(
    `SELECT * FROM entry_orders WHERE bot_id = ? AND symbol = ? ORDER BY id DESC LIMIT 5`,
    [botId, symbol]
  );
  const [posRows] = await pool.execute(
    `SELECT * FROM positions WHERE bot_id = ? AND symbol = ? AND status = 'open' ORDER BY id DESC LIMIT 5`,
    [botId, symbol]
  );
  return { entryRows, posRows };
}

async function createTempStrategy(botId, symbol, amount, reduce = 10, upReduce = 0) {
  const [result] = await pool.execute(
    `INSERT INTO strategies (bot_id, symbol, \`interval\`, amount, oc, take_profit, reduce, extend, up_reduce, \`ignore\`, is_active, created_at, updated_at)
     VALUES (?, ?, '15m', ?, 1, 50, ?, 0, ?, 0, 0, NOW(), NOW())`, // Use provided reduce and up_reduce values
    [botId, symbol, amount, reduce, upReduce]
  );
  if (!result.insertId) {
    throw new Error('Failed to create temporary strategy');
  }
  console.log(`[INFO] Created temporary strategy with id=${result.insertId} (reduce=${reduce}, up_reduce=${upReduce})`);
  return result.insertId;
}

async function deleteTempStrategy(strategyId) {
  if (!strategyId) return;
  try {
    const [result] = await pool.execute(
      `DELETE FROM strategies WHERE id = ?`,
      [strategyId]
    );
    if (result.affectedRows > 0) {
      console.log(`[INFO] Cleaned up temporary strategy id=${strategyId}`);
    }
  } catch (e) {
    console.error(`[ERROR] Failed to clean up temp strategy id=${strategyId}: ${e.message}`);
  }
}

async function main() {
  const symbol = String(args.symbol || 'ETHUSDT').toUpperCase().replace(/[\/:_]/g, '');
  const side = String(args.side || '').toLowerCase();
  const amount = Number(args.amount || 50);
  const offsetPct = Number(args.offset_pct || 0.5);
  const reduce = Number(args.reduce || 10);
  const upReduce = Number(args.up_reduce || 0);
  const confirm = !!args.confirm;

  if (!['long', 'short'].includes(side)) usage('Missing/invalid --side');
  if (!Number.isFinite(amount) || amount <= 0) usage('Missing/invalid --amount');

  let tempStrategyId;
  try {
    const bot = await getBot3();
    console.log(`[INFO] Using bot id=3: name=${bot.bot_name || 'N/A'}, exchange=${bot.exchange}, testnet=${bot.binance_testnet}`);

    tempStrategyId = await createTempStrategy(bot.id, symbol, amount, reduce, upReduce);

    const exSvc = new ExchangeService(bot);
    await exSvc.initialize();

    const mockTelegramService = {
      sendMessage: () => Promise.resolve(),
      sendOrderNotification: () => Promise.resolve(),
      sendEntryTradeAlert: () => Promise.resolve()
    };

    const orderSvc = new OrderService(exSvc, mockTelegramService);
    console.log(`[INFO] Services initialized for bot 3.`);

    const current = await getCurrentPrice(exSvc, symbol);
    console.log(`[INFO] Current price for ${symbol}: ${current}`);

    let limitPrice;
    if (side === 'long') {
      limitPrice = current * (1 - offsetPct / 100);
    } else {
      limitPrice = current * (1 + offsetPct / 100);
    }
    limitPrice = Number(limitPrice.toFixed(4));

    // Fetch actual strategy from DB to get all fields
    const [strategyRows] = await pool.execute(
      `SELECT * FROM strategies WHERE id = ?`,
      [tempStrategyId]
    );
    const realStrategy = strategyRows[0];
    if (!realStrategy) {
      throw new Error(`Strategy ${tempStrategyId} not found after creation`);
    }
    realStrategy.bot = bot;

    console.log('\n=== Test Plan (Binance testnet entry_orders flow) ===');
    console.log(`Symbol       : ${symbol}`);
    console.log(`Side         : ${side.toUpperCase()}`);
    console.log(`Amount (USDT): ${amount}`);
    console.log(`Reduce       : ${reduce}`);
    console.log(`Up Reduce    : ${upReduce}`);
    console.log(`Current      : ${current}`);
    console.log(`Limit Price  : ${limitPrice} (offset ${offsetPct}% from market)`);
    console.log(`Mode         : ${confirm ? 'CONFIRMED - WILL PLACE REAL LIMIT ORDER' : 'DRY-RUN'}`);

    if (!confirm) {
      console.log('\nPass --confirm to actually place LIMIT order on Binance testnet.');
      return; // Exit main, finally will run
    }

    console.log('\n[0] Snapshot BEFORE placing order: entry_orders + positions');
    let { entryRows: beforeEntries, posRows: beforePositions } = await queryEntryOrdersAndPositions(bot.id, symbol);
    console.log('entry_orders(before):', beforeEntries);
    console.log('positions(open,before):', beforePositions);

    console.log('\n[1] Placing ENTRY LIMIT order via OrderService.executeSignal...');
    const signal = {
      strategy: realStrategy,
      side: side,
      entryPrice: limitPrice,
      amount: amount
    };

    const result = await orderSvc.executeSignal(signal);

    if (!result || (!result.pending && !result.id)) {
      throw new Error(`Order placement failed or returned invalid result: ${JSON.stringify(result)}`);
    }
    const orderId = result.orderId || result.order_id;
    console.log(`[OK] Order signal executed. Result: ${JSON.stringify(result)}`);

    await sleep(2000);

    console.log('\n[2] Snapshot AFTER placing order (short delay): entry_orders + positions');
    let { entryRows: afterEntries1, posRows: afterPositions1 } = await queryEntryOrdersAndPositions(bot.id, symbol);
    console.log('entry_orders(after 2s):', afterEntries1);
    console.log('positions(open,after 2s):', afterPositions1);

    console.log('\n[3] Waiting 20s for EntryOrderMonitor (WS/REST) to possibly confirm fill/cancel...');
    await sleep(20000);

    console.log('\n[4] Snapshot AFTER 20s: entry_orders + positions');
    let { entryRows: afterEntries2, posRows: afterPositions2 } = await queryEntryOrdersAndPositions(bot.id, symbol);
    console.log('entry_orders(after 20s):', afterEntries2);
    console.log('positions(open,after 2s):', afterPositions2);

    console.log('\n=== Interpretation Guide ===');
    console.log('- Nếu LIMIT chưa khớp:');
    console.log('  + entry_orders: row mới với status="open"');
    console.log('  + positions: KHÔNG nên có position mới tương ứng.');
    console.log('- Nếu LIMIT đã khớp trong khoảng thời gian chờ:');
    console.log('  + entry_orders: status="filled"');
    console.log('  + positions: có position mới với order_id=' + orderId);

  } finally {
    await deleteTempStrategy(tempStrategyId);
    await pool.end();
    console.log('[INFO] Test finished.');
  }
}

main().catch(err => {
  console.error('Fatal error in test_entry_orders_flow_binance:', err?.message || err);
  console.error(err?.stack || '');
  pool.end(); // Ensure pool is closed on error too
  process.exit(1);
});