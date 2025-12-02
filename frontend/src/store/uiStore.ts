import { create } from 'zustand';

interface UIState {
  filterBotId?: number;
  filterSymbol?: string;
  autoRefresh: boolean;
  setFilterBotId: (id?: number) => void;
  setFilterSymbol: (symbol?: string) => void;
  toggleAutoRefresh: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  autoRefresh: true,
  setFilterBotId: (filterBotId) => set({ filterBotId }),
  setFilterSymbol: (filterSymbol) => set({ filterSymbol }),
  toggleAutoRefresh: () => set((state) => ({ autoRefresh: !state.autoRefresh })),
}));

