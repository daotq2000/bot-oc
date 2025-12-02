import { useState } from 'react';
import { useDashboard } from '@/hooks/useDashboard';
import { useRealTimeUpdates } from '@/hooks/useRealTimeUpdates';
import { StatsCard } from '@/components/dashboard/StatsCard';
import { PnLChart } from '@/components/dashboard/PnLChart';
import { ActiveBotsWidget } from '@/components/dashboard/ActiveBotsWidget';
import { RecentTrades } from '@/components/dashboard/RecentTrades';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ActivitySquare, TrendingUp, Bot, Trophy } from 'lucide-react';

export function DashboardPage() {
  const { data, isLoading } = useDashboard();
  const [period, setPeriod] = useState<'24h' | '7d' | '30d' | 'All'>('24h');
  useRealTimeUpdates();

  if (isLoading || !data) {
    return <LoadingSpinner fullScreen />;
  }

  const { stats } = data;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatsCard title="Total PnL" value={`$${stats.totalPnl.toFixed(2)}`} icon={ActivitySquare} colorScheme="green" />
        <StatsCard title="Total Volume" value={`$${stats.totalVolume.toFixed(2)}`} icon={TrendingUp} colorScheme="blue" />
        <StatsCard title="Active Bots" value={stats.activeBots} icon={Bot} colorScheme="purple" />
        <StatsCard title="Win Rate" value={`${stats.winRate}%`} icon={Trophy} colorScheme="orange" />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <PnLChart data={data.pnlSeries} period={period} onPeriodChange={(p) => setPeriod(p as any)} />
          </div>
          <ActiveBotsWidget bots={data.activeBots} />
      </div>
      <RecentTrades positions={data.recentPositions} />
    </div>
  );
}

