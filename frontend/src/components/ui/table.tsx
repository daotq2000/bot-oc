import { cn } from '@/lib/utils';
import type { HTMLAttributes, TableHTMLAttributes } from 'react';

export const Table = ({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) => (
  <div className="overflow-x-auto">
    <table className={cn('w-full text-sm text-left', className)} {...props} />
  </div>
);

export const TableHeader = ({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) => (
  <thead className={cn('bg-gray-50 dark:bg-gray-900/30 text-gray-500 uppercase text-xs', className)} {...props} />
);

export const TableBody = ({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) => (
  <tbody className={cn('divide-y divide-gray-100 dark:divide-gray-800', className)} {...props} />
);

export const TableRow = ({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) => (
  <tr className={cn('hover:bg-gray-50/80 dark:hover:bg-gray-900/40 transition-colors', className)} {...props} />
);

export const TableHead = ({ className, ...props }: HTMLAttributes<HTMLTableCellElement>) => (
  <th className={cn('px-4 py-3 font-medium tracking-wide', className)} {...props} />
);

export const TableCell = ({ className, ...props }: HTMLAttributes<HTMLTableCellElement>) => (
  <td className={cn('px-4 py-3 text-gray-700 dark:text-gray-200', className)} {...props} />
);

