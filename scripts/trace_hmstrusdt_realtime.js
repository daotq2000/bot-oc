#!/usr/bin/env node
/**
 * Real-time trace script for HMSTRUSDT position 41
 * Monitors logs and DB changes for exit order creation/cancellation
 */

import { Position } from '../src/models/Position.js';
import logger from '../src/utils/logger.js';
import { createReadStream } from 'fs';
import { readFile, watchFile } from 'fs/promises';
import { join } from 'path';

const POSITION_ID = 41;
const SYMBOL = 'HMSTRUSDT';
const LOG_DIR = join(process.cwd(), 'logs');

let lastExitOrderId = null;
let lastTPPrice = null;
let checkCount = 0;

async function checkPosition() {
  try {
    const pos = await Position.findById(POSITION_ID);
    if (!pos) {
      console.log(`❌ Position ${POSITION_ID} not found`);
      return;
    }

    const timestamp = new Date().toISOString();
    const exitOrderId = pos.exit_order_id || null;
    const tpPrice = pos.take_profit_price || null;
    
    checkCount++;
    
    // Detect changes
    if (exitOrderId !== lastExitOrderId) {
      if (lastExitOrderId === null && exitOrderId !== null) {
        console.log(`\n🆕 [${timestamp}] EXIT ORDER CREATED!`);
        console.log(`   Position ID: ${POSITION_ID}`);
        console.log(`   Exit Order ID: ${exitOrderId}`);
        console.log(`   Take Profit Price: ${tpPrice}`);
      } else if (lastExitOrderId !== null && exitOrderId === null) {
        console.log(`\n🗑️  [${timestamp}] EXIT ORDER REMOVED FROM DB!`);
        console.log(`   Position ID: ${POSITION_ID}`);
        console.log(`   Previous Exit Order ID: ${lastExitOrderId}`);
        console.log(`   Current Exit Order ID: NULL`);
        console.log(`   ⚠️  WARNING: Order may have been cancelled!`);
      } else if (lastExitOrderId !== null && exitOrderId !== null && lastExitOrderId !== exitOrderId) {
        console.log(`\n🔄 [${timestamp}] EXIT ORDER REPLACED!`);
        console.log(`   Position ID: ${POSITION_ID}`);
        console.log(`   Old Exit Order ID: ${lastExitOrderId}`);
        console.log(`   New Exit Order ID: ${exitOrderId}`);
        console.log(`   Take Profit Price: ${tpPrice}`);
      }
      lastExitOrderId = exitOrderId;
    }
    
    if (tpPrice !== lastTPPrice && lastTPPrice !== null) {
      console.log(`\n📊 [${timestamp}] TP PRICE CHANGED!`);
      console.log(`   Position ID: ${POSITION_ID}`);
      console.log(`   Previous TP: ${lastTPPrice}`);
      console.log(`   New TP: ${tpPrice}`);
      console.log(`   Change: ${((tpPrice - lastTPPrice) / lastTPPrice * 100).toFixed(3)}%`);
      lastTPPrice = tpPrice;
    } else if (lastTPPrice === null) {
      lastTPPrice = tpPrice;
    }
    
    // Status update every 10 checks
    if (checkCount % 10 === 0) {
      console.log(`\n📌 [${timestamp}] Status Check #${checkCount}`);
      console.log(`   Position ID: ${POSITION_ID}`);
      console.log(`   Symbol: ${pos.symbol}`);
      console.log(`   Status: ${pos.status}`);
      console.log(`   Exit Order ID: ${exitOrderId || 'NULL'}`);
      console.log(`   Take Profit Price: ${tpPrice}`);
      console.log(`   Minutes Elapsed: ${pos.minutes_elapsed || 0}`);
      console.log(`   Is Processing: ${pos.is_processing || false}`);
    }
    
  } catch (error) {
    console.error(`\n❌ Error checking position: ${error?.message || error}`);
  }
}

async function tailLogFile(filePath) {
  try {
    const stats = await readFile(filePath, 'utf-8').catch(() => null);
    if (!stats) return;
    
    const lines = stats.split('\n').filter(l => l.includes('HMSTRUSDT') || l.includes(`pos=${POSITION_ID}`) || l.includes(`position ${POSITION_ID}`));
    if (lines.length > 0) {
      console.log(`\n📝 Recent logs from ${filePath}:`);
      lines.slice(-10).forEach(line => {
        console.log(`   ${line.substring(0, 200)}`);
      });
    }
  } catch (e) {
    // Ignore
  }
}

async function main() {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🔍 REAL-TIME TRACE: HMSTRUSDT Position ${POSITION_ID}`);
  console.log(`   Monitoring DB changes and logs...`);
  console.log(`   Press Ctrl+C to stop`);
  console.log(`${'='.repeat(80)}\n`);
  
  // Initial check
  await checkPosition();
  
  // Check logs
  await tailLogFile(join(LOG_DIR, 'combined.log'));
  await tailLogFile(join(LOG_DIR, 'error.log'));
  
  // Poll DB every 2 seconds
  setInterval(async () => {
    await checkPosition();
  }, 2000);
  
  // Watch log files (if they exist)
  const logFiles = ['combined.log', 'error.log'];
  logFiles.forEach(file => {
    const filePath = join(LOG_DIR, file);
    watchFile(filePath, { interval: 1000 }, async () => {
      await tailLogFile(filePath);
    }).catch(() => {
      // File doesn't exist or can't be watched
    });
  });
}

main().catch(console.error);

