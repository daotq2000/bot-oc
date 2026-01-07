import type { Strategy } from '@/types/strategy.types';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface StrategyCardProps {
  strategy: Strategy;
  onEdit?: (strategy: Strategy) => void;
  onDelete?: (strategy: Strategy) => void;
}

export function StrategyCard({ strategy, onEdit, onDelete }: StrategyCardProps) {
  const amountValue =
    typeof strategy.amount === 'number' ? strategy.amount : Number(strategy.amount ?? 0);

  return (
    <Card>
      <CardHeader className="flex flex-row justify-between">
        <div>
          <CardTitle>{strategy.symbol}</CardTitle>
          <p className="text-sm text-gray-500 capitalize">
            {strategy.tradeType} · {strategy.interval}
          </p>
        </div>
        <Badge variant={strategy.isActive ? 'success' : 'warning'}>
          {strategy.isActive ? 'Active' : 'Paused'}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-gray-600 dark:text-gray-300">
        <div className="flex justify-between">
          <span>OC</span>
          <strong>{strategy.oc}%</strong>
        </div>
        <div className="flex justify-between">
          <span>Extend</span>
          <strong>{strategy.extend}%</strong>
        </div>
        <div className="flex justify-between">
          <span>Amount</span>
          <strong>${amountValue.toFixed(2)}</strong>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onEdit?.(strategy)}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onDelete?.(strategy)}>
            Delete
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

