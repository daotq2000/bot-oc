import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export const getSocket = () => {
  if (!socket) {
    const url = import.meta.env.VITE_WS_URL ?? window.location.origin;
    socket = io(url, { transports: ['websocket'] });
  }
  return socket;
};

export const disconnectSocket = () => {
  socket?.disconnect();
  socket = null;
};

