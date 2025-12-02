export type TradeType = 'long' | 'short' | 'both';
export type StrategyInterval = '1m' | '3m' | '5m' | '15m' | '30m' | '1h';

export interface Strategy {
  id: number;
  botId: number;
  symbol: string;
  tradeType: TradeType;
  interval: StrategyInterval;
  oc: number;
  extend: number;
  amount: number;
  takeProfit: number;
  reduce: number;
  upReduce: number;
  ignore: number;
  isActive: boolean;
  stats?: {
    openPositions: number;
    todayPnl: number;
  };
}

export interface StrategyFormData {
  symbol: string;
  tradeType: TradeType;
  interval: StrategyInterval;
  oc: number;
  extend: number;
  amount: number;
  takeProfit: number;
  reduce: number;
  upReduce: number;
  ignore: number;
  isActive: boolean;
}

