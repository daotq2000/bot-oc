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
import { AlertCircle, Key, Settings, Zap, CreditCard } from 'lucide-react';

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
      <div className="space-y-6">
        {/* Basic Information Section */}
        <div className="space-y-4">
          <div className="flex items-center gap-2 pb-3 border-b border-gray-200">
            <Settings className="w-5 h-5 text-blue-600" />
            <h3 className="text-lg font-semibold text-gray-900">Basic Information</h3>
          </div>
          
          <div className="grid grid-cols-1 gap-4">
            <FormField
              control={form.control}
              name="botName"
              render={({ field }) => {
                const { value, ...rest } = field;
                return (
                  <FormItem>
                    <FormLabel className="text-sm font-medium text-gray-700">
                      Bot Name
                      <Tooltip content="Choose a memorable name for your bot">
                        <span className="ml-2 text-gray-400 cursor-help">?</span>
                      </Tooltip>
                    </FormLabel>
                    <FormControl>
                      <Input 
                        placeholder="e.g., My Trading Bot" 
                        {...rest} 
                        value={(value ?? '') as string}
                        className="border-gray-300 focus:border-blue-500 focus:ring-blue-500"
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
                  <FormLabel className="text-sm font-medium text-gray-700">
                    Exchange
                    <Tooltip content="Select your trading exchange">
                      <span className="ml-2 text-gray-400 cursor-help">?</span>
                    </Tooltip>
                  </FormLabel>
                  <FormControl>
                    <Select 
                      value={(field.value ?? 'mexc') as string} 
                      onChange={(e) => field.onChange(e.target.value)}
                      className="border-gray-300 focus:border-blue-500 focus:ring-blue-500"
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
        </div>

        {/* API Credentials Section */}
        <div className="space-y-4">
          <div className="flex items-center gap-2 pb-3 border-b border-gray-200">
            <Key className="w-5 h-5 text-amber-600" />
            <h3 className="text-lg font-semibold text-gray-900">API Credentials</h3>
          </div>
          
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex gap-3">
            <AlertCircle className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-blue-700">
              Keep your API credentials secure. Never share them with anyone.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4">
            <FormField
              control={form.control}
              name="accessKey"
              render={({ field }) => {
                const { value, ...rest } = field;
                return (
                  <FormItem>
                    <FormLabel className="text-sm font-medium text-gray-700">
                      Access Key
                      <span className="text-red-500 ml-1">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input 
                        type="password"
                        placeholder="Enter your API access key" 
                        {...rest} 
                        value={(value ?? '') as string}
                        className="border-gray-300 focus:border-blue-500 focus:ring-blue-500"
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
                    <FormLabel className="text-sm font-medium text-gray-700">
                      Secret Key
                      <span className="text-red-500 ml-1">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input 
                        type="password"
                        placeholder="Enter your API secret key" 
                        {...rest} 
                        value={(value ?? '') as string}
                        className="border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                      />
                    </FormControl>
                    <FormMessage errors={form.formState.errors} name="secretKey" />
                  </FormItem>
                );
              }}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="uid"
                render={({ field }) => {
                  const { value, ...rest } = field;
                  return (
                    <FormItem>
                      <FormLabel className="text-sm font-medium text-gray-700">
                        UID
                        <Tooltip content="User ID (optional)">
                          <span className="ml-2 text-gray-400 cursor-help">?</span>
                        </Tooltip>
                      </FormLabel>
                      <FormControl>
                        <Input 
                          placeholder="Optional" 
                          {...rest} 
                          value={(value ?? '') as string}
                          className="border-gray-300 focus:border-blue-500 focus:ring-blue-500"
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
                      <FormLabel className="text-sm font-medium text-gray-700">
                        Proxy
                        <Tooltip content="Proxy address (optional)">
                          <span className="ml-2 text-gray-400 cursor-help">?</span>
                        </Tooltip>
                      </FormLabel>
                      <FormControl>
                        <Input 
                          placeholder="Optional" 
                          {...rest} 
                          value={(value ?? '') as string}
                          className="border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                        />
                      </FormControl>
                      <FormMessage errors={form.formState.errors} name="proxy" />
                    </FormItem>
                  );
                }}
              />
            </div>
          </div>
        </div>

        {/* Trading Settings Section */}
        <div className="space-y-4">
          <div className="flex items-center gap-2 pb-3 border-b border-gray-200">
            <Zap className="w-5 h-5 text-green-600" />
            <h3 className="text-lg font-semibold text-gray-900">Trading Settings</h3>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="futureBalanceTarget"
              render={({ field }) => {
                const { value, onChange, ...rest } = field;
                return (
                  <FormItem>
                    <FormLabel className="text-sm font-medium text-gray-700">
                      Future Balance Target
                      <Tooltip content="Target balance for futures trading">
                        <span className="ml-2 text-gray-400 cursor-help">?</span>
                      </Tooltip>
                    </FormLabel>
                    <FormControl>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                        <Input
                          type="number"
                          {...rest}
                          value={(value ?? 0) as number | string}
                          onChange={(e) => onChange(Number(e.target.value))}
                          className="pl-7 border-gray-300 focus:border-blue-500 focus:ring-blue-500"
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
                    <FormLabel className="text-sm font-medium text-gray-700">
                      Spot Balance Threshold
                      <Tooltip content="Minimum spot balance threshold">
                        <span className="ml-2 text-gray-400 cursor-help">?</span>
                      </Tooltip>
                    </FormLabel>
                    <FormControl>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                        <Input
                          type="number"
                          {...rest}
                          value={(value ?? 0) as number | string}
                          onChange={(e) => onChange(Number(e.target.value))}
                          className="pl-7 border-gray-300 focus:border-blue-500 focus:ring-blue-500"
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
                    <FormLabel className="text-sm font-medium text-gray-700">
                      Transfer Frequency
                      <Tooltip content="How often to transfer funds (minutes)">
                        <span className="ml-2 text-gray-400 cursor-help">?</span>
                      </Tooltip>
                    </FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Input
                          type="number"
                          {...rest}
                          value={(value ?? 0) as number | string}
                          onChange={(e) => onChange(Number(e.target.value))}
                          className="pr-12 border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">min</span>
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
                    <FormLabel className="text-sm font-medium text-gray-700">
                      Spot Transfer Threshold
                      <Tooltip content="Threshold for spot transfers">
                        <span className="ml-2 text-gray-400 cursor-help">?</span>
                      </Tooltip>
                    </FormLabel>
                    <FormControl>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                        <Input
                          type="number"
                          {...rest}
                          value={(value ?? 0) as number | string}
                          onChange={(e) => onChange(Number(e.target.value))}
                          className="pl-7 border-gray-300 focus:border-blue-500 focus:ring-blue-500"
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

        {/* Withdrawal Settings Section */}
        <div className="space-y-4">
          <div className="flex items-center gap-2 pb-3 border-b border-gray-200">
            <CreditCard className="w-5 h-5 text-purple-600" />
            <h3 className="text-lg font-semibold text-gray-900">Withdrawal Settings</h3>
          </div>

          <FormField
            control={form.control}
            name="withdrawEnabled"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border border-gray-200">
                <div>
                  <FormLabel className="text-sm font-medium text-gray-700 cursor-pointer">
                    Enable Auto Withdrawal
                  </FormLabel>
                  <p className="text-xs text-gray-500 mt-1">
                    Automatically withdraw excess funds to your wallet
                  </p>
                </div>
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
                    <FormLabel className="text-sm font-medium text-gray-700">
                      Withdrawal Address
                      <span className="text-red-500 ml-1">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input 
                        placeholder="Enter your withdrawal wallet address" 
                        {...rest} 
                        value={(value ?? '') as string}
                        className="border-gray-300 focus:border-blue-500 focus:ring-blue-500"
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
                  <FormLabel className="text-sm font-medium text-gray-700">
                    Telegram Chat ID
                    <Tooltip content="Optional: Receive notifications on Telegram">
                      <span className="ml-2 text-gray-400 cursor-help">?</span>
                    </Tooltip>
                  </FormLabel>
                  <FormControl>
                    <Input 
                      placeholder="Optional" 
                      {...rest} 
                      value={(value ?? '') as string}
                      className="border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                    />
                  </FormControl>
                  <FormMessage errors={form.formState.errors} name="telegramChatId" />
                </FormItem>
              );
            }}
          />
        </div>

        {/* Action Buttons */}
        <div className="flex justify-end gap-3 pt-6 border-t border-gray-200">
          <Button 
            type="button" 
            variant="outline" 
            onClick={() => form.reset()}
            className="px-6"
          >
            Cancel
          </Button>
          <Button 
            type="submit"
            className="px-6 bg-blue-600 hover:bg-blue-700 text-white"
          >
            Create Bot
          </Button>
        </div>
      </div>
    </Form>
  );
}

