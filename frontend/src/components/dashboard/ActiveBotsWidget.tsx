import type { DashboardData } from '@/types/common.types';
import { Badge } from '@/components/ui/badge';

interface ActiveBotsWidgetProps {
  bots: DashboardData['activeBots'];
}

const statusColor: Record<'running' | 'paused' | 'error', 'success' | 'info' | 'destructive'> = {
  running: 'success',
  paused: 'info',
  error: 'destructive',
};

export function ActiveBotsWidget({ bots }: ActiveBotsWidgetProps) {
  return (
    <div className="rounded-3xl border border-gray-100 dark:border-gray-900 bg-white dark:bg-gray-950 p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <p className="text-lg font-semibold">Active Bots</p>
        <Badge variant="info">{bots.length} total</Badge>
      </div>
      <div className="space-y-4">
        {bots.map((bot) => (
          <div key={bot.id} className="flex items-center justify-between">
            <div>
              <p className="font-medium">{bot.name}</p>
              <p className="text-sm text-gray-500">
                PnL: <span className={bot.currentPnl >= 0 ? 'text-green-600' : 'text-red-500'}>{bot.currentPnl}%</span>
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Badge variant={statusColor[bot.status]}>{bot.status}</Badge>
              <p className="text-sm text-gray-500">{bot.activePositions} positions</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

