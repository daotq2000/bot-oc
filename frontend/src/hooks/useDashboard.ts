import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';

export function useDashboard() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: api.getDashboard,
    refetchInterval: 30000,
  });
}

