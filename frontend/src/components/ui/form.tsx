import { cn } from '@/lib/utils';
import {
  Controller,
  FormProvider,
} from 'react-hook-form';
import type {
  ControllerProps,
  FieldErrors,
  FieldValues,
  UseFormReturn,
} from 'react-hook-form';
import type { ReactNode } from 'react';

interface FormProps<T extends FieldValues> {
  children: ReactNode;
  methods: UseFormReturn<T>;
  onSubmit: (values: T) => void;
}

export function Form<T extends FieldValues>({ children, methods, onSubmit }: FormProps<T>) {
  return (
    <FormProvider {...methods}>
      <form onSubmit={methods.handleSubmit(onSubmit)}>{children}</form>
    </FormProvider>
  );
}

export const FormField = <T extends FieldValues>(props: ControllerProps<T>) => (
  <Controller {...props} />
);

export const FormItem = ({ className, children }: { className?: string; children: ReactNode }) => (
  <div className={cn('space-y-2', className)}>{children}</div>
);

export const FormLabel = ({ children }: { children: ReactNode }) => (
  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{children}</label>
);

export const FormControl = ({ children }: { children: ReactNode }) => <div>{children}</div>;

export const FormMessage = ({ errors, name }: { errors?: FieldErrors; name: string }) => {
  const error = name
    .split('.')
    .reduce((acc: any, key) => (acc ? acc[key] : undefined), errors as Record<string, any>);
  if (!error) return null;
  return <p className="text-sm text-red-500">{error.message as string}</p>;
};

