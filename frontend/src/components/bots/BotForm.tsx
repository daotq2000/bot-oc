import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { BotFormData } from '@/types/bot.types';
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tooltip } from '@/components/ui/tooltip';

const schema = z.object({
  botName: z.string().min(3),
  exchange: z.enum(['mexc', 'gate', 'binance']),
  accessKey: z.string().min(10),
  secretKey: z.string().min(10),
  uid: z.string().optional(),
  proxy: z.string().optional(),
  futureBalanceTarget: z.number().min(10),
  transferFrequency: z.number().min(5),
  spotTransferThreshold: z.number().min(5),
  withdrawEnabled: z.boolean(),
  withdrawAddress: z.string().optional(),
  spotBalanceThreshold: z.number().min(10),
  telegramChatId: z.string().optional(),
});

interface BotFormProps {
  defaultValues?: Partial<BotFormData>;
  onSubmit: (data: BotFormData) => void;
}

export function BotForm({ defaultValues, onSubmit }: BotFormProps) {
  const form = useForm<BotFormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      botName: '',
      exchange: 'mexc',
      accessKey: '',
      secretKey: '',
      futureBalanceTarget: 20,
      transferFrequency: 15,
      spotTransferThreshold: 10,
      withdrawEnabled: false,
      spotBalanceThreshold: 10,
      ...defaultValues,
    },
  });

  return (
    <Form<BotFormData> methods={form} onSubmit={onSubmit}>
      <div className="grid gap-4">
        <FormField
          control={form.control}
          name="botName"
          render={({ field }) => {
            const { value, ...rest } = field;
            return (
              <FormItem>
                <FormLabel>
                  Bot Name
                  <Tooltip content="Choose a memorable name for your bot">
                    <span className="ml-2 text-gray-400 cursor-help">ℹ️</span>
                  </Tooltip>
                </FormLabel>
                <FormControl>
                  <Input placeholder="My MEXC Bot" {...rest} value={(value ?? '') as string} />
                </FormControl>
                <FormMessage errors={form.formState.errors} name="botName" />
              </FormItem>
            );
          }}
        />
        <FormField
          control={form.control}
          name="exchange"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Exchange</FormLabel>
              <FormControl>
                <Select value={(field.value ?? 'mexc') as string} onChange={(e) => field.onChange(e.target.value)}>
                  <option value="mexc">MEXC</option>
                  <option value="gate">Gate.io</option>
                  <option value="binance">Binance</option>
                </Select>
              </FormControl>
              <FormMessage errors={form.formState.errors} name="exchange" />
            </FormItem>
          )}
        />
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="futureBalanceTarget"
            render={({ field }) => {
              const { value, onChange, ...rest } = field;
              return (
                <FormItem>
                  <FormLabel>Future Balance Target ($)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      {...rest}
                      value={(value ?? 0) as number | string}
                      onChange={(e) => onChange(Number(e.target.value))}
                    />
                  </FormControl>
                  <FormMessage errors={form.formState.errors} name="futureBalanceTarget" />
                </FormItem>
              );
            }}
          />
          <FormField
            control={form.control}
            name="transferFrequency"
            render={({ field }) => {
              const { value, onChange, ...rest } = field;
              return (
                <FormItem>
                  <FormLabel>Transfer Frequency (minutes)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      {...rest}
                      value={(value ?? 0) as number | string}
                      onChange={(e) => onChange(Number(e.target.value))}
                    />
                  </FormControl>
                  <FormMessage errors={form.formState.errors} name="transferFrequency" />
                </FormItem>
              );
            }}
          />
        </div>
        <FormField
          control={form.control}
          name="withdrawEnabled"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Auto Withdrawal</FormLabel>
              <FormControl>
                <Switch checked={Boolean(field.value)} onClick={() => field.onChange(!field.value)} />
              </FormControl>
            </FormItem>
          )}
        />
        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => form.reset()}>
            Cancel
          </Button>
          <Button type="submit">Save Bot</Button>
        </div>
      </div>
    </Form>
  );
}

