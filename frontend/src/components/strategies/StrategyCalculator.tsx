import { useState, useMemo } from 'react';
import type { StrategyFormData } from '@/types/strategy.types';
import { calculateStrategy } from '@/utils/calculations';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

interface StrategyCalculatorProps {
  formValues: StrategyFormData;
}

export function StrategyCalculator({ formValues }: StrategyCalculatorProps) {
  const [openPrice, setOpenPrice] = useState(50000);
  const calc = useMemo(
    () =>
      calculateStrategy({
        openPrice,
        oc: formValues.oc,
        extend: formValues.extend,
        amount: formValues.amount,
        takeProfit: formValues.takeProfit,
      }),
    [openPrice, formValues]
  );

  return (
    <Card className="bg-gradient-to-br from-blue-50 to-purple-50 dark:from-gray-900 dark:to-gray-950">
      <CardHeader>
        <CardTitle>Strategy Calculator</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-sm text-gray-600 mb-1">Simulated Open Price ($)</p>
          <Input
            type="number"
            value={openPrice}
            onChange={(e) => setOpenPrice(Number(e.target.value))}
          />
        </div>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="p-4 rounded-2xl bg-white/80 dark:bg-gray-900/80 shadow-sm space-y-2">
            <p className="font-semibold text-green-600">LONG Signal</p>
            <p>Entry: ${calc.longEntry.toFixed(2)}</p>
            <p>Take Profit: ${calc.longTP.toFixed(2)}</p>
            <p className="text-green-600 font-semibold">Profit: +${calc.longProfit.toFixed(2)}</p>
          </div>
          <div className="p-4 rounded-2xl bg-white/80 dark:bg-gray-900/80 shadow-sm space-y-2">
            <p className="font-semibold text-red-500">SHORT Signal</p>
            <p>Entry: ${calc.shortEntry.toFixed(2)}</p>
            <p>Take Profit: ${calc.shortTP.toFixed(2)}</p>
            <p className="text-red-500 font-semibold">Profit: +${calc.shortProfit.toFixed(2)}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

