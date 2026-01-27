import { Position } from '../models/Position.js';
import { ExchangeService } from '../services/ExchangeService.js';
import { Bot } from '../models/Bot.js';
import { calculatePnL, calculatePnLPercent } from '../utils/calculator.js';
import logger from '../utils/logger.js';

/**
 * Script to report current PnL (unrealized) for all open positions
 * 
 * Usage:
 *   node src/scripts/openPositionsPnlReport.js
 *   node src/scripts/openPositionsPnlReport.js --botId=1
 *   node src/scripts/openPositionsPnlReport.js --groupBy=bot
 *   node src/scripts/openPositionsPnlReport.js --groupBy=strategy
 */

async function main() {
  const args = process.argv.slice(2);
  const botIdArg = args.find(a => a.startsWith('--botId='));
  const botId = botIdArg ? Number(botIdArg.split('=')[1]) : null;
  const groupByArg = args.find(a => a.startsWith('--groupBy='));
  const groupBy = groupByArg ? groupByArg.split('=')[1] : 'none'; // 'none', 'bot', 'strategy', 'symbol'

  try {
    // Get all open positions
    const openPositions = await Position.findOpen();
    
    if (!openPositions || openPositions.length === 0) {
      console.log('📊 No open positions found.');
      return;
    }

    // Filter by botId if provided
    const filteredPositions = botId 
      ? openPositions.filter(p => p.bot_id === botId)
      : openPositions;

    if (filteredPositions.length === 0) {
      console.log(`📊 No open positions found for bot ${botId}.`);
      return;
    }

    console.log(`\n📊 Calculating current PnL for ${filteredPositions.length} open position(s)...\n`);

    // Group positions by bot_id to initialize ExchangeService once per bot
    const positionsByBot = new Map();
    for (const pos of filteredPositions) {
      if (!positionsByBot.has(pos.bot_id)) {
        positionsByBot.set(pos.bot_id, []);
      }
      positionsByBot.get(pos.bot_id).push(pos);
    }

    // Initialize ExchangeService for each bot
    const exchangeServices = new Map();
    for (const [botIdKey, botPositions] of positionsByBot.entries()) {
      try {
        const bot = await Bot.findById(botIdKey);
        if (!bot) {
          logger.warn(`Bot ${botIdKey} not found, skipping positions`);
          continue;
        }
        const exchangeService = new ExchangeService(bot);
        await exchangeService.initialize();
        exchangeServices.set(botIdKey, exchangeService);
      } catch (e) {
        logger.warn(`Failed to initialize ExchangeService for bot ${botIdKey}: ${e?.message || e}`);
      }
    }

    // Calculate current PnL for each position
    const positionsWithPnL = [];
    for (const pos of filteredPositions) {
      try {
        const exchangeService = exchangeServices.get(pos.bot_id);
        if (!exchangeService) {
          logger.warn(`ExchangeService not found for bot ${pos.bot_id}, skipping position ${pos.id}`);
          continue;
        }

        // Get current price
        let currentPrice = null;
        try {
          currentPrice = await exchangeService.getTickerPrice(pos.symbol);
        } catch (e) {
          logger.warn(`Failed to get current price for ${pos.symbol}: ${e?.message || e}`);
          continue;
        }

        if (!currentPrice || !Number.isFinite(Number(currentPrice)) || Number(currentPrice) <= 0) {
          logger.warn(`Invalid current price for ${pos.symbol}: ${currentPrice}`);
          continue;
        }

        // Calculate PnL
        const entryPrice = Number(pos.entry_price || 0);
        const amount = Number(pos.amount || 0);
        const side = pos.side || 'long';

        if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(amount) || amount <= 0) {
          logger.warn(`Invalid entry_price or amount for position ${pos.id}`);
          continue;
        }

        const pnl = calculatePnL(entryPrice, currentPrice, amount, side);
        const pnlPercent = calculatePnLPercent(entryPrice, currentPrice, side);

        positionsWithPnL.push({
          ...pos,
          currentPrice: Number(currentPrice),
          pnl: pnl,
          pnlPercent: pnlPercent
        });
      } catch (e) {
        logger.warn(`Error calculating PnL for position ${pos.id}: ${e?.message || e}`);
      }
    }

    if (positionsWithPnL.length === 0) {
      console.log('❌ No positions with valid PnL data found.');
      return;
    }

    // Display results based on groupBy
    if (groupBy === 'bot') {
      displayGroupedByBot(positionsWithPnL);
    } else if (groupBy === 'strategy') {
      displayGroupedByStrategy(positionsWithPnL);
    } else if (groupBy === 'symbol') {
      displayGroupedBySymbol(positionsWithPnL);
    } else {
      displayDetailed(positionsWithPnL);
    }

    // Summary
    const totalPnL = positionsWithPnL.reduce((sum, p) => sum + p.pnl, 0);
    const totalAmount = positionsWithPnL.reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const avgPnLPercent = positionsWithPnL.reduce((sum, p) => sum + p.pnlPercent, 0) / positionsWithPnL.length;
    const winningPositions = positionsWithPnL.filter(p => p.pnl > 0).length;
    const losingPositions = positionsWithPnL.filter(p => p.pnl < 0).length;

    console.log('\n' + '='.repeat(100));
    console.log('📊 SUMMARY');
    console.log('='.repeat(100));
    console.log(`Total Positions: ${positionsWithPnL.length}`);
    console.log(`Winning: ${winningPositions} | Losing: ${losingPositions} | Break-even: ${positionsWithPnL.length - winningPositions - losingPositions}`);
    console.log(`Total Unrealized PnL: ${totalPnL.toFixed(2)} USDT`);
    console.log(`Total Position Value: ${totalAmount.toFixed(2)} USDT`);
    console.log(`Average PnL %: ${avgPnLPercent.toFixed(2)}%`);
    console.log('='.repeat(100) + '\n');

  } catch (error) {
    logger.error('Error generating open positions PnL report:', error?.message || error, error?.stack);
    process.exit(1);
  }
}

