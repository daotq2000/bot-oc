import type { Position } from '@/types/position.types';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface ClosePositionDialogProps {
  open: boolean;
  position?: Position;
  onConfirm: () => void;
  onClose: () => void;
}

export function ClosePositionDialog({ open, position, onConfirm, onClose }: ClosePositionDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Close Position"
      description={`Are you sure you want to close ${position?.symbol} ${position?.side.toUpperCase()}?`}
      footer={
        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>Close Position</Button>
        </div>
      }
    >
      <p className="text-sm text-gray-600">
        Current PnL: <strong>{position?.pnl?.toFixed(2)}</strong>
      </p>
    </Dialog>
  );
}

