import type { Bot, BotFormData } from '@/types/bot.types';
import type { Strategy, StrategyFormData } from '@/types/strategy.types';
import type { Position } from '@/types/position.types';
import type { DashboardData, Transaction } from '@/types/common.types';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  const payload = await response.json();

  if (!response.ok) {
    const errorText = typeof payload === 'string' ? payload : payload?.error;
    throw new Error(errorText || 'Request failed');
  }

  if (payload && typeof payload === 'object' && 'success' in payload) {
    if (!payload.success) {
      throw new Error(payload.error || 'Request failed');
    }

    if ('data' in payload && payload.data !== undefined) {
      return payload.data as T;
    }

    if ('message' in payload) {
      return payload.message as T;
    }

    return undefined as T;
  }

  return payload as T;
}

export const api = {
  // Bots
  getBots: () => request<Bot[]>('/bots'),
  getBot: (id: number) => request<Bot>(`/bots/${id}`),
  createBot: (data: BotFormData) =>
    request<Bot>('/bots', { method: 'POST', body: JSON.stringify(data) }),
  updateBot: (id: number, data: Partial<BotFormData>) =>
    request<Bot>(`/bots/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteBot: (id: number) => request<void>(`/bots/${id}`, { method: 'DELETE' }),

  // Strategies
  getStrategies: () => request<Strategy[]>('/strategies'),
  createStrategy: (data: StrategyFormData) =>
    request<Strategy>('/strategies', { method: 'POST', body: JSON.stringify(data) }),
  updateStrategy: (id: number, data: Partial<StrategyFormData>) =>
    request<Strategy>(`/strategies/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteStrategy: (id: number) => request<void>(`/strategies/${id}`, { method: 'DELETE' }),

  // Positions
  getPositions: () => request<Position[]>('/positions'),
  closePosition: (id: number) =>
    request(`/positions/${id}/close`, { method: 'POST' }),

  // Transactions & stats
  getTransactions: () => request<Transaction[]>('/transactions'),
  getDashboard: async () => {
    const raw = await request<any>('/stats');

    if (raw?.stats) {
      return raw as DashboardData;
    }

    return {
      stats: {
        totalPnl: Number(raw?.totalPnL ?? 0),
        totalVolume: Number(raw?.totalVolume ?? 0),
        activeBots: Number(raw?.bots?.active ?? 0),
        winRate: Number(raw?.winRate ?? 0),
      },
      pnlSeries: raw?.pnlSeries ?? [],
      activeBots:
        raw?.activeBots ??
        (raw?.bots
          ? [
              {
                id: 0,
                name: 'All Bots',
                status: 'running',
                currentPnl: Number(raw.totalPnL ?? 0),
                activePositions: Number(raw?.positions?.open ?? 0),
              },
            ]
          : []),
      recentPositions: raw?.recentPositions ?? [],
    } satisfies DashboardData;
  },
};

