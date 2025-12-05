import { useState } from 'react';
import { useBots, useCreateBot } from '@/hooks/useBots';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { BotList } from '@/components/bots/BotList';
import { BotFormCardCompact } from '@/components/bots/BotFormCardCompact';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import type { BotFormData } from '@/types/bot.types';

export function BotsGridLayoutPage() {
  const { data, isLoading } = useBots();
  const [showForm, setShowForm] = useState(false);
  const createBot = useCreateBot();

  const handleSubmit = (values: BotFormData) => {
    createBot.mutate(values, { onSuccess: () => setShowForm(false) });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Bots"
        description="Manage your automated trading bots across exchanges."
        actions={
          !showForm && (
            <Button onClick={() => setShowForm(true)}>
              + Add Bot
            </Button>
          )
        }
      />

      {isLoading ? (
        <LoadingSpinner fullScreen />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {showForm && (
            <BotFormCardCompact onSubmit={handleSubmit} onCancel={() => setShowForm(false)} />
          )}
          {data?.map((bot) => (
            <div key={bot.id}>
              <BotList bots={[bot]} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

