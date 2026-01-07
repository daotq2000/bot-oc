import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { getSocket } from '@/services/websocket';
import { notify } from '@/utils/notifications';

export function useRealTimeUpdates() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const socket = getSocket();

    socket.on('position:opened', (position) => {
      notify.positionOpened(position);
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    });

    socket.on('position:closed', ({ position, pnl }) => {
      notify.positionClosed(position, pnl);
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    });

    socket.on('balance:update', () => {
      queryClient.invalidateQueries({ queryKey: ['bots'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
    });

    return () => {
      socket.off('position:opened');
      socket.off('position:closed');
      socket.off('balance:update');
    };
  }, [queryClient]);
}

