import type { Position } from '@/types/position.types';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface PositionCardProps {
  position: Position;
  onClose?: (position: Position) => void;
}

export function PositionCard({ position, onClose }: PositionCardProps) {
  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>
          {position.symbol} · {position.side.toUpperCase()}
        </CardTitle>
        <p className="text-sm text-gray-500">{position.status}</p>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span>Entry</span>
          <strong>${position.entryPrice.toFixed(2)}</strong>
        </div>
        <div className="flex justify-between">
          <span>Current</span>
          <strong>${position.currentPrice.toFixed(2)}</strong>
        </div>
        <div className="flex justify-between">
          <span>Take Profit</span>
          <strong>${position.takeProfitPrice.toFixed(2)}</strong>
        </div>
        <div className="flex justify-between">
          <span>Stop Loss</span>
          <strong>${position.stopLossPrice.toFixed(2)}</strong>
        </div>
        <div className="flex justify-between">
          <span>PnL</span>
          <strong className={position.pnl >= 0 ? 'text-emerald-600' : 'text-red-500'}>
            {position.pnl >= 0 ? '+' : ''}
            ${position.pnl.toFixed(2)}
          </strong>
        </div>
        {position.status === 'open' && (
          <Button className="w-full mt-4" onClick={() => onClose?.(position)}>
            Close Position
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

