import { create } from 'zustand';
import type { Bot } from '@/types/bot.types';

interface BotState {
  bots: Bot[];
  selectedBotId?: number;
  setBots: (bots: Bot[]) => void;
  selectBot: (id?: number) => void;
  updateBot: (bot: Bot) => void;
}

export const useBotStore = create<BotState>((set) => ({
  bots: [],
  selectedBotId: undefined,
  setBots: (bots) => set({ bots }),
  selectBot: (selectedBotId) => set({ selectedBotId }),
  updateBot: (bot) =>
    set((state) => ({
      bots: state.bots.map((b) => (b.id === bot.id ? bot : b)),
    })),
}));

