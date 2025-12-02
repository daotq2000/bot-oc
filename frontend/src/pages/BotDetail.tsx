import { useParams } from 'react-router-dom';
import { useBot } from '@/hooks/useBots';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Badge } from '@/components/ui/badge';

export function BotDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useBot(Number(id));

  if (isLoading || !data) {
    return <LoadingSpinner fullScreen />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={data.botName}
        description={`Exchange: ${data.exchange.toUpperCase()}`}
        actions={<Badge variant={data.isActive ? 'success' : 'warning'}>{data.isActive ? 'Active' : 'Paused'}</Badge>}
      />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-gray-100 dark:border-gray-900 p-4">
          <h3 className="font-semibold mb-2">Balance Overview</h3>
          <p className="text-sm text-gray-500">Future Target: ${data.futureBalanceTarget}</p>
          <p className="text-sm text-gray-500">Transfer Frequency: {data.transferFrequency}m</p>
        </div>
        <div className="rounded-2xl border border-gray-100 dark:border-gray-900 p-4">
          <h3 className="font-semibold mb-2">Auto Withdrawal</h3>
          <p className="text-sm text-gray-500">
            Status: {data.withdrawEnabled ? 'Enabled' : 'Disabled'}
          </p>
          {data.withdrawAddress && <p className="text-sm">{data.withdrawAddress}</p>}
        </div>
      </div>
    </div>
  );
}

