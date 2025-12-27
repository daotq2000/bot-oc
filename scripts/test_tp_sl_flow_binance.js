#!/usr/bin/env node
/**
 * Script: test_tp_sl_flow_binance.js
 *
 * Mục tiêu:
 * - Test toàn bộ flow giống như bot đang chạy: DETECT -> EXECUTE -> PLACE TP/SL -> TRAILING
 * - Tạo signal giả giống như WebSocketOCConsumer.processMatch tạo
 * - Test đúng luồng từ OrderService.executeSignal -> PositionMonitor.placeExitOrder -> trailing
 *
 * Usage:
 *  node scripts/test_tp_sl_flow_binance.js \
 *    --bot_id 5 \
 *    --symbol MITOUSDT \
 *    --oc 9 \
 *    --interval 1m \
 *    --trade_type short \
 *    --amount 10 \
 *    --take_profit 65 \
 *    --reduce 10 \
 *    --up_reduce 10 \
 *    --extend 10 \
 *    --stoploss 2 \
 *    --is_reverse_strategy 1 \
 *    --confirm
 *
 * Required params:
 *  --bot_id: Bot ID
 *  --symbol: Trading symbol (e.g., MITOUSDT)
 *  --oc: OC threshold percentage
 *  --interval: Candle interval (1m, 5m, etc.)
 *  --trade_type: long or short
 *  --amount: Position amount in USDT
 *  --take_profit: Take profit percentage
 *  --reduce: Reduce percentage for trailing TP
 *  --up_reduce: Up reduce percentage for trailing TP
 *
 * Optional params:
 *  --extend: Extend percentage (default: 10)
 *  --stoploss: Stop loss percentage (default: null, no SL)
 *  --is_reverse_strategy: 0 or 1 (default: 0)
 *  --confirm: Actually place order (without this, it's dry-run)
 */

import dotenv from 'dotenv';
import pool from '../src/config/database.js';
import logger from '../src/utils/logger.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import { OrderService } from '../src/services/OrderService.js';
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

async function createTempStrategy(botId, symbol, strategyConfig) {
  const {
    interval = '1m',
    oc = 2,
    trade_type = 'short',
    amount = 10,
    take_profit = 20,
    reduce = 5,
    up_reduce = 5,
    extend = 10,
    stoploss = null,
    is_reverse_strategy = 0
  } = strategyConfig;
  
  // Cleanup any existing temporary strategy for this bot/symbol/interval/oc to avoid duplicates
  try {
    await pool.execute(
      `DELETE FROM strategies 
       WHERE bot_id = ? AND symbol = ? AND \`interval\` = ? AND oc = ? AND trade_type = ?
       AND is_active = 0`,
      [botId, symbol, interval, oc, trade_type]
    );
  } catch (e) {
    // Ignore cleanup errors
  }
  
  const [res] = await pool.execute(
    `INSERT INTO strategies (bot_id, symbol, \`interval\`, trade_type, amount, oc, take_profit, reduce, extend, up_reduce, stoploss, \`ignore\`, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NOW(), NOW())`,
    [botId, symbol, interval, trade_type, amount, oc, take_profit, reduce, extend, up_reduce, stoploss || null]
  );
  if (!res.insertId) {
    throw new Error('Failed to create temporary strategy for TP/SL test');
  }
  const id = res.insertId;
  logger.info(`[TP/SL Test] Created temporary strategy id=${id} bot_id=${botId} symbol=${symbol} interval=${interval} oc=${oc}% trade_type=${trade_type}`);
  return id;
}