function displayDetailed(positions) {
  console.log('='.repeat(150));
  console.log('📊 OPEN POSITIONS - DETAILED PnL REPORT');
  console.log('='.repeat(150));
  console.log(
    'Bot'.padEnd(20) +
    'Strategy'.padEnd(15) +
    'Symbol'.padEnd(15) +
    'Side'.padEnd(6) +
    'Entry'.padEnd(12) +
    'Current'.padEnd(12) +
    'Amount'.padEnd(12) +
    'PnL'.padEnd(12) +
    'PnL %'.padEnd(10) +
    'Age'
  );
  console.log('-'.repeat(150));

  // Sort by PnL (worst first)
  positions.sort((a, b) => a.pnl - b.pnl);

  for (const pos of positions) {
    const botName = (pos.bot_name || `bot_${pos.bot_id}`).substring(0, 18);
    const strategyId = `#${pos.strategy_id}`.substring(0, 13);
    const symbol = (pos.symbol || 'N/A').substring(0, 13);
    const side = (pos.side || 'N/A').substring(0, 4);
    const entry = Number(pos.entry_price || 0).toFixed(8).substring(0, 10);
    const current = pos.currentPrice.toFixed(8).substring(0, 10);
    const amount = Number(pos.amount || 0).toFixed(2).substring(0, 10);
    const pnl = pos.pnl.toFixed(2);
    const pnlPercent = pos.pnlPercent.toFixed(2) + '%';
    const age = pos.opened_at ? getAgeString(new Date(pos.opened_at)) : 'N/A';

    const pnlColor = pos.pnl >= 0 ? '✅' : '❌';
    
    console.log(
      botName.padEnd(20) +
      strategyId.padEnd(15) +
      symbol.padEnd(15) +
      side.padEnd(6) +
      entry.padEnd(12) +
      current.padEnd(12) +
      amount.padEnd(12) +
      `${pnlColor} ${pnl}`.padEnd(12) +
      pnlPercent.padEnd(10) +
      age
    );
  }
  console.log('='.repeat(150));
}

function displayGroupedByBot(positions) {
  const byBot = new Map();
  
  for (const pos of positions) {
    const botKey = `${pos.bot_name || `bot_${pos.bot_id}`} (${pos.exchange || 'N/A'})`;
    if (!byBot.has(botKey)) {
      byBot.set(botKey, []);
    }
    byBot.get(botKey).push(pos);
  }

  console.log('='.repeat(120));
  console.log('📊 OPEN POSITIONS - GROUPED BY BOT');
  console.log('='.repeat(120));
  console.log(
    'Bot'.padEnd(30) +
    'Positions'.padEnd(12) +
    'Total PnL'.padEnd(15) +
    'Avg PnL %'.padEnd(12) +
    'Wins'.padEnd(8) +
    'Losses'.padEnd(8)
  );
  console.log('-'.repeat(120));

  const botStats = [];
  for (const [botKey, botPositions] of byBot.entries()) {
    const totalPnL = botPositions.reduce((sum, p) => sum + p.pnl, 0);
    const avgPnLPercent = botPositions.reduce((sum, p) => sum + p.pnlPercent, 0) / botPositions.length;
    const wins = botPositions.filter(p => p.pnl > 0).length;
    const losses = botPositions.filter(p => p.pnl < 0).length;

    botStats.push({
      botKey,
      count: botPositions.length,
      totalPnL,
      avgPnLPercent,
      wins,
      losses
    });
  }

  // Sort by total PnL (worst first)
  botStats.sort((a, b) => a.totalPnL - b.totalPnL);

  for (const stat of botStats) {
    const pnlColor = stat.totalPnL >= 0 ? '✅' : '❌';
    console.log(
      stat.botKey.substring(0, 28).padEnd(30) +
      stat.count.toString().padEnd(12) +
      `${pnlColor} ${stat.totalPnL.toFixed(2)}`.padEnd(15) +
      `${stat.avgPnLPercent.toFixed(2)}%`.padEnd(12) +
      stat.wins.toString().padEnd(8) +
      stat.losses.toString().padEnd(8)
    );
  }
  console.log('='.repeat(120));
}

