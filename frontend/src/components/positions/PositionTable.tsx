import type { Position } from '@/types/position.types';
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import { Button } from '@/components/ui/button';

interface PositionTableProps {
  positions?: Position[];
  onClose?: (position: Position) => void;
}

export function PositionTable({ positions, onClose }: PositionTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Symbol</TableHead>
          <TableHead>Side</TableHead>
          <TableHead>Entry</TableHead>
          <TableHead>Current</TableHead>
          <TableHead>PnL</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Action</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {positions?.map((position) => (
          <TableRow key={position.id}>
            <TableCell className="font-medium">{position.symbol}</TableCell>
            <TableCell>{position.side.toUpperCase()}</TableCell>
            <TableCell>${position.entryPrice.toFixed(2)}</TableCell>
            <TableCell>${position.currentPrice.toFixed(2)}</TableCell>
            <TableCell className={position.pnl >= 0 ? 'text-emerald-600' : 'text-red-500'}>
              {position.pnl >= 0 ? '+' : ''}
              ${position.pnl.toFixed(2)}
            </TableCell>
            <TableCell className="capitalize">{position.status}</TableCell>
            <TableCell>
              {position.status === 'open' && (
                <Button size="sm" variant="outline" onClick={() => onClose?.(position)}>
                  Close
                </Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