async function deleteTempStrategy(strategyId) {
  if (!strategyId) return;
  try {
    // CRITICAL PROTECTION: Check for open positions before deleting temp strategy
    // Even though this is a test script, we should protect against accidental position deletion
    const { Position } = await import('../src/models/Position.js');
    const openPositions = await Position.findOpen(strategyId);
    
    if (openPositions.length > 0) {
      logger.warn(
        `[TP/SL Test] ⚠️  Cannot delete temp strategy ${strategyId}: ` +
        `Strategy has ${openPositions.length} open position(s). ` +
        `Positions: ${openPositions.map(p => `pos=${p.id} symbol=${p.symbol}`).join(', ')}. ` +
        `Skipping strategy deletion to prevent position loss.`
      );
      return; // Skip deletion to protect positions
    }
    
    // Safe to delete - no open positions
    const [res] = await pool.execute(
      `DELETE FROM strategies WHERE id = ?`,
      [strategyId]
    );
    if (res.affectedRows > 0) {
      logger.info(`[TP/SL Test] Cleaned up temporary strategy id=${strategyId} (no open positions)`);
    }
  } catch (e) {
    // If error is about foreign key constraint (RESTRICT), log warning
    if (e?.code === 'ER_ROW_IS_REFERENCED_2' || e?.message?.includes('foreign key constraint')) {
      logger.warn(
        `[TP/SL Test] ⚠️  Cannot delete temp strategy ${strategyId}: ` +
        `Foreign key constraint prevents deletion (likely has positions). ` +
        `This is expected behavior with RESTRICT constraint. Error: ${e?.message || e}`
      );
    } else {
    logger.warn(`[TP/SL Test] Failed to clean up temp strategy id=${strategyId}: ${e?.message || e}`);
    }
  }
}

