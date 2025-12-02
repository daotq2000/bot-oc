import { PageHeader } from '@/components/layout/PageHeader';
import { useUIStore } from '@/store/uiStore';
import { Switch } from '@/components/ui/switch';
import { useState } from 'react';

export function SettingsPage() {
  const { autoRefresh, toggleAutoRefresh } = useUIStore();
  const [timezone, setTimezone] = useState('Asia/Ho_Chi_Minh');

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Adjust preferences for your trading workspace." />
      <div className="rounded-3xl border border-gray-100 dark:border-gray-900 bg-white dark:bg-gray-950 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium">Auto Refresh</p>
            <p className="text-sm text-gray-500">Automatically refresh data every few seconds</p>
          </div>
          <Switch checked={autoRefresh} onClick={toggleAutoRefresh} />
        </div>
        <div className="space-y-2">
          <p className="font-medium">Timezone</p>
          <select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="w-full rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-3 py-2"
          >
            <option value="Asia/Ho_Chi_Minh">Asia/Ho_Chi_Minh (UTC+7)</option>
            <option value="UTC">UTC</option>
          </select>
        </div>
      </div>
    </div>
  );
}

