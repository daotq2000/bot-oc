import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import type { StrategyFormData } from '@/types/strategy.types';
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { StrategyCalculator } from './StrategyCalculator';

const schema = z.object({
  symbol: z.string().min(3),
  tradeType: z.enum(['long', 'short', 'both']),
  interval: z.enum(['1m', '3m', '5m', '15m', '30m', '1h']),
  oc: z.number().min(1).max(100),
  extend: z.number().min(1).max(100),
  amount: z.number().min(1),
  takeProfit: z.number().min(1).max(1000),
  reduce: z.number().min(1).max(100),
  upReduce: z.number().min(1).max(100),
  ignore: z.number().min(1).max(100),
  isActive: z.boolean(),
});

interface StrategyFormProps {
  defaultValues?: Partial<StrategyFormData>;
  onSubmit: (data: StrategyFormData) => void;
}

export function StrategyForm({ defaultValues, onSubmit }: StrategyFormProps) {
  const form = useForm<StrategyFormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      symbol: 'BTC/USDT',
      tradeType: 'both',
      interval: '1m',
      oc: 2,
      extend: 10,
      amount: 10,
      takeProfit: 50,
      reduce: 5,
      upReduce: 5,
      ignore: 50,
      isActive: true,
      ...defaultValues,
    },
  });

  return (
    <div className="grid md:grid-cols-2 gap-6">
      <Form<StrategyFormData> methods={form} onSubmit={onSubmit}>
        <div className="space-y-4">
          <FormField
            control={form.control}
            name="symbol"
            render={({ field }) => {
              const { value, ...rest } = field;
              return (
                <FormItem>
                  <FormLabel>Trading Pair</FormLabel>
                  <FormControl>
                    <Input placeholder="BTC/USDT" {...rest} value={(value ?? '') as string} />
                  </FormControl>
                  <FormMessage errors={form.formState.errors} name="symbol" />
                </FormItem>
              );
            }}
          />
          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="tradeType"
              render={({ field }) => {
                const { value, ...rest } = field;
                return (
                  <FormItem>
                    <FormLabel>Trade Type</FormLabel>
                    <FormControl>
                      <select
                        className="w-full rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-3 py-2"
                        {...rest}
                        value={(value ?? 'both') as string}
                      >
                        <option value="long">Long</option>
                        <option value="short">Short</option>
                        <option value="both">Both</option>
                      </select>
                    </FormControl>
                  </FormItem>
                );
              }}
            />
            <FormField
              control={form.control}
              name="interval"
              render={({ field }) => {
                const { value, ...rest } = field;
                return (
                  <FormItem>
                    <FormLabel>Interval</FormLabel>
                    <FormControl>
                      <select
                        className="w-full rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-3 py-2"
                        {...rest}
                        value={(value ?? '1m') as string}
                      >
                        {['1m', '3m', '5m', '15m', '30m', '1h'].map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </FormControl>
                  </FormItem>
                );
              }}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="oc"
              render={({ field }) => {
                const { value, onChange, ...rest } = field;
                return (
                  <FormItem>
                    <FormLabel>OC (%)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        {...rest}
                        value={(value ?? 0) as number | string}
                        onChange={(e) => onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormMessage errors={form.formState.errors} name="oc" />
                  </FormItem>
                );
              }}
            />
            <FormField
              control={form.control}
              name="extend"
              render={({ field }) => {
                const { value, onChange, ...rest } = field;
                return (
                  <FormItem>
                    <FormLabel>Extend (%)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        {...rest}
                        value={(value ?? 0) as number | string}
                        onChange={(e) => onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormMessage errors={form.formState.errors} name="extend" />
                  </FormItem>
                );
              }}
            />
          </div>
          <FormField
            control={form.control}
            name="amount"
            render={({ field }) => {
              const { value, onChange, ...rest } = field;
              return (
                <FormItem>
                  <FormLabel>Amount ($)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      {...rest}
                      value={(value ?? 0) as number | string}
                      onChange={(e) => onChange(Number(e.target.value))}
                    />
                  </FormControl>
                </FormItem>
              );
            }}
          />
          <FormField
            control={form.control}
            name="takeProfit"
            render={({ field }) => {
              const { value, onChange, ...rest } = field;
              return (
                <FormItem>
                  <FormLabel>Take Profit (store as 40 = 4%)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      {...rest}
                      value={(value ?? 0) as number | string}
                      onChange={(e) => onChange(Number(e.target.value))}
                    />
                  </FormControl>
                </FormItem>
              );
            }}
          />
          <div className="grid grid-cols-3 gap-4">
            <FormField
              control={form.control}
              name="reduce"
              render={({ field }) => {
                const { value, onChange, ...rest } = field;
                return (
                  <FormItem>
                    <FormLabel>Reduce</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        {...rest}
                        value={(value ?? 0) as number | string}
                        onChange={(e) => onChange(Number(e.target.value))}
                      />
                    </FormControl>
                  </FormItem>
                );
              }}
            />
            <FormField
              control={form.control}
              name="upReduce"
              render={({ field }) => {
                const { value, onChange, ...rest } = field;
                return (
                  <FormItem>
                    <FormLabel>Up Reduce</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        {...rest}
                        value={(value ?? 0) as number | string}
                        onChange={(e) => onChange(Number(e.target.value))}
                      />
                    </FormControl>
                  </FormItem>
                );
              }}
            />
            <FormField
              control={form.control}
              name="ignore"
              render={({ field }) => {
                const { value, onChange, ...rest } = field;
                return (
                  <FormItem>
                    <FormLabel>Ignore (%)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        {...rest}
                        value={(value ?? 0) as number | string}
                        onChange={(e) => onChange(Number(e.target.value))}
                      />
                    </FormControl>
                  </FormItem>
                );
              }}
            />
          </div>
          <FormField
            control={form.control}
            name="isActive"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Active</FormLabel>
                <FormControl>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={Boolean(field.value)}
                      onChange={(e) => field.onChange(e.target.checked)}
                    />
                    Enable strategy
                  </label>
                </FormControl>
              </FormItem>
            )}
          />
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => form.reset()}>
              Reset
            </Button>
            <Button type="submit">Save Strategy</Button>
          </div>
        </div>
      </Form>
      <StrategyCalculator formValues={form.watch()} />
    </div>
  );
}