async function main() {
  // Required params
  const botId = Number(args.bot_id);
  const symbol = normalizeSymbol(args.symbol);
  const oc = Number(args.oc);
  const interval = String(args.interval || '1m');
  const tradeType = String(args.trade_type || 'short').toLowerCase();
  const amount = Number(args.amount);
  const takeProfit = Number(args.take_profit);
  const reduce = Number(args.reduce);
  const upReduce = Number(args.up_reduce);
  
  // Optional params
  const extend = Number(args.extend ?? 10);
  const stoploss = args.stoploss !== undefined ? Number(args.stoploss) : null;
  const isReverseStrategy = Number(args.is_reverse_strategy ?? 0);
  const confirm = !!args.confirm;

  // Validation
  if (!botId || !Number.isFinite(botId) || botId <= 0) {
    throw new Error(`Invalid or missing --bot_id. Usage: --bot_id 5`);
  }
  if (!symbol) {
    throw new Error(`Invalid or missing --symbol. Usage: --symbol MITOUSDT`);
  }
  if (!Number.isFinite(oc) || oc <= 0) {
    throw new Error(`Invalid or missing --oc. Usage: --oc 9`);
  }
  if (!['long', 'short'].includes(tradeType)) {
    throw new Error(`Invalid --trade_type=${tradeType}, must be long|short`);
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid or missing --amount. Usage: --amount 10`);
  }
  if (!Number.isFinite(takeProfit) || takeProfit <= 0) {
    throw new Error(`Invalid or missing --take_profit. Usage: --take_profit 65`);
  }
  if (!Number.isFinite(reduce) || reduce < 0) {
    throw new Error(`Invalid or missing --reduce. Usage: --reduce 10`);
  }
  if (!Number.isFinite(upReduce) || upReduce < 0) {
    throw new Error(`Invalid or missing --up_reduce. Usage: --up_reduce 10`);
  }
  if (!Number.isFinite(extend) || extend < 0) {
    throw new Error(`Invalid --extend=${extend}, must be >= 0`);
  }
  if (stoploss !== null && (!Number.isFinite(stoploss) || stoploss <= 0)) {
    throw new Error(`Invalid --stoploss=${stoploss}, must be > 0 or omit for no SL`);
  }
  if (![0, 1].includes(isReverseStrategy)) {
    throw new Error(`Invalid --is_reverse_strategy=${isReverseStrategy}, must be 0 or 1`);
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
    
    // NOTE: PositionMonitor is NOT initialized here - let the running bot handle it
    // This script only creates signal and calls OrderService.executeSignal
    // PositionMonitor (running in production) will automatically handle TP/SL placement and trailing

    // Create strategy config
    const strategyConfig = {
      interval,
      oc,
      trade_type: tradeType,
      amount,
      take_profit: takeProfit,
      reduce,
      up_reduce: upReduce,
      extend,
      stoploss,
      is_reverse_strategy: isReverseStrategy
    };

    tempStrategyId = await createTempStrategy(bot.id, symbol, strategyConfig);

    // Get current price
    const currentPrice = await exSvc.getTickerPrice(symbol);
    if (!Number.isFinite(Number(currentPrice)) || Number(currentPrice) <= 0) {
      throw new Error(`Cannot fetch current price for ${symbol}: ${currentPrice}`);
    }
    console.log(`[INFO] Current price for ${symbol}: ${currentPrice}`);

    // Simulate match object like RealtimeOCDetector returns
    // For testing, calculate open price to simulate OC threshold match
    // OC = (current - open) / open * 100
    // If we want OC = ocThreshold, then: open = current / (1 + ocThreshold/100)
    // But for testing, let's simulate a pump that exceeds threshold
    const targetOC = oc * 1.2; // Simulate 20% above threshold for testing
    const openPrice = Number(currentPrice) / (1 + targetOC / 100);
    const ocValue = ((Number(currentPrice) - openPrice) / openPrice) * 100;
    const direction = Number(currentPrice) >= openPrice ? 'bullish' : 'bearish';
    
    console.log('\n=== OC Calculation Details ===');
    console.log(`Current Price      : ${currentPrice}`);
    console.log(`Open Price         : ${openPrice.toFixed(8)}`);
    console.log(`OC Calculation     : (${currentPrice} - ${openPrice.toFixed(8)}) / ${openPrice.toFixed(8)} * 100`);
    console.log(`OC Value           : ${ocValue.toFixed(2)}%`);
    console.log(`OC Threshold       : ${oc}%`);
    console.log(`OC Match           : ${Math.abs(ocValue) >= oc ? '✅ YES' : '❌ NO'} (abs(${ocValue.toFixed(2)}%) >= ${oc}%)`);
    console.log(`Direction          : ${direction}`);

    console.log('\n=== TP/SL Flow Test (Full Flow Simulation) ===');
    console.log(`Bot ID            : ${bot.id}`);
    console.log(`Symbol            : ${symbol}`);
    console.log(`Strategy ID       : ${tempStrategyId}`);
    console.log(`Current Price     : ${currentPrice}`);
    console.log(`Simulated Open    : ${openPrice.toFixed(8)}`);
    console.log(`Simulated OC      : ${ocValue.toFixed(2)}%`);
    console.log(`Direction         : ${direction}`);
    console.log(`Mode              : ${confirm ? 'CONFIRMED - WILL PLACE REAL ORDER' : 'DRY-RUN'}`);
    console.log(`\nStrategy Config:`);
    console.log(`  - OC Threshold   : ${oc}%`);
    console.log(`  - Interval       : ${interval}`);
    console.log(`  - Trade Type      : ${tradeType.toUpperCase()}`);
    console.log(`  - Amount (USDT)   : ${amount}`);
    console.log(`  - Take Profit     : ${takeProfit}%`);
    console.log(`  - Reduce          : ${reduce}%`);
    console.log(`  - Up Reduce       : ${upReduce}%`);
    console.log(`  - Extend          : ${extend}%`);
    console.log(`  - Stop Loss       : ${stoploss || 'N/A'}`);
    console.log(`  - Is Reverse      : ${isReverseStrategy === 1 ? 'Yes' : 'No'}`);

    if (!confirm) {
      console.log('\n⚠️  DRY-RUN MODE: Pass --confirm để thực sự gửi lệnh lên Binance.');
      return;
    }

    // Import calculator functions
    const { calculateTakeProfit, calculateInitialStopLoss, calculateLongEntryPrice, calculateShortEntryPrice } = await import('../src/utils/calculator.js');
    const { determineSide } = await import('../src/utils/sideSelector.js');

    // Determine side based on direction, trade_type and is_reverse_strategy
    const side = determineSide(direction, tradeType, isReverseStrategy);
    if (!side) {
      throw new Error(
        `Side mapping returned NULL: direction=${direction}, trade_type=${tradeType}, is_reverse_strategy=${isReverseStrategy}. ` +
        `Strategy không phù hợp với direction hiện tại.`
      );
    }
    console.log(`\n[Side Mapping] direction=${direction}, trade_type=${tradeType}, is_reverse=${isReverseStrategy} → side=${side}`);

    // Calculate entry price (same logic as WebSocketOCConsumer)
    const baseOpen = openPrice;
    let entryPrice;
    let forceMarket = false;

    console.log('\n=== Entry Price Calculation ===');
    console.log(`Strategy Type      : ${isReverseStrategy === 1 ? 'Counter-trend (is_reverse_strategy=1)' : 'Trend-following (is_reverse_strategy=0)'}`);
    console.log(`Current Price      : ${currentPrice}`);
    console.log(`Open Price         : ${baseOpen.toFixed(8)}`);
    console.log(`Extend             : ${extend}%`);
    
    if (isReverseStrategy === 1) {
      // Counter-trend: Calculate entry price with extend logic
      // Calculate delta and extend ratio
      const delta = Math.abs(Number(currentPrice) - baseOpen);
      const extendRatio = extend / 100;
      
      console.log(`\n[Extend Calculation]`);
      console.log(`Delta              : abs(${currentPrice} - ${baseOpen.toFixed(8)}) = ${delta.toFixed(8)}`);
      console.log(`Extend Ratio       : ${extend}% / 100 = ${extendRatio}`);
      
      if (side === 'long') {
        // LONG: entry = current - extendRatio * delta (entry < current)
        entryPrice = Number(currentPrice) - extendRatio * delta;
        console.log(`Entry Formula      : entry = current - extendRatio * delta`);
        console.log(`Entry Calculation  : ${currentPrice} - ${extendRatio} * ${delta.toFixed(8)}`);
        console.log(`Entry Price        : ${entryPrice.toFixed(8)}`);
        console.log(`Entry < Current    : ${entryPrice < Number(currentPrice) ? '✅ YES' : '❌ NO'} (${entryPrice.toFixed(8)} < ${currentPrice})`);
      } else {
        // SHORT: entry = current + extendRatio * delta (entry > current)
        entryPrice = Number(currentPrice) + extendRatio * delta;
        console.log(`Entry Formula      : entry = current + extendRatio * delta`);
        console.log(`Entry Calculation  : ${currentPrice} + ${extendRatio} * ${delta.toFixed(8)}`);
        console.log(`Entry Price        : ${entryPrice.toFixed(8)}`);
        console.log(`Entry > Current    : ${entryPrice > Number(currentPrice) ? '✅ YES' : '❌ NO'} (${entryPrice.toFixed(8)} > ${currentPrice})`);
      }
      
      // Use LIMIT order for counter-trend (not MARKET)
      forceMarket = false;
      console.log(`Order Type         : LIMIT (counter-trend strategy)`);
    } else {
      // Trend-following: Use current price directly, but still use LIMIT order for testing
      entryPrice = Number(currentPrice);
      forceMarket = false; // Changed: Use LIMIT instead of MARKET
      console.log(`Entry Price        : ${entryPrice.toFixed(8)} (using current price)`);
      console.log(`Order Type         : LIMIT (trend-following, but using LIMIT for testing)`);
    }

    // Calculate TP and SL
    console.log('\n=== TP/SL Calculation ===');
    console.log(`Entry Price        : ${entryPrice.toFixed(8)}`);
    console.log(`Take Profit        : ${takeProfit} (value in DB, actual % = ${takeProfit / 10}%)`);
    console.log(`Stop Loss          : ${stoploss || 'N/A'} (value in DB, actual % = ${stoploss ? stoploss / 10 + '%' : 'N/A'})`);
    console.log(`Side               : ${side.toUpperCase()}`);
    
    const tpPrice = calculateTakeProfit(entryPrice, takeProfit, side);
    const slPrice = stoploss && stoploss > 0 
      ? calculateInitialStopLoss(entryPrice, stoploss, side)
      : null;
    
    if (side === 'long') {
      const tpPercent = ((tpPrice - entryPrice) / entryPrice) * 100;
      console.log(`\n[TP Calculation - LONG]`);
      console.log(`TP Formula         : entry * (1 + takeProfit% / 100)`);
      console.log(`TP Calculation     : ${entryPrice.toFixed(8)} * (1 + ${takeProfit / 10}% / 100)`);
      console.log(`TP Price           : ${tpPrice.toFixed(8)}`);
      console.log(`TP Distance        : ${tpPrice.toFixed(8)} - ${entryPrice.toFixed(8)} = ${(tpPrice - entryPrice).toFixed(8)} (${tpPercent.toFixed(2)}%)`);
      
      if (slPrice) {
        const slPercent = ((entryPrice - slPrice) / entryPrice) * 100;
        console.log(`\n[SL Calculation - LONG]`);
        console.log(`SL Formula         : entry * (1 - stoploss% / 100)`);
        console.log(`SL Calculation     : ${entryPrice.toFixed(8)} * (1 - ${stoploss / 10}% / 100)`);
        console.log(`SL Price           : ${slPrice.toFixed(8)}`);
        console.log(`SL Distance        : ${entryPrice.toFixed(8)} - ${slPrice.toFixed(8)} = ${(entryPrice - slPrice).toFixed(8)} (${slPercent.toFixed(2)}%)`);
      }
    } else {
      const tpPercent = ((entryPrice - tpPrice) / entryPrice) * 100;
      console.log(`\n[TP Calculation - SHORT]`);
      console.log(`TP Formula         : entry * (1 - takeProfit% / 100)`);
      console.log(`TP Calculation     : ${entryPrice.toFixed(8)} * (1 - ${takeProfit / 10}% / 100)`);
      console.log(`TP Price           : ${tpPrice.toFixed(8)}`);
      console.log(`TP Distance        : ${entryPrice.toFixed(8)} - ${tpPrice.toFixed(8)} = ${(entryPrice - tpPrice).toFixed(8)} (${tpPercent.toFixed(2)}%)`);
      
      if (slPrice) {
        const slPercent = ((slPrice - entryPrice) / entryPrice) * 100;
        console.log(`\n[SL Calculation - SHORT]`);
        console.log(`SL Formula         : entry * (1 + stoploss% / 100)`);
        console.log(`SL Calculation     : ${entryPrice.toFixed(8)} * (1 + ${stoploss / 10}% / 100)`);
        console.log(`SL Price           : ${slPrice.toFixed(8)}`);
        console.log(`SL Distance        : ${slPrice.toFixed(8)} - ${entryPrice.toFixed(8)} = ${(slPrice - entryPrice).toFixed(8)} (${slPercent.toFixed(2)}%)`);
      }
    }
    
    console.log(`\n[Summary] TP=${tpPrice.toFixed(8)}, SL=${slPrice ? slPrice.toFixed(8) : 'N/A'}`);

    // Create strategy object (like StrategyService returns)
    const strategy = {
      id: tempStrategyId,
      bot_id: bot.id,
      symbol,
      interval,
      trade_type: tradeType,
      amount,
      oc,
      take_profit: takeProfit,
      reduce,
      up_reduce: upReduce,
      extend,
      stoploss,
      is_reverse_strategy: isReverseStrategy,
      bot
    };

    // Create match object (like RealtimeOCDetector returns)
    const match = {
      strategy,
      oc: ocValue,
      absOC: Math.abs(ocValue),
      direction,
      openPrice: baseOpen,
      currentPrice: Number(currentPrice),
      interval,
      timestamp: Date.now()
    };

    // Create signal object (like WebSocketOCConsumer.processMatch creates)
    const signal = {
      strategy: strategy,
      side,
      entryPrice: entryPrice,
      currentPrice: Number(currentPrice),
      oc: Math.abs(ocValue),
      interval,
      timestamp: match.timestamp,
      tpPrice: tpPrice,
      slPrice: slPrice,
      amount: amount,
      forceMarket: forceMarket
    };

    console.log(`\n[Signal Object]`);
    console.log(JSON.stringify(signal, null, 2));

    // 1) Snapshot BEFORE
    const beforePositions = await Position.findOpenBySymbol(symbol);
    console.log('\n[0] Open positions BEFORE:', beforePositions.filter(p => Number(p.bot_id) === bot.id).length);

    // 2) Place ENTRY via OrderService.executeSignal (same as WebSocketOCConsumer)
    console.log('\n[1] Placing ENTRY order via OrderService.executeSignal (same flow as WebSocketOCConsumer)...');
    
    const res = await orderSvc.executeSignal(signal);
    
    if (!res || !res.id) {
      // Get current position count for better error message
      const [result] = await pool.execute(
        'SELECT COUNT(*) as count FROM positions WHERE bot_id = ? AND status = ?',
        [bot.id, 'open']
      );
      const currentCount = result[0].count;
      const maxConcurrent = bot.max_concurrent_trades || 1000;
      
      throw new Error(
        `OrderService.executeSignal failed.\n` +
        `Result: ${JSON.stringify(res)}\n` +
        `Current positions: ${currentCount}/${maxConcurrent} open.\n` +
        `Possible reasons:\n` +
        `  1. Max concurrent trades limit reached\n` +
        `  2. Too many open positions (${currentCount}/${maxConcurrent})\n` +
        `  3. Position limit per coin exceeded\n` +
        `Solution: Close some positions or check position limits.`
      );
    }
    console.log(`[OK] Position opened: id=${res.id}, order_id=${res.order_id}, side=${res.side}, entry_price=${res.entry_price}`);

    // 3) Reload position from DB right after OrderService.executeSignal
    let pos = await Position.findById(res.id);
    console.log('\n[2] Position from DB right after OrderService.executeSignal:', {
      id: pos.id,
      bot_id: pos.bot_id,
      symbol: pos.symbol,
      side: pos.side,
      entry_price: pos.entry_price,
      take_profit_price: pos.take_profit_price,
      stop_loss_price: pos.stop_loss_price,
      exit_order_id: pos.exit_order_id,
      sl_order_id: pos.sl_order_id,
      tp_sl_pending: pos.tp_sl_pending || false,
      status: pos.status
    });

    console.log('\n[3] ⚠️  NOTE: TP/SL orders will be placed by PositionMonitor (running in background).');
    console.log('    PositionMonitor will automatically:');
    console.log('    1. Place TP/SL orders when position is confirmed (tp_sl_pending=true)');
    console.log('    2. Monitor position and update TP trailing based on minutes_elapsed');
    console.log('    3. Update PnL and handle order fills');
    console.log('\n    This script will only observe position state changes, not trigger them manually.');
    console.log('    Wait for PositionMonitor to run (usually every few seconds)...\n');

    // 4) Observe position state changes (let PositionMonitor do its job)
    console.log('[4] Observing position state (PositionMonitor will handle TP/SL placement and trailing)...');
    const maxObservations = 10;
    const observationInterval = 5000; // 5 seconds
    
    for (let i = 1; i <= maxObservations; i++) {
      console.log(`\n[Observation ${i}/${maxObservations}]`);
      
      const fresh = await Position.findById(res.id);
      if (!fresh || fresh.status !== 'open') {
        console.log(`[INFO] Position ${res.id} is no longer open (status=${fresh?.status}). Stopping observation.`);
        break;
      }
      
      // Get current market price
      const currentPrice = await exSvc.getTickerPrice(fresh.symbol);
      const openedAt = fresh.opened_at ? new Date(fresh.opened_at).getTime() : Date.now();
      const now = Date.now();
      const actualMinutesElapsed = Math.floor((now - openedAt) / (60 * 1000));
      const timeSinceOpen = Math.floor((now - openedAt) / 1000);
      
      console.log(`[Position State at ${new Date().toISOString()}]`);
      console.log(`  - ID: ${fresh.id}`);
      console.log(`  - Status: ${fresh.status}`);
      console.log(`  - Side: ${fresh.side.toUpperCase()}`);
      console.log(`  - Entry Price: ${fresh.entry_price}`);
      console.log(`  - Current Market Price: ${currentPrice}`);
      console.log(`  - Take Profit Price: ${fresh.take_profit_price || 'N/A'}`);
      console.log(`  - Stop Loss Price: ${fresh.stop_loss_price || 'N/A'}`);
      console.log(`  - Exit Order ID: ${fresh.exit_order_id || 'N/A'}`);
      console.log(`  - SL Order ID: ${fresh.sl_order_id || 'N/A'}`);
      console.log(`  - TP/SL Pending: ${fresh.tp_sl_pending ? 'YES (waiting for PositionMonitor)' : 'NO'}`);
      console.log(`  - Minutes Elapsed (DB): ${fresh.minutes_elapsed || 0}`);
      console.log(`  - Minutes Elapsed (Actual): ${actualMinutesElapsed}`);
      console.log(`  - Time Since Open: ${timeSinceOpen} seconds (${Math.floor(timeSinceOpen / 60)} minutes)`);
      console.log(`  - Reduce: ${fresh.reduce || 'N/A'}`);
      console.log(`  - Up Reduce: ${fresh.up_reduce || 'N/A'}`);
      console.log(`  - Initial TP Price: ${fresh.initial_tp_price || 'N/A'}`);
      console.log(`  - PnL: ${fresh.pnl || 'N/A'}`);
      
      // Store state for comparison in next iteration
      if (i === 1) {
        // Store initial state
        pos = fresh;
      } else {
        // Compare with previous state
        const prevPos = pos;
        const tpChanged = fresh.take_profit_price !== prevPos.take_profit_price;
        const slChanged = fresh.stop_loss_price !== prevPos.stop_loss_price;
        const exitOrderChanged = fresh.exit_order_id !== prevPos.exit_order_id;
        const slOrderChanged = fresh.sl_order_id !== prevPos.sl_order_id;
        const minutesChanged = fresh.minutes_elapsed !== prevPos.minutes_elapsed;
        const pendingChanged = fresh.tp_sl_pending !== prevPos.tp_sl_pending;
        
        if (tpChanged || slChanged || exitOrderChanged || slOrderChanged || minutesChanged || pendingChanged) {
          console.log(`\n[CHANGES DETECTED since last observation]`);
          if (tpChanged) console.log(`  ✅ TP Price: ${prevPos.take_profit_price || 'N/A'} → ${fresh.take_profit_price || 'N/A'}`);
          if (slChanged) console.log(`  ✅ SL Price: ${prevPos.stop_loss_price || 'N/A'} → ${fresh.stop_loss_price || 'N/A'}`);
          if (exitOrderChanged) console.log(`  ✅ Exit Order ID: ${prevPos.exit_order_id || 'N/A'} → ${fresh.exit_order_id || 'N/A'}`);
          if (slOrderChanged) console.log(`  ✅ SL Order ID: ${prevPos.sl_order_id || 'N/A'} → ${fresh.sl_order_id || 'N/A'}`);
          if (minutesChanged) console.log(`  ✅ Minutes Elapsed: ${prevPos.minutes_elapsed || 0} → ${fresh.minutes_elapsed || 0}`);
          if (pendingChanged) console.log(`  ✅ TP/SL Pending: ${prevPos.tp_sl_pending || false} → ${fresh.tp_sl_pending || false}`);
        } else {
          console.log(`\n[NO CHANGES] Position state unchanged since last observation.`);
        }
        
        // Update stored state
        pos = fresh;
      }
      
      // Wait before next observation
      if (i < maxObservations) {
        console.log(`\n[Waiting ${observationInterval / 1000} seconds before next observation...]`);
        await sleep(observationInterval);
      }
    }

    console.log('\n=== TP/SL Flow Test FINISHED ===');
  } finally {
    if (tempStrategyId) {
      // await deleteTempStrategy(tempStrategyId);
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


