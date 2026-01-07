import type { Bot } from '@/types/bot.types';
import { EmptyState } from '@/components/common/EmptyState';
import { Loader2, Eye, Pencil } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';

interface BotListProps {
  bots?: Bot[];
  isLoading?: boolean;
  onView?: (bot: Bot) => void;
  onEdit?: (bot: Bot) => void;
  onToggleActive?: (bot: Bot, nextActive: boolean) => void;
}

export function BotList({ bots, isLoading, onView, onEdit, onToggleActive }: BotListProps) {
  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
      </div>
    );
  }

  if (!bots?.length) {
    return <EmptyState title="No bots yet" description="Create your first bot to get started." />;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[120px]">Action</TableHead>
          <TableHead>Name</TableHead>
          <TableHead>Exchange</TableHead>
          <TableHead>Access Key</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {bots.map((bot) => {
          const anyBot: any = bot as any;
          const isActive = (bot as any).isActive ?? Boolean(anyBot.is_active);
          const name = (bot as any).botName ?? anyBot.bot_name ?? '';
          const exchange = (bot as any).exchange ?? anyBot.exchange ?? '';
          const accessKey = (bot as any).accessKey ?? anyBot.access_key ?? '';
          return (
            <TableRow key={bot.id}>
              <TableCell>
                <div className="flex items-center gap-3">
                  <Switch checked={isActive} onClick={() => onToggleActive?.(bot, !isActive)} />
                  <button
                    aria-label="Edit"
                    className="text-gray-600 hover:text-blue-600"
                    onClick={() => onEdit?.(bot)}
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                </div>
              </TableCell>
              <TableCell className="font-medium">{name}</TableCell>
              <TableCell className="uppercase">{String(exchange)}</TableCell>
              <TableCell className="font-mono truncate max-w-[360px]" title={accessKey}>
                {accessKey || '-'}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

