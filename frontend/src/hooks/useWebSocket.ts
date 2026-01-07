import { useEffect } from 'react';
import { getSocket, disconnectSocket } from '@/services/websocket';

export function useWebSocket(events?: Record<string, (...args: any[]) => void>) {
  useEffect(() => {
    const socket = getSocket();
    if (events) {
      Object.entries(events).forEach(([event, handler]) => socket.on(event, handler));
    }
    return () => {
      if (events) {
        Object.entries(events).forEach(([event, handler]) => socket.off(event, handler));
      }
      disconnectSocket();
    };
  }, [events]);
}

