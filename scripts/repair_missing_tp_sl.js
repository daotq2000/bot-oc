#!/usr/bin/env node

/**
 * One-shot repair script to set tp_sl_pending for positions missing TP/SL
 * 
 * Usage: node scripts/repair_missing_tp_sl.js [--dry-run] [--bot-id=N] [--symbol=SYMBOL]
 * 
 * Options:
 *   --dry-run: Show what would be changed without actually changing anything
 *   --bot-id=N: Only process positions for specific bot ID
 *   --symbol=SYMBOL: Only process positions for specific symbol
 * 
 * This script safely identifies positions that:
 * 1. Are open in database
 * 2. Have an active strategy (ensures we only place TP/SL for managed positions)
 * 3. Are missing TP or SL orders in database
 * 4. Sets tp_sl_pending=true to trigger PositionMonitor to place TP/SL
 */

import { Position } from '../src/models/Position.js';
import { Strategy } from '../src/models/Strategy.js';
import logger from '../src/utils/logger.js';
import { configService } from '../src/services/ConfigService.js';

// Parse command line arguments
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const botIdArg = args.find(arg => arg.startsWith('--bot-id='));
const symbolArg = args.find(arg => arg.startsWith('--symbol='));

const botIdFilter = botIdArg ? parseInt(botIdArg.split('=')[1]) : null;
const symbolFilter = symbolArg ? symbolArg.split('=')[1] : null;

console.log('='.repeat(80));
console.log('🔧 TP/SL Repair Script');
console.log('='.repeat(80));
console.log(`Mode: ${isDryRun ? 'DRY RUN (no changes)' : 'LIVE MODE'}`);
if (botIdFilter) console.log(`Bot ID filter: ${botIdFilter}`);
if (symbolFilter) console.log(`Symbol filter: ${symbolFilter}`);
console.log('');

async function repairMissingTpSl() {
  try {
    // Build query conditions
    const whereConditions = { status: 'open' };
    if (botIdFilter) whereConditions.bot_id = botIdFilter;
    if (symbolFilter) whereConditions.symbol = symbolFilter;

    // Get all open positions
    const positions = await Position.findAll({
      where: whereConditions,
      attributes: ['id', 'bot_id', 'symbol', 'side', 'exit_order_id', 'sl_order_id', 'use_software_sl', 'tp_sl_pending', 'strategy_id']
    });

    console.log(`Found ${positions.length} open positions to check...`);
    console.log('');

    let needsRepair = 0;
    let alreadyPending = 0;
    let hasTpSl = 0;
    let noStrategy = 0;

    for (const position of positions) {
      // Check if position has an active strategy
      const strategy = await Strategy.findById(position.strategy_id);
      if (!strategy || !strategy.is_active) {
        console.log(`⚠️  Position ${position.id} (${position.symbol}) - No active strategy, skipping`);
        noStrategy++;
        continue;
      }

      // Check TP/SL status
      const hasTP = position.exit_order_id != null;
      const hasSL = position.sl_order_id != null || position.use_software_sl;
      const isPending = position.tp_sl_pending === true || position.tp_sl_pending === 1;

      if (!hasTP || !hasSL) {
        if (isPending) {
          console.log(`⏳ Position ${position.id} (${position.symbol}) - Missing TP/SL but already pending`);
          alreadyPending++;
        } else {
          console.log(`🔧 Position ${position.id} (${position.symbol}) - Missing TP/SL, needs repair`);
          console.log(`   Bot: ${position.bot_id}, Side: ${position.side}, Strategy: ${position.strategy_id}`);
          console.log(`   TP: ${hasTP ? '✅' : '❌'}, SL: ${hasSL ? '✅' : '❌'}`);
          
          if (!isDryRun) {
            await Position.update(position.id, { tp_sl_pending: true });
            console.log(`   ✅ Set tp_sl_pending=true`);
          } else {
            console.log(`   📋 Would set tp_sl_pending=true (dry run)`);
          }
          needsRepair++;
        }
      } else {
        console.log(`✅ Position ${position.id} (${position.symbol}) - Has TP/SL`);
        hasTpSl++;
      }
    }

    console.log('');
    console.log('='.repeat(80));
    console.log('📊 REPAIR SUMMARY');
    console.log('='.repeat(80));
    console.log(`Total positions checked: ${positions.length}`);
    console.log(`Positions needing repair: ${needsRepair}`);
    console.log(`Already pending: ${alreadyPending}`);
    console.log(`Already have TP/SL: ${hasTpSl}`);
    console.log(`No active strategy: ${noStrategy}`);
    
    if (isDryRun) {
      console.log('');
      console.log('🔍 DRY RUN MODE - No changes made');
      console.log('Run without --dry-run to apply changes');
    } else {
      console.log('');
      console.log(`✅ ${needsRepair} positions marked for TP/SL placement`);
      console.log('📢 PositionMonitor will process these in the next cycle (typically within 30-60 seconds)');
    }

    // Provide next steps
    if (needsRepair > 0 && !isDryRun) {
      console.log('');
      console.log('📋 NEXT STEPS:');
      console.log('1. Monitor logs for PositionMonitor activity:');
      console.log('   tail -f logs/combined.log | grep "Place TP/SL"');
      console.log('2. Check that TP/SL orders are placed on exchange');
      console.log('3. Verify tp_sl_pending flags are cleared after placement');
    }

    if (noStrategy > 0) {
      console.log('');
      console.log('⚠️  ORPHAN POSITIONS:');
      console.log(`${noStrategy} positions have no active strategy and cannot be managed automatically.`);
      console.log('To fix these, either:');
      console.log('- Create/activate a matching strategy for the symbol/bot');
      console.log('- Or manually close these positions on the exchange');
    }

  } catch (error) {
    console.error('❌ Error during repair:', error);
    process.exit(1);
  }
}

// Run the repair
repairMissingTpSl().then(() => {
  console.log('');
  console.log('✅ Repair script completed');
  process.exit(0);
}).catch(error => {
  console.error('❌ Repair script failed:', error);
  process.exit(1);
});
