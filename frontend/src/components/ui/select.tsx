import { cn } from '@/lib/utils';
import type { SelectHTMLAttributes } from 'react';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
}

export const Select = ({ className, children, label, ...props }: SelectProps) => (
  <label className="flex flex-col gap-1 text-sm font-medium text-gray-700 dark:text-gray-300">
    {label}
    <select
      className={cn(
        'h-10 w-full rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-blue',
        className
      )}
      {...props}
    >
      {children}
    </select>
  </label>
);

