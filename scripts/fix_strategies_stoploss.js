#!/usr/bin/env node

/**
 * Script to fix strategies without stoploss configuration
 */

import mysql from 'mysql2/promise';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: join(__dirname, '..', '.env') });

async function fixStrategiesStoploss() {
  const pool = await getDbConnection();
  
  try {
    console.log('='.repeat(80));
    console.log('🔧 FIX STRATEGIES WITHOUT STOPLOSS');
    console.log('='.repeat(80));
    console.log(`Generated at: ${new Date().toISOString()}\n`);
    
    // 1. Find strategies without stoploss
    console.log('1️⃣  Finding strategies without stoploss...');
    const [strategiesNoSl] = await pool.execute(`
      SELECT 
        s.id,
        s.symbol,
        s.stoploss,
        s.take_profit,
        s.amount,
        COUNT(DISTINCT p.id) as open_positions
      FROM strategies s
      LEFT JOIN positions p ON s.id = p.strategy_id AND p.status = 'open'
      WHERE s.stoploss IS NULL OR s.stoploss = 0
      GROUP BY s.id, s.symbol, s.stoploss, s.take_profit, s.amount
      ORDER BY open_positions DESC
    `);
    
    console.log(`   Found ${strategiesNoSl.length} strategies without stoploss\n`);
    
    if (strategiesNoSl.length === 0) {
      console.log('✅ All strategies have stoploss configured!\n');
      return;
    }
    
    // 2. Calculate recommended stoploss
    console.log('2️⃣  Calculating recommended stoploss...');
    const defaultStoploss = 50; // 50 USDT default
    const strategiesToUpdate = [];
    
    strategiesNoSl.forEach(strategy => {
      const amount = Number(strategy.amount || 1000);
      // Calculate stoploss as 5% of position amount (or minimum 50 USDT)
      const recommendedStoploss = Math.max(defaultStoploss, amount * 0.05);
      
      strategiesToUpdate.push({
        id: strategy.id,
        symbol: strategy.symbol,
        currentStoploss: strategy.stoploss,
        recommendedStoploss: Math.round(recommendedStoploss),
        openPositions: strategy.open_positions
      });
    });
    
    console.log(`   Will update ${strategiesToUpdate.length} strategies\n`);
    
    // 3. Show preview
    console.log('3️⃣  Preview of changes:');
    console.log('   Top 20 strategies to update:');
    strategiesToUpdate.slice(0, 20).forEach((s, i) => {
      console.log(`   ${i + 1}. Strategy ${s.id} (${s.symbol}) | ` +
                 `Current: ${s.currentStoploss || 'NULL'} | ` +
                 `Recommended: ${s.recommendedStoploss} USDT | ` +
                 `Open Positions: ${s.openPositions}`);
    });
    console.log();
    
    // 4. Ask for confirmation (or use DRY_RUN mode)
    const dryRun = process.env.DRY_RUN !== 'false';
    
    if (dryRun) {
      console.log('⚠️  DRY RUN MODE - No changes will be made');
      console.log('   Set DRY_RUN=false to apply changes\n');
    } else {
      console.log('⚠️  WARNING: This will update strategies in database!');
      console.log('   Press Ctrl+C to cancel, or wait 5 seconds to continue...\n');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    // 5. Update strategies
    if (!dryRun) {
      console.log('4️⃣  Updating strategies...');
      let updated = 0;
      let errors = 0;
      
      for (const strategy of strategiesToUpdate) {
        try {
          await pool.execute(
            'UPDATE strategies SET stoploss = ? WHERE id = ?',
            [strategy.recommendedStoploss, strategy.id]
          );
          updated++;
          if (updated % 10 === 0) {
            console.log(`   Updated ${updated}/${strategiesToUpdate.length} strategies...`);
          }
        } catch (error) {
          console.error(`   ❌ Error updating strategy ${strategy.id}: ${error.message}`);
          errors++;
        }
      }
      
      console.log(`\n   ✅ Updated ${updated} strategies`);
      if (errors > 0) {
        console.log(`   ❌ ${errors} errors`);
      }
      console.log();
    } else {
      console.log('4️⃣  Skipping update (DRY RUN mode)');
      console.log(`   Would update ${strategiesToUpdate.length} strategies\n`);
    }
    
    // 6. Verify
    console.log('5️⃣  Verifying...');
    const [remaining] = await pool.execute(`
      SELECT COUNT(*) as count
      FROM strategies
      WHERE stoploss IS NULL OR stoploss = 0
    `);
    
    const remainingCount = remaining[0].count;
    if (remainingCount === 0) {
      console.log('   ✅ All strategies now have stoploss configured!\n');
    } else {
      console.log(`   ⚠️  ${remainingCount} strategies still without stoploss\n`);
    }
    
    // 7. Summary
    console.log('='.repeat(80));
    console.log('📊 SUMMARY');
    console.log('='.repeat(80));
    console.log(`Strategies without stoploss: ${strategiesNoSl.length}`);
    console.log(`Strategies to update: ${strategiesToUpdate.length}`);
    console.log(`Dry run mode: ${dryRun ? 'YES' : 'NO'}`);
    if (!dryRun) {
      console.log(`Updated: ${strategiesToUpdate.length - (remainingCount || 0)}`);
    }
    console.log();
    
    console.log('💡 Next Steps:');
    console.log('   1. PositionMonitor will automatically create SL for positions');
    console.log('   2. Monitor logs for SL placement');
    console.log('   3. Run analyze_positions.js again to verify');
    console.log();
    console.log('='.repeat(80));
    
  } finally {
    await pool.end();
  }
}

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

fixStrategiesStoploss().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});

