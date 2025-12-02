import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface StatsCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  change?: number;
  trend?: 'up' | 'down';
  colorScheme?: 'green' | 'blue' | 'purple' | 'orange';
  footer?: ReactNode;
}

const colors: Record<NonNullable<StatsCardProps['colorScheme']>, string> = {
  green: 'from-emerald-100 to-emerald-50 dark:from-emerald-900/30 dark:to-emerald-900/10',
  blue: 'from-blue-100 to-blue-50 dark:from-blue-900/30 dark:to-blue-900/10',
  purple: 'from-purple-100 to-purple-50 dark:from-purple-900/30 dark:to-purple-900/10',
  orange: 'from-orange-100 to-orange-50 dark:from-orange-900/30 dark:to-orange-900/10',
};

export function StatsCard({
  title,
  value,
  icon: Icon,
  change,
  trend,
  colorScheme = 'blue',
  footer,
}: StatsCardProps) {
  return (
    <div className={cn('rounded-3xl p-5 shadow-sm border border-transparent bg-gradient-to-br', colors[colorScheme])}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-500">{title}</p>
          <p className="text-3xl font-semibold text-gray-900 dark:text-gray-50">{value}</p>
        </div>
        <span className="h-12 w-12 rounded-2xl bg-white/80 dark:bg-gray-900/40 flex items-center justify-center shadow-inner">
          <Icon className="w-5 h-5 text-gray-700 dark:text-gray-200" />
        </span>
      </div>
      {typeof change !== 'undefined' && (
        <p className={cn('mt-4 text-sm font-medium', trend === 'up' ? 'text-emerald-600' : 'text-red-500')}>
          {trend === 'up' ? '▲' : '▼'} {change}%
        </p>
      )}
      {footer && <div className="mt-4 text-xs text-gray-500">{footer}</div>}
    </div>
  );
}

