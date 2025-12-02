import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import { useStrategyStore } from '@/store/strategyStore';
import type { Strategy, StrategyFormData } from '@/types/strategy.types';

export function useStrategies() {
  const setStrategies = useStrategyStore((state) => state.setStrategies);
  const query = useQuery<Strategy[]>({
    queryKey: ['strategies'],
    queryFn: api.getStrategies,
    refetchInterval: 30000,
  });

  useEffect(() => {
    if (query.data) {
      setStrategies(query.data);
    }
  }, [query.data, setStrategies]);

  return query;
}

export function useCreateStrategy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: StrategyFormData) => api.createStrategy(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['strategies'] });
    },
  });
}

export function useUpdateStrategy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<StrategyFormData> }) =>
      api.updateStrategy(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['strategies'] });
    },
  });
}

export function useDeleteStrategy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteStrategy(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['strategies'] }),
  });

}
