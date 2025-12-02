export interface StatsSummary {
  totalPnl: number;
  totalVolume: number;
  activeBots: number;
  winRate: number;
}

export interface DashboardData {
  stats: StatsSummary;
  pnlSeries: Array<{ date: string; pnl: number }>;
  activeBots: Array<{
    id: number;
    name: string;
    status: 'running' | 'paused' | 'error';
    currentPnl: number;
    activePositions: number;
  }>;
  recentPositions: Array<{
    id: number;
    symbol: string;
    side: 'long' | 'short';
    entryPrice: number;
    pnl: number;
    status: 'closed' | 'open';
    timestamp: string;
  }>;
}

export interface Transaction {
  id: number;
  botId: number;
  type: 'spot_to_future' | 'future_to_spot' | 'withdraw';
  amount: number;
  status: 'pending' | 'success' | 'failed';
  createdAt: string;
}

