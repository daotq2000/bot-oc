import { cn } from '@/lib/utils';
import { useState } from 'react';
import type { ReactNode } from 'react';

interface TabsProps {
  tabs: { id: string; label: string; content: ReactNode }[];
  defaultValue?: string;
  onChange?: (value: string) => void;
}

export function Tabs({ tabs, defaultValue, onChange }: TabsProps) {
  const [active, setActive] = useState(defaultValue ?? tabs[0]?.id);

  const handleChange = (value: string) => {
    setActive(value);
    onChange?.(value);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => handleChange(tab.id)}
            className={cn(
              'px-4 py-2 rounded-full text-sm font-medium transition-colors',
              active === tab.id
                ? 'bg-primary-blue text-white'
                : 'bg-gray-100 dark:bg-gray-900 text-gray-600 dark:text-gray-300'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div>
        {tabs.map(
          (tab) =>
            tab.id === active && (
              <div key={tab.id} className="animate-fade">
                {tab.content}
              </div>
            )
        )}
      </div>
    </div>
  );
}

