import type { Strategy } from '@/types/strategy.types';
import { StrategyCard } from './StrategyCard';
import { EmptyState } from '@/components/common/EmptyState';

interface StrategyListProps {
  strategies?: Strategy[];
  onEdit?: (strategy: Strategy) => void;
  onDelete?: (strategy: Strategy) => void;
}

export function StrategyList({ strategies, onEdit, onDelete }: StrategyListProps) {
  if (!strategies?.length) {
    return <EmptyState title="No strategies" description="Create your first strategy to begin trading." />;
  }
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {strategies.map((strategy) => (
        <StrategyCard key={strategy.id} strategy={strategy} onEdit={onEdit} onDelete={onDelete} />
      ))}
    </div>
  );
}

