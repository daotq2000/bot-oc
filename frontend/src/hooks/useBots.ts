import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import { useBotStore } from '@/store/botStore';
import type { Bot, BotFormData } from '@/types/bot.types';

export function useBots() {
  const setBots = useBotStore((state) => state.setBots);
  const query = useQuery<Bot[]>({
    queryKey: ['bots'],
    queryFn: api.getBots,
    refetchInterval: 30000,
  });

  useEffect(() => {
    if (query.data) {
      setBots(query.data);
    }
  }, [query.data, setBots]);

  return query;
}

export function useBot(id?: number) {
  return useQuery<Bot>({
    queryKey: ['bots', id],
    queryFn: () => api.getBot(id!),
    enabled: !!id,
  });
}

export function useCreateBot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: BotFormData) => api.createBot(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bots'] });
    },
  });
}

export function useUpdateBot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<BotFormData> }) =>
      api.updateBot(id, data),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['bots'] });
      queryClient.invalidateQueries({ queryKey: ['bots', id] });
    },
  });
}

export function useDeleteBot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteBot(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['bots'] }),
  });
}

