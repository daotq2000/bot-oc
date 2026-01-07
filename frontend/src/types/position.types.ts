export type PositionSide = 'long' | 'short';
export type PositionStatus = 'open' | 'closed' | 'cancelled';

export interface Position {
  id: number;
  strategyId: number;
  botId: number;
  symbol: string;
  side: PositionSide;
  entryPrice: number;
  currentPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  amount: number;
  pnl: number;
  status: PositionStatus;
  openedAt: string;
  closedAt?: string;
  closeReason?: 'tp_hit' | 'sl_hit' | 'manual' | 'candle_end';
}

export interface PositionMetrics {
  totalOpen: number;
  totalClosed: number;
  winRate: number;
  pnl24h: number;
}

