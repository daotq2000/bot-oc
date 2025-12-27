#!/usr/bin/env node
/**
 * Debug root cause: Why bot 4,5,6,7 don't place orders for TRUUSDT
 */

import { Strategy } from '../src/models/Strategy.js';
import { Bot } from '../src/models/Bot.js';
import { strategyCache } from '../src/services/StrategyCache.js';
import { determineSide } from '../src/utils/sideSelector.js';

async function debugRootCause() {
  try {
    console.log('\n' + '='.repeat(80));
    console.log('🔍 ROOT CAUSE ANALYSIS: TRUUSDT Bot 4,5,6,7');
    console.log('='.repeat(80) + '\n');

    // User's data: pump 12.45% (0.01035086 → 0.01163979)
    const userOpen = 0.01035086;
    const userCurrent = 0.01163979;
    const userOC = ((userCurrent - userOpen) / userOpen) * 100;
    const userDirection = userCurrent >= userOpen ? 'bullish' : 'bearish';

    console.log('📊 User\'s Data:');
    console.log(`  Open: ${userOpen}`);
    console.log(`  Current: ${userCurrent}`);
    console.log(`  OC: ${userOC.toFixed(2)}%`);
    console.log(`  Direction: ${userDirection}`);
    console.log(`  Abs OC: ${Math.abs(userOC).toFixed(2)}%\n`);

    // Refresh cache
    await strategyCache.refresh(true);
    const cachedStrategies = strategyCache.getStrategies('binance', 'TRUUSDT', false);

    console.log('🔍 Analyzing strategies for bot 4,5,6,7:\n');

    const targetBots = [4, 5, 6, 7];
    for (const botId of targetBots) {
      const botStrategies = cachedStrategies.filter(s => s.bot_id === botId);
      console.log(`\n${'─'.repeat(80)}`);
      console.log(`Bot ID ${botId}: ${botStrategies.length} strategies`);
      console.log(`${'─'.repeat(80)}`);

      if (botStrategies.length === 0) {
        console.log(`  ❌ NO STRATEGIES FOUND in cache!`);
        continue;
      }

      // Check bot info
      try {
        const bot = await Bot.findById(botId);
        if (bot) {
          console.log(`\n  Bot Info:`);
          console.log(`    Name: ${bot.bot_name || 'N/A'}`);
          console.log(`    Exchange: ${bot.exchange || 'N/A'}`);
          console.log(`    Is Active: ${bot.is_active !== false && bot.is_active !== 0}`);
          console.log(`    Trade Type: ${bot.trade_type || 'N/A'}`);
          console.log(`    Is Reverse Strategy: ${bot.is_reverse_strategy || false}`);
        }
      } catch (e) {
        console.log(`  ⚠️  Could not load bot info: ${e?.message || e}`);
      }

      // Analyze each strategy
      for (const s of botStrategies) {
        const ocThreshold = Number(s.oc || 0);
        const interval = s.interval || '1m';
        const tradeType = s.trade_type || 'N/A';
        const isReverse = Boolean(s.is_reverse_strategy);

        console.log(`\n  Strategy ${s.id}:`);
        console.log(`    OC Threshold: ${ocThreshold}%`);
        console.log(`    Interval: ${interval}`);
        console.log(`    Trade Type: ${tradeType}`);
        console.log(`    Is Reverse: ${isReverse}`);
        console.log(`    Is Active: ${s.is_active === true || s.is_active === 1}`);

        // Check if OC threshold matches
        const wouldMatchOC = Math.abs(userOC) >= ocThreshold;
        console.log(`    Would match OC ${userOC.toFixed(2)}%: ${wouldMatchOC ? '✅ YES' : '❌ NO (threshold too high)'}`);

        // Check side mapping
        const side = determineSide(userDirection, tradeType, isReverse);
        console.log(`    Side mapping (${userDirection}, ${tradeType}, ${isReverse}): ${side || 'NULL (will be skipped)'}`);

        // Summary
        if (!wouldMatchOC) {
          console.log(`    ⚠️  ISSUE: OC threshold (${ocThreshold}%) > actual OC (${Math.abs(userOC).toFixed(2)}%)`);
        }
        if (!side) {
          console.log(`    ⚠️  ISSUE: Side mapping returned NULL - strategy will be skipped`);
        }
        if (wouldMatchOC && side) {
          console.log(`    ✅ Should work: OC matches AND side is valid`);
        }
      }
    }

    // Check what OC values were actually detected
    console.log(`\n\n${'='.repeat(80)}`);
    console.log('📊 OC Detection Analysis:');
    console.log(`${'='.repeat(80)}`);
    console.log('\n  NOTE: OC is calculated per INTERVAL (1m or 5m), not total pump.');
    console.log('  User reports 12.45% pump, but this might be across multiple intervals.');
    console.log('  Check logs for actual OC values detected per interval.\n');

    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error(`\n❌ Error: ${error?.message || error}`);
    console.error(error?.stack || '');
  }
}

debugRootCause().then(() => process.exit(0)).catch(console.error);



