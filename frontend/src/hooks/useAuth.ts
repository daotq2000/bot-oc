import { useState } from 'react';

export function useAuth() {
  const [user] = useState({ name: 'Admin' });
  return { user, isAuthenticated: true };
}

