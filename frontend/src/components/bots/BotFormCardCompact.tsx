import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { BotFormData } from '@/types/bot.types';
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertCircle, Key, Settings, Zap, CreditCard, X } from 'lucide-react';

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

interface BotFormCardCompactProps {
  defaultValues?: Partial<BotFormData>;
  onSubmit: (data: BotFormData) => void;
  onCancel?: () => void;
}

export function BotFormCardCompact({ defaultValues, onSubmit, onCancel }: BotFormCardCompactProps) {
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
    <Card className="w-full md:col-span-1 lg:col-span-1">
      <CardHeader className="flex flex-row items-center justify-between gap-4 pb-4">
        <div>
          <CardTitle className="text-xl">Create New Bot</CardTitle>
          <p className="text-xs text-gray-500 mt-1">Configure your bot</p>
        </div>
        {onCancel && (
          <button
            onClick={onCancel}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </CardHeader>

      <CardContent>
        <Form<BotFormData> methods={form} onSubmit={onSubmit}>
          <div className="space-y-4">
            {/* Basic Information */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                <Settings className="w-4 h-4 text-blue-600" />
                Basic Info
              </h4>

              <FormField
                control={form.control}
                name="botName"
                render={({ field }) => {
                  const { value, ...rest } = field;
                  return (
                    <FormItem>
                      <FormLabel className="text-xs font-medium text-gray-700">Bot Name</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="My Bot"
                          {...rest}
                          value={(value ?? '') as string}
                          className="h-8 text-sm border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                        />
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
                    <FormLabel className="text-xs font-medium text-gray-700">Exchange</FormLabel>
                    <FormControl>
                      <Select
                        value={(field.value ?? 'mexc') as string}
                        onChange={(e) => field.onChange(e.target.value)}
                        className="h-8 text-sm border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                      >
                        <option value="mexc">MEXC</option>
                        <option value="gate">Gate.io</option>
                        <option value="binance">Binance</option>
                      </Select>
                    </FormControl>
                    <FormMessage errors={form.formState.errors} name="exchange" />
                  </FormItem>
                )}
              />
            </div>

            {/* API Credentials */}
            <div className="space-y-3 pt-3 border-t border-gray-200">
              <h4 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                <Key className="w-4 h-4 text-amber-600" />
                API Keys
              </h4>

              <div className="bg-blue-50 border border-blue-200 rounded p-2 flex gap-2">
                <AlertCircle className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-blue-700">Keep credentials secure</p>
              </div>

              <FormField
                control={form.control}
                name="accessKey"
                render={({ field }) => {
                  const { value, ...rest } = field;
                  return (
                    <FormItem>
                      <FormLabel className="text-xs font-medium text-gray-700">
                        Access Key <span className="text-red-500">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          placeholder="Access key"
                          {...rest}
                          value={(value ?? '') as string}
                          className="h-8 text-sm border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                        />
                      </FormControl>
                      <FormMessage errors={form.formState.errors} name="accessKey" />
                    </FormItem>
                  );
                }}
              />

              <FormField
                control={form.control}
                name="secretKey"
                render={({ field }) => {
                  const { value, ...rest } = field;
                  return (
                    <FormItem>
                      <FormLabel className="text-xs font-medium text-gray-700">
                        Secret Key <span className="text-red-500">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          placeholder="Secret key"
                          {...rest}
                          value={(value ?? '') as string}
                          className="h-8 text-sm border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                        />
                      </FormControl>
                      <FormMessage errors={form.formState.errors} name="secretKey" />
                    </FormItem>
                  );
                }}
              />

              <div className="grid grid-cols-2 gap-2">
                <FormField
                  control={form.control}
                  name="uid"
                  render={({ field }) => {
                    const { value, ...rest } = field;
                    return (
                      <FormItem>
                        <FormLabel className="text-xs font-medium text-gray-700">UID</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Optional"
                            {...rest}
                            value={(value ?? '') as string}
                            className="h-8 text-sm border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                          />
                        </FormControl>
                        <FormMessage errors={form.formState.errors} name="uid" />
                      </FormItem>
                    );
                  }}
                />

                <FormField
                  control={form.control}
                  name="proxy"
                  render={({ field }) => {
                    const { value, ...rest } = field;
                    return (
                      <FormItem>
                        <FormLabel className="text-xs font-medium text-gray-700">Proxy</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Optional"
                            {...rest}
                            value={(value ?? '') as string}
                            className="h-8 text-sm border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                          />
                        </FormControl>
                        <FormMessage errors={form.formState.errors} name="proxy" />
                      </FormItem>
                    );
                  }}
                />
              </div>
            </div>

            {/* Trading Settings */}
            <div className="space-y-3 pt-3 border-t border-gray-200">
              <h4 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                <Zap className="w-4 h-4 text-green-600" />
                Trading
              </h4>

              <div className="grid grid-cols-2 gap-2">
                <FormField
                  control={form.control}
                  name="futureBalanceTarget"
                  render={({ field }) => {
                    const { value, onChange, ...rest } = field;
                    return (
                      <FormItem>
                        <FormLabel className="text-xs font-medium text-gray-700">Future Balance</FormLabel>
                        <FormControl>
                          <div className="relative">
                            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500 text-sm">$</span>
                            <Input
                              type="number"
                              {...rest}
                              value={(value ?? 0) as number | string}
                              onChange={(e) => onChange(Number(e.target.value))}
                              className="pl-5 h-8 text-sm border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                            />
                          </div>
                        </FormControl>
                        <FormMessage errors={form.formState.errors} name="futureBalanceTarget" />
                      </FormItem>
                    );
                  }}
                />

                <FormField
                  control={form.control}
                  name="spotBalanceThreshold"
                  render={({ field }) => {
                    const { value, onChange, ...rest } = field;
                    return (
                      <FormItem>
                        <FormLabel className="text-xs font-medium text-gray-700">Spot Balance</FormLabel>
                        <FormControl>
                          <div className="relative">
                            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500 text-sm">$</span>
                            <Input
                              type="number"
                              {...rest}
                              value={(value ?? 0) as number | string}
                              onChange={(e) => onChange(Number(e.target.value))}
                              className="pl-5 h-8 text-sm border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                            />
                          </div>
                        </FormControl>
                        <FormMessage errors={form.formState.errors} name="spotBalanceThreshold" />
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
                        <FormLabel className="text-xs font-medium text-gray-700">Transfer Freq</FormLabel>
                        <FormControl>
                          <div className="relative">
                            <Input
                              type="number"
                              {...rest}
                              value={(value ?? 0) as number | string}
                              onChange={(e) => onChange(Number(e.target.value))}
                              className="pr-8 h-8 text-sm border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                            />
                            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 text-xs">min</span>
                          </div>
                        </FormControl>
                        <FormMessage errors={form.formState.errors} name="transferFrequency" />
                      </FormItem>
                    );
                  }}
                />

                <FormField
                  control={form.control}
                  name="spotTransferThreshold"
                  render={({ field }) => {
                    const { value, onChange, ...rest } = field;
                    return (
                      <FormItem>
                        <FormLabel className="text-xs font-medium text-gray-700">Transfer Threshold</FormLabel>
                        <FormControl>
                          <div className="relative">
                            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500 text-sm">$</span>
                            <Input
                              type="number"
                              {...rest}
                              value={(value ?? 0) as number | string}
                              onChange={(e) => onChange(Number(e.target.value))}
                              className="pl-5 h-8 text-sm border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                            />
                          </div>
                        </FormControl>
                        <FormMessage errors={form.formState.errors} name="spotTransferThreshold" />
                      </FormItem>
                    );
                  }}
                />
              </div>
            </div>

            {/* Withdrawal Settings */}
            <div className="space-y-3 pt-3 border-t border-gray-200">
              <h4 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                <CreditCard className="w-4 h-4 text-purple-600" />
                Withdrawal
              </h4>

              <FormField
                control={form.control}
                name="withdrawEnabled"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between p-2 bg-gray-50 rounded border border-gray-200">
                    <FormLabel className="text-xs font-medium text-gray-700 cursor-pointer">
                      Auto Withdrawal
                    </FormLabel>
                    <FormControl>
                      <Switch
                        checked={Boolean(field.value)}
                        onClick={() => field.onChange(!field.value)}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              {form.watch('withdrawEnabled') && (
                <FormField
                  control={form.control}
                  name="withdrawAddress"
                  render={({ field }) => {
                    const { value, ...rest } = field;
                    return (
                      <FormItem>
                        <FormLabel className="text-xs font-medium text-gray-700">
                          Withdraw Address <span className="text-red-500">*</span>
                        </FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Wallet address"
                            {...rest}
                            value={(value ?? '') as string}
                            className="h-8 text-sm border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                          />
                        </FormControl>
                        <FormMessage errors={form.formState.errors} name="withdrawAddress" />
                      </FormItem>
                    );
                  }}
                />
              )}

              <FormField
                control={form.control}
                name="telegramChatId"
                render={({ field }) => {
                  const { value, ...rest } = field;
                  return (
                    <FormItem>
                      <FormLabel className="text-xs font-medium text-gray-700">Telegram ID</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Optional"
                          {...rest}
                          value={(value ?? '') as string}
                          className="h-8 text-sm border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                        />
                      </FormControl>
                      <FormMessage errors={form.formState.errors} name="telegramChatId" />
                    </FormItem>
                  );
                }}
              />
            </div>

            {/* Action Buttons */}
            <div className="flex gap-2 pt-4 border-t border-gray-200">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  form.reset();
                  onCancel?.();
                }}
                className="flex-1 h-8 text-sm"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                className="flex-1 h-8 text-sm bg-blue-600 hover:bg-blue-700 text-white"
              >
                Create
              </Button>
            </div>
          </div>
        </Form>
      </CardContent>
    </Card>
  );
}

