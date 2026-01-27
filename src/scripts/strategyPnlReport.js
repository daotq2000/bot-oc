import pool from '../config/database.js';
import logger from '../utils/logger.js';

/**
 * Strategy PnL effectiveness report
 *
 * Usage:
 *   node src/scripts/strategyPnlReport.js              // last 7 days, all bots
 *   node src/scripts/strategyPnlReport.js --days=30    // last 30 days
 *   node src/scripts/strategyPnlReport.js --botId=1    // specific bot
 *   node src/scripts/strategyPnlReport.js --botId=1 --days=3
 */
async function main() {
  const args = process.argv.slice(2);

  const daysArg = args.find(a => a.startsWith('--days='));
  const botArg = args.find(a => a.startsWith('--botId='));

  const days = daysArg ? Number(daysArg.split('=')[1]) : 7;
  const botId = botArg ? Number(botArg.split('=')[1]) : null;

  if (Number.isNaN(days) || days <= 0) {
    // eslint-disable-next-line no-console
    console.error('❌ Invalid --days value. Must be a positive number.');
    process.exit(1);
  }

  if (botArg && (Number.isNaN(botId) || botId <= 0)) {
    // eslint-disable-next-line no-console
    console.error('❌ Invalid --botId value. Must be a positive integer.');
    process.exit(1);
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  logger.info(
    `[StrategyPnlReport] Generating strategy PnL report for last ${days} day(s)` +
      (botId ? `, botId=${botId}` : ', all bots')
  );

  const params = [since];
  let where = 'p.status = \'closed\' AND p.closed_at >= ?';

  if (botId) {
    where += ' AND p.bot_id = ?';
    params.push(botId);
  }

  const sql = `
    SELECT
      s.id AS strategy_id,
      s.symbol,
      s.\`interval\`,
      s.trade_type,
      s.oc,
      b.id AS bot_id,
      b.bot_name,
      b.exchange,
      COUNT(*) AS trades,
      SUM(COALESCE(p.pnl, 0)) AS total_pnl,
      AVG(COALESCE(p.pnl, 0)) AS avg_pnl,
      SUM(CASE WHEN COALESCE(p.pnl, 0) > 0 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN COALESCE(p.pnl, 0) < 0 THEN 1 ELSE 0 END) AS losses
    FROM positions p
    JOIN strategies s ON p.strategy_id = s.id
    JOIN bots b ON p.bot_id = b.id
    WHERE ${where}
    GROUP BY
      s.id,
      s.symbol,
      s.\`interval\`,
      s.trade_type,
      s.oc,
      b.id,
      b.bot_name,
      b.exchange
    HAVING trades > 0
    ORDER BY total_pnl DESC, trades DESC;
  `;

  const [rows] = await pool.execute(sql, params);
  const data = rows || [];

  if (data.length === 0) {
    // eslint-disable-next-line no-console
    console.log('⚠️  No closed positions found for the given filters.');
    return;
  }

  // Build summary
  let globalPnl = 0;
  let globalTrades = 0;
  let globalWins = 0;
  let globalLosses = 0;

  const reportRows = data.map(r => {
    const trades = Number(r.trades || 0);
    const wins = Number(r.wins || 0);
    const losses = Number(r.losses || 0);
    const totalPnl = Number(r.total_pnl || 0);
    const avgPnl = Number(r.avg_pnl || 0);
    const nonZero = wins + losses;
    const winRate = nonZero > 0 ? (wins / nonZero) * 100 : 0;

    globalPnl += totalPnl;
    globalTrades += trades;
    globalWins += wins;
    globalLosses += losses;

    return {
      bot: `${r.bot_name} (${r.exchange})`,
      strategy: `#${r.strategy_id} ${r.symbol} ${r.interval} ${r.trade_type || ''} oc=${r.oc}`,
      trades,
      wins,
      losses,
      winRate: `${winRate.toFixed(1)}%`,
      totalPnl: totalPnl.toFixed(2),
      avgPnl: avgPnl.toFixed(2)
    };
  });

  const globalNonZero = globalWins + globalLosses;
  const globalWinRate = globalNonZero > 0 ? (globalWins / globalNonZero) * 100 : 0;

  // eslint-disable-next-line no-console
  console.log('================= Strategy PnL Report =================');
  // eslint-disable-next-line no-console
  console.log(`Range : last ${days} day(s) since ${since.toISOString()}`);
  // eslint-disable-next-line no-console
  console.log(`Scope : ${botId ? `botId=${botId}` : 'all bots'}`);
  // eslint-disable-next-line no-console
  console.log('--------------------------------------------------------');

  // eslint-disable-next-line no-console
  console.table(reportRows);

  // eslint-disable-next-line no-console
  console.log('---------------------- SUMMARY -------------------------');
  // eslint-disable-next-line no-console
  console.log(
    `Total PnL  : ${globalPnl.toFixed(2)} USDT | Trades=${globalTrades}, Wins=${globalWins}, ` +
      `Losses=${globalLosses}, WinRate=${globalWinRate.toFixed(1)}%`
  );
}

main().catch(err => {
  logger.error('[StrategyPnlReport] Failed to generate report:', err?.message || err);
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});


