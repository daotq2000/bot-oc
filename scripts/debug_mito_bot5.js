/**
 * Debug script to investigate why bot 5 strategy 16193 (MITOUSDT, SHORT, OC=9%) 
 * is not matching when token pumps 12.47% (bullish)
 */

import { RealtimeOCDetector } from '../src/services/RealtimeOCDetector.js';
import { StrategyCache } from '../src/services/StrategyCache.js';
import { determineSide } from '../src/utils/sideSelector.js';
import { Strategy } from '../src/models/Strategy.js';
import { Bot } from '../src/models/Bot.js';
import pool from '../src/config/database.js';

async function debugMitoBot5() {
  console.log('🔍 Debugging MITOUSDT bot 5 strategy 16193...\n');

  // 1. Check strategy in DB
  const strategy = await Strategy.findById(16193);

  if (!strategy) {
    console.log('❌ Strategy 16193 not found in DB');
    return;
  }

  if (strategy.bot_id !== 5 || strategy.symbol !== 'MITOUSDT') {
    console.log(`⚠️ Strategy 16193 belongs to bot_id=${strategy.bot_id}, symbol=${strategy.symbol}, not bot 5 MITOUSDT`);
  }

  console.log('✅ Strategy found in DB:');
  console.log(JSON.stringify(strategy, null, 2));
  console.log('');

  // 2. Check bot
  const bot = await Bot.findById(5);
  if (bot) {
    console.log('✅ Bot 5 info:');
    console.log(`  - is_reverse_strategy: ${bot.is_reverse_strategy}`);
    console.log(`  - api_key: ${bot.api_key ? 'SET' : 'NOT SET'}`);
    console.log('');
  }

  // 3. Check strategy cache
  const strategyCache = new StrategyCache();
  await strategyCache.refresh(true); // Force refresh
  
  const cachedStrategies = strategyCache.getStrategies('binance', 'MITOUSDT', false);
  const mitoStrategies = cachedStrategies?.filter(s => s.bot_id === 5) || [];
  
  console.log(`📦 Strategy Cache: Found ${mitoStrategies.length} MITOUSDT strategies for bot 5:`);
  mitoStrategies.forEach(s => {
    console.log(`  - Strategy ${s.id}: ${s.trade_type}, OC=${s.oc}%, interval=${s.interval}, is_reverse=${s.is_reverse_strategy}`);
  });
  console.log('');

  const strategy16193 = mitoStrategies.find(s => s.id === 16193);
  if (!strategy16193) {
    console.log('❌ Strategy 16193 NOT in cache! This is the problem.');
    console.log('   Strategy cache needs to be reloaded or strategy is inactive.');
    return;
  }

  console.log('✅ Strategy 16193 found in cache');
  console.log('');

  // 4. Simulate OC detection
  const detector = new RealtimeOCDetector();
  
  // User reported: 0.07811 → 0.08784772 (12.47% pump, bullish)
  const openPrice = 0.07811;
  const currentPrice = 0.08784772;
  const oc = ((currentPrice - openPrice) / openPrice) * 100;
  const absOC = Math.abs(oc);
  const direction = currentPrice >= openPrice ? 'bullish' : 'bearish';

  console.log('📊 Simulating OC calculation:');
  console.log(`  - Open price: ${openPrice}`);
  console.log(`  - Current price: ${currentPrice}`);
  console.log(`  - OC: ${oc.toFixed(2)}%`);
  console.log(`  - absOC: ${absOC.toFixed(2)}%`);
  console.log(`  - Direction: ${direction}`);
  console.log(`  - Strategy OC threshold: ${strategy16193.oc}%`);
  console.log(`  - Match condition: absOC (${absOC.toFixed(2)}%) >= threshold (${strategy16193.oc}%)`);
  
  if (absOC >= strategy16193.oc) {
    console.log('  ✅ OC threshold MATCHED');
  } else {
    console.log('  ❌ OC threshold NOT MATCHED');
    console.log(`     ${absOC.toFixed(2)}% < ${strategy16193.oc}%`);
  }
  console.log('');

  // 5. Check side mapping
  const side = determineSide(
    direction,
    strategy16193.trade_type,
    strategy16193.is_reverse_strategy
  );

  console.log('🔄 Side mapping:');
  console.log(`  - Direction: ${direction}`);
  console.log(`  - Trade type: ${strategy16193.trade_type}`);
  console.log(`  - Is reverse: ${strategy16193.is_reverse_strategy}`);
  console.log(`  - Result side: ${side || 'NULL (will skip)'}`);
  
  if (!side) {
    console.log('  ❌ Side mapping returned NULL - strategy will be SKIPPED');
    console.log('     This is why the order is not placed!');
  } else {
    console.log('  ✅ Side mapping OK');
  }
  console.log('');

  // 6. Check what OC is actually detected in real-time
  console.log('🔍 Checking real-time OC detection...');
  console.log('   (This requires actual WebSocket data - checking logs instead)');
  console.log('');

  // 7. Summary
  console.log('📋 SUMMARY:');
  console.log('─'.repeat(60));
  
  const issues = [];
  if (!strategy16193) {
    issues.push('❌ Strategy 16193 not in cache');
  }
  if (absOC < strategy16193.oc) {
    issues.push(`❌ OC threshold not met: ${absOC.toFixed(2)}% < ${strategy16193.oc}%`);
  }
  if (!side) {
    issues.push('❌ Side mapping returned NULL (strategy will be skipped)');
  }

  if (issues.length === 0) {
    console.log('✅ All checks passed - strategy should match');
    console.log('   If order is still not placed, check:');
    console.log('   - OrderService initialization for bot 5');
    console.log('   - Position limit checks');
    console.log('   - API key validity');
  } else {
    console.log('❌ Issues found:');
    issues.forEach(issue => console.log(`   ${issue}`));
  }

  await pool.end();
}

debugMitoBot5().catch(console.error);

