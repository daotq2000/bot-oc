import { useState } from 'react';
import { useBots, useCreateBot } from '@/hooks/useBots';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { BotList } from '@/components/bots/BotList';
import { BotForm } from '@/components/bots/BotForm';
import { Dialog } from '@/components/ui/dialog';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import type { BotFormData } from '@/types/bot.types';

export function BotsPage() {
  const { data, isLoading } = useBots();
  const [open, setOpen] = useState(false);
  const createBot = useCreateBot();

  const handleSubmit = (values: BotFormData) => {
    createBot.mutate(values, { onSuccess: () => setOpen(false) });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Bots"
        description="Manage your automated trading bots across exchanges."
        actions={
          <Button onClick={() => setOpen(true)}>
            + Add Bot
          </Button>
        }
      />
      {isLoading ? <LoadingSpinner fullScreen /> : <BotList bots={data ?? []} />}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Create New Bot"
        description="Configure your bot settings."
      >
        <BotForm onSubmit={handleSubmit} />
      </Dialog>
    </div>
  );
}

