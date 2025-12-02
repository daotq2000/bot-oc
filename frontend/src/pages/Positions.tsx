import { usePositions, useClosePosition } from '@/hooks/usePositions';
import { PageHeader } from '@/components/layout/PageHeader';
import { PositionTable } from '@/components/positions/PositionTable';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useState } from 'react';
import { ClosePositionDialog } from '@/components/positions/ClosePositionDialog';
import type { Position } from '@/types/position.types';

export function PositionsPage() {
  const { data, isLoading } = usePositions();
  const [selected, setSelected] = useState<Position | undefined>();
  const closePosition = useClosePosition();

  const handleClose = (position: Position) => setSelected(position);
  const confirmClose = () => {
    if (selected) {
      closePosition.mutate(selected.id, { onSuccess: () => setSelected(undefined) });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Positions" description="Monitor open and closed positions in real-time." />
      {isLoading ? <LoadingSpinner fullScreen /> : <PositionTable positions={data} onClose={handleClose} />}
      <ClosePositionDialog open={!!selected} position={selected} onConfirm={confirmClose} onClose={() => setSelected(undefined)} />
    </div>
  );
}

