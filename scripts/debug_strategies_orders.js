import { Strategy } from '../src/models/Strategy.js';
import { Bot } from '../src/models/Bot.js';
import { configService } from '../src/services/ConfigService.js';
import logger from '../src/utils/logger.js';

async function debugStrategiesOrders() {
  try {
    await configService.loadAll();

    console.log('\n=== Strategies & Orders Debug ===\n');

    // 1. Get all active strategies with oc=3
    const strategies = await Strategy.findAll(null, true);
    const strategiesWithOC3 = strategies.filter(s => Number(s.oc) === 3);
    
    console.log(`Total active strategies: ${strategies.length}`);
    console.log(`Strategies with OC=3: ${strategiesWithOC3.length}\n`);

    // 2. Group by bot_id
    const byBotId = new Map();
    for (const s of strategiesWithOC3) {
      const botId = s.bot_id;
      if (!byBotId.has(botId)) {
        byBotId.set(botId, []);
      }
      byBotId.get(botId).push(s);
    }

    console.log(`Strategies with OC=3 grouped by bot_id:`);
    for (const [botId, strats] of byBotId.entries()) {
      console.log(`\nBot ${botId}: ${strats.length} strategies`);
      const sample = strats.slice(0, 5);
      sample.forEach(s => {
        console.log(`  - Strategy ${s.id}: ${s.symbol} ${s.interval} (exchange: ${s.exchange || 'unknown'})`);
      });
      if (strats.length > 5) {
        console.log(`  ... and ${strats.length - 5} more`);
      }
    }

    // 3. Check active bots
    const bots = await Bot.findAll(true);
    console.log(`\nActive bots: ${bots.length}`);
    bots.forEach(bot => {
      console.log(`  - Bot ${bot.id}: ${bot.exchange} (name: ${bot.name || 'N/A'})`);
    });

    // 4. Check which bot_ids have strategies but no active bot
    const activeBotIds = new Set(bots.map(b => b.id));
    const strategyBotIds = new Set(strategiesWithOC3.map(s => s.bot_id));
    const missingBots = Array.from(strategyBotIds).filter(id => !activeBotIds.has(id));
    
    if (missingBots.length > 0) {
      console.log(`\n⚠️ WARNING: Strategies reference bot_ids that are not active:`);
      missingBots.forEach(botId => {
        const count = strategiesWithOC3.filter(s => s.bot_id === botId).length;
        console.log(`  - Bot ${botId}: ${count} strategies`);
      });
    } else {
      console.log(`\n✅ All strategy bot_ids have active bots`);
    }

    // 5. Check exchange distribution
    const byExchange = new Map();
    for (const s of strategiesWithOC3) {
      const ex = (s.exchange || 'unknown').toLowerCase();
      if (!byExchange.has(ex)) {
        byExchange.set(ex, []);
      }
      byExchange.get(ex).push(s);
    }

    console.log(`\nStrategies with OC=3 by exchange:`);
    for (const [ex, strats] of byExchange.entries()) {
      console.log(`  - ${ex}: ${strats.length} strategies`);
    }

    process.exit(0);
  } catch (e) {
    logger.error('Debug failed:', e?.message || e);
    console.error(e);
    process.exit(1);
  }
}

debugStrategiesOrders();

