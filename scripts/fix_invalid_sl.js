#!/usr/bin/env node

/**
 * Fix Missing/Invalid SL for Open Positions
 * 
 * This script:
 * 1. Finds positions with missing or invalid SL
 * 2. Calculates correct SL based on strategy settings
 * 3. Updates the database
 */

import mysql from 'mysql2/promise';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: join(__dirname, '..', '.env') });

async function getDbConnection() {
  return mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'bot_oc',
    waitForConnections: true,
    connectionLimit: 10
  });
}

async function fixMissingSL() {
  const pool = await getDbConnection();
  const dryRun = !process.argv.includes('--execute');
  const defaultSLPercent = Number(process.argv.find(a => a.startsWith('--default-sl='))?.split('=')[1] || 10);
  
  try {
    console.log('='.repeat(100));
    console.log('🛠️  FIX MISSING/INVALID STOP LOSS SCRIPT');
    console.log('='.repeat(100));
    console.log(`Generated at: ${new Date().toISOString()}`);
    console.log(`Mode: ${dryRun ? '🔍 DRY RUN (use --execute to apply)' : '⚡ EXECUTE MODE'}`);
    console.log(`Default SL: ${defaultSLPercent}% (use --default-sl=15 to change)\n`);

    // Get positions with missing or invalid SL
    const [positionsToFix] = await pool.execute(`
      SELECT 
        p.id,
        p.symbol,
        p.side,
        p.entry_price,
        p.amount,
        p.pnl,
        p.stop_loss_price,
        p.use_software_sl,
        s.stoploss as strategy_sl,
        s.id as strategy_id
      FROM positions p
      LEFT JOIN strategies s ON p.strategy_id = s.id
      WHERE p.status = 'open' 
        AND (p.stop_loss_price IS NULL OR p.stop_loss_price = 0 OR p.stop_loss_price = '')
      ORDER BY COALESCE(p.pnl, 0) ASC
    `);

    if (positionsToFix.length === 0) {
      console.log('✅ All open positions have valid SL prices!');
      
      // Also check for positions with SL but not using software_sl
      const [notUsingSoftwareSL] = await pool.execute(`
        SELECT COUNT(*) as count FROM positions 
        WHERE status = 'open' 
          AND stop_loss_price > 0 
          AND (use_software_sl = 0 OR use_software_sl IS NULL)
          AND (sl_order_id IS NULL OR sl_order_id = '')
      `);
      
      if (notUsingSoftwareSL[0].count > 0) {
        console.log(`\n⚠️  Found ${notUsingSoftwareSL[0].count} positions with SL price but not using software SL.`);
        console.log('   These will be fixed to use software SL.\n');
        
        if (!dryRun) {
          await pool.execute(`
            UPDATE positions 
            SET use_software_sl = 1 
            WHERE status = 'open' 
              AND stop_loss_price > 0 
              AND (use_software_sl = 0 OR use_software_sl IS NULL)
              AND (sl_order_id IS NULL OR sl_order_id = '')
          `);
          console.log(`   ✅ Updated ${notUsingSoftwareSL[0].count} positions to use software SL.`);
        }
      }
      
      await pool.end();
      return;
    }

    console.log(`\n⚠️  Found ${positionsToFix.length} positions with missing/invalid SL:\n`);
    
    console.log('┌──────┬────────────────────┬──────┬────────────────┬────────────────┬────────────────┬──────────────┐');
    console.log('│ ID   │ Symbol             │ Side │ Entry Price    │ Current SL     │ New SL         │ SL %         │');
    console.log('├──────┼────────────────────┼──────┼────────────────┼────────────────┼────────────────┼──────────────┤');

    const fixes = [];
    
    for (const pos of positionsToFix) {
      // Determine SL percentage (from strategy or default)
      let slPercent = Number(pos.strategy_sl) || defaultSLPercent;
      
      // If strategy has SL = 100%, use default instead
      if (slPercent >= 100) {
        slPercent = defaultSLPercent;
      }
      
      // Calculate SL price
      const entryPrice = Number(pos.entry_price);
      let newSLPrice;
      
      if (pos.side === 'long') {
        newSLPrice = entryPrice * (1 - slPercent / 100);
      } else {
        newSLPrice = entryPrice * (1 + slPercent / 100);
      }
      
      fixes.push({
        id: pos.id,
        symbol: pos.symbol,
        side: pos.side,
        entryPrice,
        currentSL: Number(pos.stop_loss_price) || 0,
        newSL: newSLPrice,
        slPercent
      });
      
      console.log(
        `│ ${String(pos.id).padEnd(4)} │ ${String(pos.symbol).slice(0, 18).padEnd(18)} │ ` +
        `${String(pos.side).slice(0, 4).padEnd(4)} │ ${String(entryPrice.toFixed(6)).padStart(14)} │ ` +
        `${String(Number(pos.stop_loss_price || 0).toFixed(6)).padStart(14)} │ ` +
        `${String(newSLPrice.toFixed(6)).padStart(14)} │ ` +
        `${String(slPercent.toFixed(1) + '%').padStart(12)} │`
      );
    }
    console.log('└──────┴────────────────────┴──────┴────────────────┴────────────────┴────────────────┴──────────────┘');

    if (dryRun) {
      console.log('\n⚠️  DRY RUN MODE - No actual changes will be made.');
      console.log('   To execute, run: node scripts/fix_invalid_sl.js --execute');
      console.log(`   To change default SL, run: node scripts/fix_invalid_sl.js --execute --default-sl=15\n`);
      await pool.end();
      return;
    }

    // Execute mode - apply fixes
    console.log('\n⚡ EXECUTING - Applying fixes...\n');

    let fixedCount = 0;
    let failedCount = 0;

    for (const fix of fixes) {
      try {
        await pool.execute(`
          UPDATE positions 
          SET stop_loss_price = ?,
              use_software_sl = 1
          WHERE id = ?
        `, [fix.newSL, fix.id]);
        
        console.log(`   ✅ Position ${fix.id} (${fix.symbol}): SL set to ${fix.newSL.toFixed(6)} (${fix.slPercent}%)`);
        fixedCount++;
      } catch (e) {
        console.log(`   ❌ Position ${fix.id}: ${e.message}`);
        failedCount++;
      }
    }

    // Summary
    console.log('\n' + '━'.repeat(80));
    console.log('📊 EXECUTION SUMMARY');
    console.log('━'.repeat(80));
    console.log(`   ✅ Successfully fixed: ${fixedCount} positions`);
    console.log(`   ❌ Failed: ${failedCount} positions`);
    console.log('\n');

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await pool.end();
  }
}

// Run
fixMissingSL().catch(console.error);
