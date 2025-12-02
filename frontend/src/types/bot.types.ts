export interface Bot {
  id: number;
  botName: string;
  exchange: 'mexc' | 'gate' | 'binance';
  uid?: string;
  proxy?: string;
  telegramChatId?: string;
  futureBalanceTarget: number;
  transferFrequency: number;
  spotTransferThreshold: number;
  withdrawEnabled: boolean;
  withdrawAddress?: string;
  spotBalanceThreshold: number;
  isActive: boolean;
  stats?: BotStats;
}

export interface BotStats {
  pnl24h: number;
  pnlAll: number;
  openPositions: number;
  strategies: number;
  status: 'running' | 'paused' | 'error';
}

export interface BotFormData {
  botName: string;
  exchange: 'mexc' | 'gate' | 'binance';
  uid?: string;
  accessKey: string;
  secretKey: string;
  proxy?: string;
  futureBalanceTarget: number;
  transferFrequency: number;
  spotTransferThreshold: number;
  withdrawEnabled: boolean;
  withdrawAddress?: string;
  spotBalanceThreshold: number;
  telegramChatId?: string;
}