function displayGroupedByStrategy(positions) {
  const byStrategy = new Map();
  
  for (const pos of positions) {
    const strategyKey = `#${pos.strategy_id} ${pos.symbol || 'N/A'} ${pos.interval || 'N/A'}`;
    if (!byStrategy.has(strategyKey)) {
      byStrategy.set(strategyKey, []);
    }
    byStrategy.get(strategyKey).push(pos);
  }

  console.log('='.repeat(120));
  console.log('📊 OPEN POSITIONS - GROUPED BY STRATEGY');
  console.log('='.repeat(120));
  console.log(
    'Strategy'.padEnd(40) +
    'Positions'.padEnd(12) +
    'Total PnL'.padEnd(15) +
    'Avg PnL %'.padEnd(12) +
    'Wins'.padEnd(8) +
    'Losses'.padEnd(8)
  );
  console.log('-'.repeat(120));

  const strategyStats = [];
  for (const [strategyKey, strategyPositions] of byStrategy.entries()) {
    const totalPnL = strategyPositions.reduce((sum, p) => sum + p.pnl, 0);
    const avgPnLPercent = strategyPositions.reduce((sum, p) => sum + p.pnlPercent, 0) / strategyPositions.length;
    const wins = strategyPositions.filter(p => p.pnl > 0).length;
    const losses = strategyPositions.filter(p => p.pnl < 0).length;

    strategyStats.push({
      strategyKey,
      count: strategyPositions.length,
      totalPnL,
      avgPnLPercent,
      wins,
      losses
    });
  }

  // Sort by total PnL (worst first)
  strategyStats.sort((a, b) => a.totalPnL - b.totalPnL);

  for (const stat of strategyStats) {
    const pnlColor = stat.totalPnL >= 0 ? '✅' : '❌';
    console.log(
      stat.strategyKey.substring(0, 38).padEnd(40) +
      stat.count.toString().padEnd(12) +
      `${pnlColor} ${stat.totalPnL.toFixed(2)}`.padEnd(15) +
      `${stat.avgPnLPercent.toFixed(2)}%`.padEnd(12) +
      stat.wins.toString().padEnd(8) +
      stat.losses.toString().padEnd(8)
    );
  }
  console.log('='.repeat(120));
}

function displayGroupedBySymbol(positions) {
  const bySymbol = new Map();
  
  for (const pos of positions) {
    const symbol = pos.symbol || 'N/A';
    if (!bySymbol.has(symbol)) {
      bySymbol.set(symbol, []);
    }
    bySymbol.get(symbol).push(pos);
  }

  console.log('='.repeat(120));
  console.log('📊 OPEN POSITIONS - GROUPED BY SYMBOL');
  console.log('='.repeat(120));
  console.log(
    'Symbol'.padEnd(20) +
    'Positions'.padEnd(12) +
    'Total PnL'.padEnd(15) +
    'Avg PnL %'.padEnd(12) +
    'Wins'.padEnd(8) +
    'Losses'.padEnd(8)
  );
  console.log('-'.repeat(120));

  const symbolStats = [];
  for (const [symbol, symbolPositions] of bySymbol.entries()) {
    const totalPnL = symbolPositions.reduce((sum, p) => sum + p.pnl, 0);
    const avgPnLPercent = symbolPositions.reduce((sum, p) => sum + p.pnlPercent, 0) / symbolPositions.length;
    const wins = symbolPositions.filter(p => p.pnl > 0).length;
    const losses = symbolPositions.filter(p => p.pnl < 0).length;

    symbolStats.push({
      symbol,
      count: symbolPositions.length,
      totalPnL,
      avgPnLPercent,
      wins,
      losses
    });
  }

  // Sort by total PnL (worst first)
  symbolStats.sort((a, b) => a.totalPnL - b.totalPnL);

  for (const stat of symbolStats) {
    const pnlColor = stat.totalPnL >= 0 ? '✅' : '❌';
    console.log(
      stat.symbol.substring(0, 18).padEnd(20) +
      stat.count.toString().padEnd(12) +
      `${pnlColor} ${stat.totalPnL.toFixed(2)}`.padEnd(15) +
      `${stat.avgPnLPercent.toFixed(2)}%`.padEnd(12) +
      stat.wins.toString().padEnd(8) +
      stat.losses.toString().padEnd(8)
    );
  }
  console.log('='.repeat(120));
}

function getAgeString(openedAt) {
  const now = Date.now();
  const ageMs = now - openedAt.getTime();
  const ageMinutes = Math.floor(ageMs / (1000 * 60));
  const ageHours = Math.floor(ageMinutes / 60);
  const ageDays = Math.floor(ageHours / 24);

  if (ageDays > 0) {
    return `${ageDays}d ${ageHours % 24}h`;
  } else if (ageHours > 0) {
    return `${ageHours}h ${ageMinutes % 60}m`;
  } else {
    return `${ageMinutes}m`;
  }
}

main().catch(e => {
  logger.error('Failed to generate open positions PnL report:', e?.message || e, e?.stack);
  process.exit(1);
});



