import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({ icon, title, description, actionLabel, onAction }: EmptyStateProps) {
  return (
    <div className="text-center py-12 border border-dashed border-gray-200 dark:border-gray-800 rounded-3xl">
      <div className="mx-auto mb-4 w-14 h-14 rounded-full bg-gray-100 dark:bg-gray-900 flex items-center justify-center text-2xl">
        {icon ?? '📦'}
      </div>
      <h3 className="text-lg font-semibold">{title}</h3>
      {description && <p className="text-sm text-gray-500 max-w-sm mx-auto mt-2">{description}</p>}
      {actionLabel && (
        <Button className="mt-4" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

