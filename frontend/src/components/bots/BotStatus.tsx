import { Badge } from '@/components/ui/badge';

interface BotStatusProps {
  status: 'running' | 'paused' | 'error';
}

export function BotStatus({ status }: BotStatusProps) {
  const variant = status === 'running' ? 'success' : status === 'paused' ? 'info' : 'destructive';
  return <Badge variant={variant}>{status}</Badge>;
}

