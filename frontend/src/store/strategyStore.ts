import { create } from 'zustand';
import type { Strategy } from '@/types/strategy.types';

interface StrategyState {
  strategies: Strategy[];
  setStrategies: (strategies: Strategy[]) => void;
}

export const useStrategyStore = create<StrategyState>((set) => ({
  strategies: [],
  setStrategies: (strategies) => set({ strategies }),
}));

