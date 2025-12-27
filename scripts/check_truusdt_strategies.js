#!/usr/bin/env node
/**
 * Check TRUUSDT strategies and why bot 4,5,6,7 are not placing orders
 */

import { Strategy } from '../src/models/Strategy.js';
import { Bot } from '../src/models/Bot.js';
import { Position } from '../src/models/Position.js';
import { strategyCache } from '../src/services/StrategyCache.js';

async function checkStrategies() {
  try {
    console.log('\n' + '='.repeat(80));
    console.log('🔍 CHECKING TRUUSDT STRATEGIES');
    console.log('='.repeat(80) + '\n');

    // 1. Check all TRUUSDT strategies from DB
    const allStrategies = await Strategy.findAll({ symbol: 'TRUUSDT' }, false);
    console.log(`📊 Found ${allStrategies.length} total TRUUSDT strategies in DB\n`);

    // Group by bot_id
    const byBotId = {};
    for (const s of allStrategies) {
      const botId = s.bot_id || 'N/A';
      if (!byBotId[botId]) byBotId[botId] = [];
      byBotId[botId].push(s);
    }

    console.log('📋 Strategies by bot_id:');
    for (const [botId, strategies] of Object.entries(byBotId).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      console.log(`\n  Bot ID ${botId}: ${strategies.length} strategies`);
      for (const s of strategies.slice(0, 3)) {
        console.log(`    - Strategy ${s.id}: OC=${s.oc}% interval=${s.interval} is_active=${s.is_active} bot_id=${s.bot_id}`);
      }
      if (strategies.length > 3) {
        console.log(`    ... and ${strategies.length - 3} more`);
      }
    }

    // 2. Check bot info
    console.log('\n\n🤖 Bot Information:');
    const botIds = Object.keys(byBotId).filter(id => id !== 'N/A').map(Number);
    for (const botId of botIds) {
      try {
        const bot = await Bot.findById(botId);
        if (bot) {
          console.log(`\n  Bot ID ${botId}:`);
          console.log(`    Name: ${bot.bot_name || 'N/A'}`);
          console.log(`    Exchange: ${bot.exchange || 'N/A'}`);
          console.log(`    Is Active: ${bot.is_active !== false && bot.is_active !== 0}`);
          console.log(`    API Key Set: ${bot.api_key ? 'YES' : 'NO'}`);
        } else {
          console.log(`\n  Bot ID ${botId}: NOT FOUND`);
        }
      } catch (e) {
        console.log(`\n  Bot ID ${botId}: ERROR - ${e?.message || e}`);
      }
    }

    // 3. Check active strategies
    console.log('\n\n✅ Active Strategies (is_active=true):');
    const activeStrategies = allStrategies.filter(s => s.is_active === true || s.is_active === 1);
    console.log(`  Total: ${activeStrategies.length}`);
    const activeByBot = {};
    for (const s of activeStrategies) {
      const botId = s.bot_id || 'N/A';
      if (!activeByBot[botId]) activeByBot[botId] = [];
      activeByBot[botId].push(s);
    }
    for (const [botId, strategies] of Object.entries(activeByBot).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      console.log(`  Bot ID ${botId}: ${strategies.length} active strategies`);
    }

    // 4. Check open positions
    console.log('\n\n📊 Open Positions for TRUUSDT:');
    const openPositions = await Position.findAll({ symbol: 'TRUUSDT', status: 'open' });
    console.log(`  Total: ${openPositions.length}`);
    const positionsByBot = {};
    for (const p of openPositions) {
      const botId = p.bot_id || 'N/A';
      if (!positionsByBot[botId]) positionsByBot[botId] = [];
      positionsByBot[botId].push(p);
    }
    for (const [botId, positions] of Object.entries(positionsByBot).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      console.log(`  Bot ID ${botId}: ${positions.length} open positions`);
      for (const p of positions) {
        console.log(`    - Position ${p.id}: strategy_id=${p.strategy_id} side=${p.side} entry=${p.entry_price}`);
      }
    }

    // 5. Check strategy cache
    console.log('\n\n💾 Strategy Cache:');
    await strategyCache.refresh(true);
    const cachedStrategies = strategyCache.getStrategies('binance', 'TRUUSDT', false);
    console.log(`  Cached strategies for binance|TRUUSDT: ${cachedStrategies.length}`);
    
    const cachedByBot = {};
    for (const s of cachedStrategies) {
      const botId = s.bot_id || 'N/A';
      if (!cachedByBot[botId]) cachedByBot[botId] = [];
      cachedByBot[botId].push(s);
    }
    for (const [botId, strategies] of Object.entries(cachedByBot).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      console.log(`  Bot ID ${botId}: ${strategies.length} cached strategies`);
      for (const s of strategies.slice(0, 2)) {
        console.log(`    - Strategy ${s.id}: OC=${s.oc}% interval=${s.interval} is_active=${s.is_active}`);
        console.log(`      Bot active: ${s.bot?.is_active !== false}`);
      }
    }

    // 6. Check which bots have OrderService
    console.log('\n\n⚠️  NOTE: Check logs for "No OrderService found" errors');
    console.log('   This indicates bot is not initialized in WebSocketOCConsumer');

    // 7. Check strategies that should match OC=12.45%
    console.log('\n\n🎯 Strategies that SHOULD match OC=12.45%:');
    const targetOC = 12.45;
    const shouldMatch = allStrategies.filter(s => {
      const ocThreshold = Number(s.oc || 0);
      return ocThreshold > 0 && ocThreshold <= targetOC && (s.is_active === true || s.is_active === 1);
    });
    console.log(`  Found ${shouldMatch.length} strategies with OC threshold <= ${targetOC}%`);
    const shouldMatchByBot = {};
    for (const s of shouldMatch) {
      const botId = s.bot_id || 'N/A';
      if (!shouldMatchByBot[botId]) shouldMatchByBot[botId] = [];
      shouldMatchByBot[botId].push(s);
    }
    for (const [botId, strategies] of Object.entries(shouldMatchByBot).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      console.log(`  Bot ID ${botId}: ${strategies.length} strategies`);
      for (const s of strategies) {
        console.log(`    - Strategy ${s.id}: OC=${s.oc}% interval=${s.interval} is_active=${s.is_active}`);
      }
    }

    // 8. Check recent OC values from logs
    console.log('\n\n📊 Recent OC values for TRUUSDT (from logs):');
    console.log('   (Check logs/combined.log for actual OC values)');

    console.log('\n' + '='.repeat(80) + '\n');

  } catch (error) {
    console.error(`\n❌ Error: ${error?.message || error}`);
    console.error(error?.stack || '');
  }
}

checkStrategies().then(() => process.exit(0)).catch(console.error);

