#!/usr/bin/env node
/**
 * Script: monitor_sl_movement.js
 * 
 * Mục đích: Monitor SL movement của một position trong thời gian dài để verify trailing logic
 * 
 * Usage:
 *   node scripts/monitor_sl_movement.js --position_id 1
 *   node scripts/monitor_sl_movement.js --position_id 1 --duration 180 (monitor 3 phút)
 */

import dotenv from 'dotenv';
import pool from '../src/config/database.js';
import logger from '../src/utils/logger.js';
import { PositionMonitor } from '../src/jobs/PositionMonitor.js';
import { Position } from '../src/models/Position.js';
import { ExchangeService } from '../src/services/ExchangeService.js';

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

async function monitorPosition() {
  const positionId = args.position_id ? Number(args.position_id) : null;
  const durationSeconds = args.duration ? Number(args.duration) : 180; // Default 3 phút
  const intervalSeconds = args.interval ? Number(args.interval) : 5; // Check mỗi 5 giây

  if (!positionId) {
    console.error('❌ Error: --position_id is required');
    console.log('\nUsage:');
    console.log('  node scripts/monitor_sl_movement.js --position_id 1');
    console.log('  node scripts/monitor_sl_movement.js --position_id 1 --duration 180');
    console.log('  node scripts/monitor_sl_movement.js --position_id 1 --duration 180 --interval 5');
    process.exit(1);
  }

  console.log('\n🔍 Starting SL Movement Monitor');
  console.log(`   Position ID: ${positionId}`);
  console.log(`   Duration: ${durationSeconds} seconds (${Math.floor(durationSeconds / 60)} minutes)`);
  console.log(`   Check Interval: ${intervalSeconds} seconds`);
  console.log('');

  try {
    // Initialize services
    const position = await Position.findById(positionId);
    if (!position) {
      console.error(`❌ Position ${positionId} not found`);
      process.exit(1);
    }

    if (position.status !== 'open') {
      console.error(`❌ Position ${positionId} is not open (status: ${position.status})`);
      process.exit(1);
    }

    const botId = position.bot_id;
    const exchangeService = new ExchangeService(botId);
    const posMonitor = new PositionMonitor(botId);

    console.log('📊 Initial Position State:');
    console.log(`   ID: ${position.id}`);
    console.log(`   Symbol: ${position.symbol}`);
    console.log(`   Side: ${position.side}`);
    console.log(`   Entry Price: ${position.entry_price}`);
    console.log(`   Take Profit Price: ${position.take_profit_price}`);
    console.log(`   Stop Loss Price: ${position.stop_loss_price}`);
    console.log(`   TP Order ID: ${position.tp_order_id || 'N/A'}`);
    console.log(`   SL Order ID: ${position.sl_order_id || 'N/A'}`);
    console.log(`   Minutes Elapsed: ${position.minutes_elapsed || 0}`);
    console.log(`   Reduce: ${position.reduce || 0}`);
    console.log(`   Up Reduce: ${position.up_reduce || 0}`);
    console.log(`   Opened At: ${position.opened_at}`);
    console.log('');

    const startTime = Date.now();
    const endTime = startTime + (durationSeconds * 1000);
    let iteration = 0;
    let prevSL = Number(position.stop_loss_price || 0);
    let prevMinutes = Number(position.minutes_elapsed || 0);
    let prevTP = Number(position.take_profit_price || 0);

    console.log('⏱️  Starting monitoring loop...\n');
    console.log('='.repeat(100));

    while (Date.now() < endTime) {
      iteration++;
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const remaining = durationSeconds - elapsed;

      // Reload position from DB
      const fresh = await Position.findById(positionId);
      if (!fresh || fresh.status !== 'open') {
        console.log(`\n⚠️  Position ${positionId} is no longer open (status: ${fresh?.status}). Stopping monitor.`);
        break;
      }

      // Get current market price
      let currentPrice;
      try {
        currentPrice = await exchangeService.getCurrentPrice(fresh.symbol);
      } catch (e) {
        logger.warn(`Failed to get current price: ${e?.message || e}`);
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
      console.log(`  TP Order ID: ${fresh.tp_order_id || 'N/A'}`);
      console.log(`  SL Order ID: ${fresh.sl_order_id || 'N/A'}`);

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
        await sleep(intervalSeconds * 1000);
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
    logger.error('Failed to monitor position:', error);
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

monitorPosition()
  .then(() => {
    console.log('\n✨ Done.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  });

