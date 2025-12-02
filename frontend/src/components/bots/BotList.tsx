import type { Bot } from '@/types/bot.types';
import { BotCard } from './BotCard';
import { EmptyState } from '@/components/common/EmptyState';
import { Loader2 } from 'lucide-react';

interface BotListProps {
  bots?: Bot[];
  isLoading?: boolean;
  onView?: (bot: Bot) => void;
  onEdit?: (bot: Bot) => void;
}

export function BotList({ bots, isLoading, onView, onEdit }: BotListProps) {
  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
      </div>
    );
  }

  if (!bots?.length) {
    return <EmptyState title="No bots yet" description="Create your first bot to get started." />;
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {bots.map((bot) => (
        <BotCard key={bot.id} bot={bot} onView={onView} onEdit={onEdit} />
      ))}
    </div>
  );
}

