import { cn } from '@/lib/utils';
import type { ButtonHTMLAttributes } from 'react';

interface SwitchProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  checked?: boolean;
}

export function Switch({ checked, className, ...props }: SwitchProps) {
  return (
    <button
      type="button"
      className={cn(
        'w-12 h-6 rounded-full transition-colors flex items-center px-0.5',
        checked ? 'bg-primary-blue' : 'bg-gray-300',
        className
      )}
      aria-pressed={checked}
      {...props}
    >
      <span
        className={cn(
          'h-5 w-5 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-6' : 'translate-x-0'
        )}
      />
    </button>
  );
}

