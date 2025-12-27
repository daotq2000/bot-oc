#!/usr/bin/env node
/**
 * Debug script to check why trailing TP is not moving
 * 
 * Usage:
 *   node scripts/debug_trailing_tp.js --position_id 2
 */

import dotenv from 'dotenv';
import pool from '../src/config/database.js';
import { Position } from '../src/models/Position.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import { PositionService } from '../src/services/PositionService.js';
import { calculateNextTrailingTakeProfit } from '../src/utils/calculator.js';
import { configService } from '../src/services/ConfigService.js';
import logger from '../src/utils/logger.js';

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
const positionId = Number(args.position_id);

if (!positionId || !Number.isFinite(positionId)) {
  console.error('Usage: node scripts/debug_trailing_tp.js --position_id 2');
  process.exit(1);
}

async function main() {
  try {
    // Fetch position
    const position = await Position.findById(positionId);
    if (!position) {
      console.error(`Position ${positionId} not found`);
      process.exit(1);
    }

    console.log('\n=== Position Details ===');
    console.log(`ID: ${position.id}`);
    console.log(`Symbol: ${position.symbol}`);
    console.log(`Side: ${position.side}`);
    console.log(`Status: ${position.status}`);
    console.log(`Entry Price: ${position.entry_price}`);
    console.log(`Current TP Price: ${position.take_profit_price || 'N/A'}`);
    console.log(`Initial TP Price: ${position.initial_tp_price || 'N/A'}`);
    console.log(`Minutes Elapsed: ${position.minutes_elapsed || 0}`);
    console.log(`Reduce: ${position.reduce || 'N/A'}`);
    console.log(`Up Reduce: ${position.up_reduce || 'N/A'}`);
    console.log(`Opened At: ${position.opened_at}`);
    console.log(`Exit Order ID: ${position.exit_order_id || 'N/A'}`);

    if (position.status !== 'open') {
      console.log(`\n⚠️  Position is not open (status=${position.status}), cannot trail TP`);
      process.exit(0);
    }

    // Calculate actual minutes elapsed
    const openedAt = new Date(position.opened_at).getTime();
    const now = Date.now();
    const totalMinutesElapsed = Math.floor((now - openedAt) / (60 * 1000));
    const prevMinutes = Number(position.minutes_elapsed || 0);
    const minutesToProcess = totalMinutesElapsed > prevMinutes ? Math.min(totalMinutesElapsed - prevMinutes, 1) : 0;

    console.log('\n=== Time Calculation ===');
    console.log(`Opened At (timestamp): ${openedAt}`);
    console.log(`Now (timestamp): ${now}`);
    console.log(`Time Diff: ${now - openedAt}ms (${Math.floor((now - openedAt) / 1000)}s)`);
    console.log(`Total Minutes Elapsed: ${totalMinutesElapsed}`);
    console.log(`Previous Minutes (DB): ${prevMinutes}`);
    console.log(`Minutes To Process: ${minutesToProcess}`);
    console.log(`Should Trail: ${minutesToProcess > 0 ? 'YES' : 'NO'}`);

    if (minutesToProcess <= 0) {
      console.log(`\n⚠️  No minutes to process (minutesToProcess=${minutesToProcess}). TP will not trail.`);
      console.log(`   This means: totalMinutesElapsed (${totalMinutesElapsed}) <= prevMinutes (${prevMinutes})`);
      process.exit(0);
    }

    // Get current market price
    const { Bot } = await import('../src/models/Bot.js');
    const bot = await Bot.findById(position.bot_id);
    if (!bot) {
      console.error(`Bot ${position.bot_id} not found`);
      process.exit(1);
    }

    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();
    const currentPrice = await exchangeService.getTickerPrice(position.symbol);

    console.log('\n=== Market Data ===');
    console.log(`Current Market Price: ${currentPrice}`);

    // Calculate trailing TP
    const prevTP = Number(position.take_profit_price || 0);
    const entryPrice = Number(position.entry_price || 0);
    const initialTP = Number(position.initial_tp_price || prevTP);
    const reduce = Number(position.reduce || 0);
    const upReduce = Number(position.up_reduce || 0);
    const trailingPercent = position.side === 'long' ? upReduce : reduce;

    console.log('\n=== TP Trailing Calculation ===');
    console.log(`Previous TP: ${prevTP}`);
    console.log(`Entry Price: ${entryPrice}`);
    console.log(`Initial TP: ${initialTP}`);
    console.log(`Reduce: ${reduce}`);
    console.log(`Up Reduce: ${upReduce}`);
    console.log(`Trailing Percent (for ${position.side}): ${trailingPercent}%`);
    console.log(`Minutes To Process: ${minutesToProcess}`);

    if (reduce <= 0 && upReduce <= 0) {
      console.log(`\n⚠️  Static mode: reduce=${reduce} upReduce=${upReduce}, TP will not trail`);
      process.exit(0);
    }

    // Calculate new TP
    const newTP = calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, trailingPercent, position.side, minutesToProcess);
    const movedTP = Math.abs(newTP - prevTP);
    const totalRange = Math.abs(initialTP - entryPrice);
    const stepPerMinute = totalRange * (trailingPercent / 100);
    const step = stepPerMinute * minutesToProcess;

    console.log('\n=== Trailing Calculation Result ===');
    console.log(`Total Range: ${totalRange.toFixed(8)} (initialTP - entry)`);
    console.log(`Step Per Minute: ${stepPerMinute.toFixed(8)} (${trailingPercent}% of range)`);
    console.log(`Step (for ${minutesToProcess} minute(s)): ${step.toFixed(8)}`);
    console.log(`New TP: ${newTP.toFixed(8)}`);
    console.log(`Movement: ${movedTP.toFixed(8)}`);
    console.log(`Movement %: ${((movedTP / prevTP) * 100).toFixed(6)}%`);

    if (Math.abs(newTP - prevTP) < 0.00000001) {
      console.log(`\n⚠️  WARNING: New TP equals previous TP! No movement.`);
      console.log(`   This could be because:`);
      console.log(`   1. TP has reached entry price (clamped)`);
      console.log(`   2. Movement is too small (< tick size)`);
      console.log(`   3. Calculation error`);
    }

    // Check thresholds for order replacement
    const thresholdTicksTP = Number(configService.getNumber('TP_UPDATE_THRESHOLD_TICKS', configService.getNumber('SL_UPDATE_THRESHOLD_TICKS', 2)));
    const tickSizeStr = await exchangeService.getTickSize(position.symbol);
    const tickSize = parseFloat(tickSizeStr || '0') || 0;
    const effectiveThreshold = thresholdTicksTP * tickSize;
    const minPriceChangePercent = Number(configService.getNumber('EXIT_ORDER_MIN_PRICE_CHANGE_PCT', 0.1));
    const avgPrice = (newTP + prevTP) / 2;
    const minPriceChange = avgPrice * (minPriceChangePercent / 100);
    const priceChangePercent = (movedTP / avgPrice) * 100;

    console.log('\n=== Order Replacement Thresholds ===');
    console.log(`Tick Size: ${tickSize}`);
    console.log(`Threshold Ticks: ${thresholdTicksTP}`);
    console.log(`Effective Threshold: ${effectiveThreshold.toFixed(8)} (${thresholdTicksTP} * ${tickSize})`);
    console.log(`Min Price Change %: ${minPriceChangePercent}%`);
    console.log(`Min Price Change: ${minPriceChange.toFixed(8)} (${minPriceChangePercent}% of ${avgPrice.toFixed(8)})`);
    console.log(`Actual Movement: ${movedTP.toFixed(8)}`);
    console.log(`Price Change %: ${priceChangePercent.toFixed(6)}%`);

    const tickThresholdMet = movedTP >= effectiveThreshold;
    const priceChangeThresholdMet = movedTP >= minPriceChange;

    console.log('\n=== Threshold Check Results ===');
    console.log(`Tick Threshold Met: ${tickThresholdMet} (${movedTP.toFixed(8)} >= ${effectiveThreshold.toFixed(8)})`);
    console.log(`Price Change Threshold Met: ${priceChangeThresholdMet} (${movedTP.toFixed(8)} >= ${minPriceChange.toFixed(8)})`);
    console.log(`Will Replace Order: ${tickThresholdMet && priceChangeThresholdMet ? 'YES ✅' : 'NO ❌'}`);

    if (!tickThresholdMet || !priceChangeThresholdMet) {
      console.log(`\n⚠️  TP order will NOT be replaced because:`);
      if (!tickThresholdMet) {
        console.log(`   - Movement (${movedTP.toFixed(8)}) < tick threshold (${effectiveThreshold.toFixed(8)})`);
      }
      if (!priceChangeThresholdMet) {
        console.log(`   - Movement (${movedTP.toFixed(8)}) < min price change (${minPriceChange.toFixed(8)})`);
        console.log(`   - Movement is only ${priceChangePercent.toFixed(6)}%, need ${minPriceChangePercent}%`);
      }
      console.log(`\n   However, take_profit_price in DB will still be updated to ${newTP.toFixed(8)}`);
      console.log(`   This causes discrepancy: DB has new TP, but exchange order has old TP`);
    }

    // Check if TP has crossed entry
    const hasCrossedEntry = (position.side === 'long' && newTP <= entryPrice) || 
                           (position.side === 'short' && newTP >= entryPrice);

    console.log('\n=== Entry Cross Check ===');
    console.log(`Has Crossed Entry: ${hasCrossedEntry ? 'YES' : 'NO'}`);
    if (hasCrossedEntry) {
      console.log(`   TP is now in ${position.side === 'long' ? 'loss' : 'loss'} zone`);
      console.log(`   Will use STOP_MARKET order type`);
    } else {
      console.log(`   TP is still in profit zone`);
      console.log(`   Will use TAKE_PROFIT_MARKET order type`);
    }

    // Check current order on exchange
    if (position.exit_order_id) {
      console.log('\n=== Current Order on Exchange ===');
      try {
        const orderStatus = await exchangeService.getOrderStatus(position.symbol, position.exit_order_id);
        console.log(`Order ID: ${position.exit_order_id}`);
        console.log(`Order Type: ${orderStatus.type || 'N/A'}`);
        console.log(`Order Status: ${orderStatus.status || 'N/A'}`);
        console.log(`Stop Price: ${orderStatus.stopPrice || orderStatus.price || 'N/A'}`);
        console.log(`DB TP Price: ${position.take_profit_price || 'N/A'}`);
        
        const dbTP = Number(position.take_profit_price || 0);
        const orderTP = Number(orderStatus.stopPrice || orderStatus.price || 0);
        if (dbTP > 0 && orderTP > 0) {
          const diff = Math.abs(dbTP - orderTP);
          const diffPercent = (diff / dbTP) * 100;
          console.log(`\nPrice Mismatch Check:`);
          console.log(`   DB TP: ${dbTP.toFixed(8)}`);
          console.log(`   Order TP: ${orderTP.toFixed(8)}`);
          console.log(`   Difference: ${diff.toFixed(8)} (${diffPercent.toFixed(6)}%)`);
          if (diff > 0.0001) {
            console.log(`   ⚠️  MISMATCH: DB and exchange order have different TP prices!`);
          } else {
            console.log(`   ✅ Match: DB and exchange order have same TP price`);
          }
        }
      } catch (e) {
        console.log(`   ⚠️  Could not fetch order status: ${e?.message || e}`);
      }
    } else {
      console.log('\n=== Current Order on Exchange ===');
      console.log(`   ⚠️  No exit_order_id in DB - order may not exist on exchange`);
    }

    console.log('\n=== Summary ===');
    console.log(`Position ${position.id} (${position.symbol} ${position.side}):`);
    console.log(`  - Minutes Elapsed: ${position.minutes_elapsed || 0} (DB) vs ${totalMinutesElapsed} (actual)`);
    console.log(`  - Minutes To Process: ${minutesToProcess}`);
    console.log(`  - Current TP: ${prevTP.toFixed(8)}`);
    console.log(`  - Calculated New TP: ${newTP.toFixed(8)}`);
    console.log(`  - Movement: ${movedTP.toFixed(8)} (${priceChangePercent.toFixed(6)}%)`);
    console.log(`  - Will Replace Order: ${tickThresholdMet && priceChangeThresholdMet ? 'YES' : 'NO'}`);
    if (!tickThresholdMet || !priceChangeThresholdMet) {
      console.log(`  - ⚠️  TP order will NOT be replaced (threshold not met)`);
      console.log(`  - ⚠️  But DB will update take_profit_price to ${newTP.toFixed(8)}`);
      console.log(`  - ⚠️  This causes discrepancy between DB and exchange`);
    }

  } catch (error) {
    console.error('Error:', error?.message || error);
    console.error(error?.stack || '');
  } finally {
    await pool.end();
  }
}

main();

