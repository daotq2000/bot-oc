import type { DashboardData } from '@/types/common.types';
import { Table, TableHead, TableHeader, TableRow, TableBody, TableCell } from '@/components/ui/table';
import { formatDateTime } from '@/utils/formatters';

interface RecentTradesProps {
  positions: DashboardData['recentPositions'];
}

export function RecentTrades({ positions }: RecentTradesProps) {
  return (
    <div className="rounded-3xl border border-gray-100 dark:border-gray-900 bg-white dark:bg-gray-950 p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <p className="text-lg font-semibold">Recent Positions</p>
        <p className="text-sm text-gray-500">Last {positions.length} trades</p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Symbol</TableHead>
            <TableHead>Side</TableHead>
            <TableHead>Entry</TableHead>
            <TableHead>PnL</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Time</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {positions.map((position) => (
            <TableRow key={position.id}>
              <TableCell className="font-medium">{position.symbol}</TableCell>
              <TableCell>{position.side.toUpperCase()}</TableCell>
              <TableCell>${position.entryPrice.toFixed(2)}</TableCell>
              <TableCell className={position.pnl >= 0 ? 'text-emerald-600' : 'text-red-500'}>
                {position.pnl >= 0 ? '+' : ''}
                ${position.pnl.toFixed(2)}
              </TableCell>
              <TableCell className="capitalize">{position.status}</TableCell>
              <TableCell>{formatDateTime(position.timestamp)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

