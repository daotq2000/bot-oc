import toast from 'react-hot-toast';
import type { Position } from '@/types/position.types';

export const notify = {
  positionOpened: (position: Position) => {
    toast.success(
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
          {position.side === 'long' ? '🟢' : '🔴'}
        </div>
        <div>
          <p className="font-semibold">Position Opened</p>
          <p className="text-sm text-gray-600">
            {position.side.toUpperCase()} {position.symbol} @ ${position.entryPrice.toFixed(2)}
          </p>
        </div>
      </div>,
      { duration: 4000 }
    );
  },
  positionClosed: (position: Position, pnl: number) => {
    const isProfit = pnl >= 0;
    toast[isProfit ? 'success' : 'error'](
      <div className="flex items-start gap-3">
        <div
          className={`w-10 h-10 ${isProfit ? 'bg-green-100' : 'bg-red-100'} rounded-full flex items-center justify-center`}
        >
          {isProfit ? '✅' : '❌'}
        </div>
        <div>
          <p className="font-semibold">Position Closed</p>
          <p className="text-sm">
            {position.symbol}{' '}
            <span className={`font-bold ml-1 ${isProfit ? 'text-green-600' : 'text-red-600'}`}>
              {isProfit ? '+' : ''}
              ${pnl.toFixed(2)}
            </span>
          </p>
        </div>
      </div>,
      { duration: 5000 }
    );
  },
  balanceTransfer: (type: string, amount: number) => {
    toast.custom(
      <div className="rounded-lg bg-white dark:bg-gray-900 p-4 shadow-xl border border-gray-100 dark:border-gray-800">
        <p className="font-semibold">💸 Balance Transfer</p>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {type}: ${amount.toFixed(2)}
        </p>
      </div>,
      { duration: 4000 }
    );
  },
  error: (message: string) => toast.error(message),
};

