#!/usr/bin/env node
/**
 * Debug script to analyze why SL is not moving
 * This script simulates the SL calculation logic without actually calling the exchange
 */

import dotenv from 'dotenv';
import pool from '../src/config/database.js';
import { Position } from '../src/models/Position.js';
import { PositionService } from '../src/services/PositionService.js';
import logger from '../src/utils/logger.js';

dotenv.config();

async function debugSLMovement() {
  try {
    // Find positions with SL around 88,948 or recent BTC positions
    const [positions] = await pool.execute(
      `SELECT p.*, s.reduce, s.up_reduce, s.stoploss, s.oc, s.take_profit
       FROM positions p
       JOIN strategies s ON p.strategy_id = s.id
       WHERE p.bot_id = 3 
         AND (
           (p.stop_loss_price BETWEEN 88900 AND 89000)
           OR (p.side = 'long' AND (p.symbol LIKE '%BTC%' OR p.symbol = 'BTCUSDT'))
         )
       ORDER BY p.opened_at DESC
       LIMIT 5`
    );
    
    console.log(`Found ${positions.length} BTC LONG positions\n`);

    if (positions.length === 0) {
      console.log('❌ No BTC LONG positions found for bot 3');
      return;
    }

    // Analyze all positions found
    for (let idx = 0; idx < positions.length; idx++) {
      const position = positions[idx];
      console.log(`\n${'='.repeat(60)}`);
      console.log(`POSITION ${idx + 1}/${positions.length}`);
      console.log(`${'='.repeat(60)}`);
    console.log('\n=== POSITION ANALYSIS ===');
    console.log(`Position ID: ${position.id}`);
    console.log(`Symbol: ${position.symbol}`);
    console.log(`Side: ${position.side}`);
    console.log(`Entry Price: ${position.entry_price}`);
    console.log(`Current SL: ${position.stop_loss_price || 'NULL'}`);
    console.log(`TP Price: ${position.take_profit_price}`);
    console.log(`Opened At: ${position.opened_at}`);
    console.log(`Minutes Elapsed (DB): ${position.minutes_elapsed || 0}`);
    console.log(`Reduce: ${position.reduce || 'NULL'}`);
    console.log(`Up Reduce: ${position.up_reduce || 'NULL'}`);
    console.log(`Stoploss: ${position.stoploss || 'NULL'}`);

    // Calculate actual minutes elapsed
    const openedAt = position.opened_at ? new Date(position.opened_at).getTime() : null;
    const now = Date.now();
    const actualMinutesElapsed = openedAt ? Math.floor((now - openedAt) / (60 * 1000)) : null;
    
    console.log('\n=== TIMING ANALYSIS ===');
    console.log(`Opened At (timestamp): ${openedAt || 'NULL'}`);
    console.log(`Current Time: ${now}`);
    console.log(`Time Difference: ${openedAt ? (now - openedAt) : 'N/A'}ms (${openedAt ? Math.floor((now - openedAt) / 1000) : 'N/A'}s)`);
    console.log(`Actual Minutes Elapsed: ${actualMinutesElapsed !== null ? actualMinutesElapsed : 'N/A'}`);
    console.log(`DB Minutes Elapsed: ${position.minutes_elapsed || 0}`);
    
    if (actualMinutesElapsed !== null) {
      console.log(`Minutes Difference: ${actualMinutesElapsed - (position.minutes_elapsed || 0)}`);
      if (actualMinutesElapsed <= (position.minutes_elapsed || 0)) {
        console.log(`⚠️  WARNING: Actual minutes (${actualMinutesElapsed}) <= DB minutes (${position.minutes_elapsed || 0}) - SL will NOT move!`);
      }
    } else {
      console.log(`⚠️  WARNING: opened_at is NULL - cannot calculate actual minutes!`);
    }

    // Test calculateUpdatedStopLoss
    console.log('\n=== SL CALCULATION TEST ===');
    const positionService = new PositionService(null);
    
    // Test with current position
    const currentSL = positionService.calculateUpdatedStopLoss(position);
    console.log(`Current SL calculation result: ${currentSL}`);
    
    // Test with incremented minutes
    if (actualMinutesElapsed !== null && actualMinutesElapsed > (position.minutes_elapsed || 0)) {
      const testPosition = {
        ...position,
        minutes_elapsed: actualMinutesElapsed
      };
      const newSL = positionService.calculateUpdatedStopLoss(testPosition);
      console.log(`New SL calculation (with minutes=${actualMinutesElapsed}): ${newSL}`);
      
      if (newSL && newSL !== currentSL) {
        const stepValue = Number(position.entry_price) * ((Number(position.up_reduce) / 10) / 100);
        console.log(`Expected step value: ${stepValue.toFixed(2)}`);
        console.log(`Actual change: ${Math.abs(newSL - (Number(position.stop_loss_price) || 0)).toFixed(2)}`);
      } else {
        console.log(`⚠️  WARNING: New SL (${newSL}) is same as current SL (${currentSL}) or NULL!`);
      }
    }

    // Check if up_reduce is valid
    console.log('\n=== PARAMETER VALIDATION ===');
    const upReduce = Number(position.up_reduce || 0);
    const reduce = Number(position.reduce || 0);
    const stoploss = Number(position.stoploss || 0);
    const entryPrice = Number(position.entry_price || 0);
    const prevSL = Number(position.stop_loss_price || 0);
    
    console.log(`Entry Price valid: ${Number.isFinite(entryPrice) && entryPrice > 0}`);
    console.log(`Up Reduce valid: ${Number.isFinite(upReduce) && upReduce > 0} (value: ${upReduce})`);
    console.log(`Reduce valid: ${Number.isFinite(reduce) && reduce > 0} (value: ${reduce})`);
    console.log(`Stoploss valid: ${Number.isFinite(stoploss) && stoploss > 0} (value: ${stoploss})`);
    console.log(`Previous SL valid: ${Number.isFinite(prevSL) && prevSL > 0} (value: ${prevSL})`);
    
    if (!Number.isFinite(upReduce) || upReduce <= 0) {
      console.log(`❌ PROBLEM: up_reduce is invalid (${upReduce}) - SL will NOT move for LONG position!`);
    }
    
    if (!Number.isFinite(prevSL) || prevSL <= 0) {
      console.log(`⚠️  WARNING: No previous SL (${prevSL}) - need initial SL from stoploss`);
      if (!Number.isFinite(stoploss) || stoploss <= 0) {
        console.log(`❌ PROBLEM: stoploss is invalid (${stoploss}) - cannot calculate initial SL!`);
      }
    }

    // Calculate expected step value
    if (Number.isFinite(upReduce) && upReduce > 0 && Number.isFinite(entryPrice) && entryPrice > 0) {
      const actualReducePercent = upReduce / 10; // 5 -> 0.5%
      const stepValue = entryPrice * (actualReducePercent / 100);
      console.log(`\n=== EXPECTED MOVEMENT ===`);
      console.log(`Up Reduce: ${upReduce} (${actualReducePercent}%)`);
      console.log(`Step Value: ${stepValue.toFixed(2)} USDT per minute`);
      console.log(`Current SL: ${prevSL || 'NULL'}`);
      if (prevSL > 0) {
        console.log(`Expected Next SL: ${(prevSL + stepValue).toFixed(2)}`);
      }
    }

    console.log('\n=== RECOMMENDATIONS ===');
    if (!openedAt) {
      console.log('1. ❌ opened_at is NULL - Position may not have opened_at timestamp set');
      console.log('   Fix: Ensure opened_at is set when creating position');
    }
    if (!Number.isFinite(upReduce) || upReduce <= 0) {
      console.log('2. ❌ up_reduce is invalid - SL cannot move for LONG position');
      console.log('   Fix: Set up_reduce > 0 in strategy');
    }
    if (!Number.isFinite(prevSL) || prevSL <= 0) {
      console.log('3. ⚠️  No previous SL - Need initial SL from stoploss');
      if (!Number.isFinite(stoploss) || stoploss <= 0) {
        console.log('   Fix: Set stoploss > 0 in strategy to create initial SL');
      }
    }
    if (actualMinutesElapsed !== null && actualMinutesElapsed <= (position.minutes_elapsed || 0)) {
      console.log('4. ⚠️  Actual minutes <= DB minutes - Not yet time for next step');
      console.log(`   Wait: ${60 - ((now - openedAt) % 60000) / 1000} seconds until next minute`);
    }
    } // End of position loop

  } catch (error) {
    console.error('Error:', error);
    console.error(error.stack);
  } finally {
    await pool.end();
  }
}

debugSLMovement();

