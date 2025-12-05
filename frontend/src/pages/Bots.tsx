import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBots, useCreateBot, useUpdateBot } from '@/hooks/useBots';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { BotList } from '@/components/bots/BotList';
import { BotFormCard } from '@/components/bots/BotFormCard';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import type { Bot, BotFormData } from '@/types/bot.types';

function mapToApiPayload(data: Partial<BotFormData>) {
  const mapped: Record<string, any> = {};
  const push = (k: string, v: any) => {
    if (v !== undefined && v !== null && v !== '') mapped[k] = v;
  };
  push('bot_name', data.botName);
  push('exchange', data.exchange);
  push('uid', data.uid);
  push('access_key', data.accessKey);
  push('secret_key', data.secretKey);
  push('proxy', data.proxy);
  push('telegram_chat_id', data.telegramChatId);
  push('future_balance_target', data.futureBalanceTarget);
  push('transfer_frequency', data.transferFrequency);
  push('spot_transfer_threshold', data.spotTransferThreshold);
  push('withdraw_enabled', data.withdrawEnabled);
  push('withdraw_address', data.withdrawAddress);
  push('spot_balance_threshold', data.spotBalanceThreshold);
  push('is_active', data.isActive);
  return mapped;
}

export function BotsPage() {
  const { data, isLoading } = useBots();
  const [showForm, setShowForm] = useState(false);
  const [editingBot, setEditingBot] = useState<Bot | null>(null);
  const createBot = useCreateBot();
  const updateBot = useUpdateBot();
  const navigate = useNavigate();

  const handleSubmit = (values: BotFormData) => {
    if (editingBot) {
      updateBot.mutate(
        { id: editingBot.id, data: mapToApiPayload(values) as any },
        { onSuccess: () => { setShowForm(false); setEditingBot(null); } }
      );
      return;
    }
    createBot.mutate(mapToApiPayload(values) as any, { onSuccess: () => setShowForm(false) });
  };

  const handleEdit = (bot: Bot) => {
    setEditingBot(bot);
    setShowForm(true);
  };

  const handleToggleActive = (bot: Bot, nextActive: boolean) => {
    updateBot.mutate({ id: bot.id, data: mapToApiPayload({ isActive: nextActive }) as any });
  };

  function mapBotToFormDefaults(b: any): Partial<BotFormData> {
    return {
      botName: b.botName ?? b.bot_name ?? '',
      exchange: (b.exchange ?? 'mexc') as any,
      uid: b.uid ?? '',
      accessKey: b.accessKey ?? b.access_key ?? '',
      secretKey: '',
      proxy: b.proxy ?? '',
      futureBalanceTarget: Number(b.futureBalanceTarget ?? b.future_balance_target ?? 0),
      transferFrequency: Number(b.transferFrequency ?? b.transfer_frequency ?? 0),
      spotTransferThreshold: Number(b.spotTransferThreshold ?? b.spot_transfer_threshold ?? 0),
      withdrawEnabled: Boolean(b.withdrawEnabled ?? b.withdraw_enabled ?? false),
      withdrawAddress: b.withdrawAddress ?? b.withdraw_address ?? '',
      spotBalanceThreshold: Number(b.spotBalanceThreshold ?? b.spot_balance_threshold ?? 0),
      telegramChatId: b.telegramChatId ?? b.telegram_chat_id ?? '',
      isActive: Boolean(b.isActive ?? b.is_active ?? false),
    };
  }

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

      {showForm ? (
        <BotFormCard
          onSubmit={handleSubmit}
          onCancel={() => {
            setShowForm(false);
            setEditingBot(null);
          }}
          title={editingBot ? `Edit ${mapBotToFormDefaults(editingBot).botName}` : 'Create New Bot'}
          submitLabel={editingBot ? 'Save Changes' : 'Create Bot'}
          defaultValues={editingBot ? mapBotToFormDefaults(editingBot) : undefined}
        />
      ) : (
        <>
          {isLoading ? (
            <LoadingSpinner fullScreen />
          ) : (
            <BotList bots={data ?? []} onEdit={handleEdit} onToggleActive={handleToggleActive} />
          )}
        </>
      )}
    </div>
  );
}

