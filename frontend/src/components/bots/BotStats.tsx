import type { Bot } from '@/types/bot.types';
import { formatCurrency } from '@/utils/formatters';

interface BotStatsProps {
  bot: Bot;
}

export function BotStats({ bot }: BotStatsProps) {
  return (
    <div className="grid grid-cols-2 gap-3 text-sm text-gray-600 dark:text-gray-400">
      <div>
        <p className="uppercase text-xs tracking-wide text-gray-400">PnL 24h</p>
        <p className={bot.stats?.pnl24h ?? 0 >= 0 ? 'text-emerald-600' : 'text-red-500'}>
          {formatCurrency(bot.stats?.pnl24h ?? 0)}
        </p>
      </div>
      <div>
        <p className="uppercase text-xs tracking-wide text-gray-400">Strategies</p>
        <p>{bot.stats?.strategies ?? 0}</p>
      </div>
      <div>
        <p className="uppercase text-xs tracking-wide text-gray-400">Open Positions</p>
        <p>{bot.stats?.openPositions ?? 0}</p>
      </div>
      <div>
        <p className="uppercase text-xs tracking-wide text-gray-400">Total PnL</p>
        <p>{formatCurrency(bot.stats?.pnlAll ?? 0)}</p>
      </div>
    </div>
  );
}

