import { useStrategies, useCreateStrategy } from '@/hooks/useStrategies';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { StrategyForm } from '@/components/strategies/StrategyForm';
import { StrategyList } from '@/components/strategies/StrategyList';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import type { StrategyFormData } from '@/types/strategy.types';

export function StrategiesPage() {
  const { data, isLoading } = useStrategies();
  const [open, setOpen] = useState(false);
  const createStrategy = useCreateStrategy();

  const handleSubmit = (values: StrategyFormData) => {
    createStrategy.mutate(values, { onSuccess: () => setOpen(false) });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Strategies"
        description="Configure trading strategies for your bots."
        actions={<Button onClick={() => setOpen(true)}>+ Add Strategy</Button>}
      />
      {isLoading ? <LoadingSpinner fullScreen /> : <StrategyList strategies={data ?? []} />}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Add Strategy"
        description="Define strategy parameters."
      >
        <StrategyForm onSubmit={handleSubmit} />
      </Dialog>
    </div>
  );
}

