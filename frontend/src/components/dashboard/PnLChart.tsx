import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import type { DashboardData } from '@/types/common.types';
import { Button } from '@/components/ui/button';

const periods: Array<{ label: string; value: DashboardData['stats']['totalPnl'] }> = [
  { label: '24h', value: 24 },
  { label: '7d', value: 7 },
  { label: '30d', value: 30 },
  { label: 'All', value: 0 },
];

interface PnLChartProps {
  data: Array<{ date: string; pnl: number }>;
  period: string;
  onPeriodChange: (period: string) => void;
}

export function PnLChart({ data, period, onPeriodChange }: PnLChartProps) {
  return (
    <div className="rounded-3xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-950 p-6 space-y-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-500">PnL Overview</p>
          <p className="text-xl font-semibold">Last {period}</p>
        </div>
        <div className="flex gap-2">
          {periods.map((p) => (
            <Button
              key={p.label}
              variant={period === p.label ? 'default' : 'outline'}
              size="sm"
              onClick={() => onPeriodChange(p.label)}
            >
              {p.label}
            </Button>
          ))}
        </div>
      </div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ left: -20, right: 0, top: 10, bottom: 0 }}
          >
            <XAxis dataKey="date" stroke="#9CA3AF" />
            <YAxis stroke="#9CA3AF" />
            <Tooltip
              contentStyle={{ borderRadius: 12, borderColor: '#E5E7EB', backgroundColor: '#fff' }}
              labelStyle={{ color: '#4B5563' }}
            />
            <Line type="monotone" dataKey="pnl" stroke="#3B82F6" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

