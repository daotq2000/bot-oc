import type { Bot } from '@/types/bot.types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BotStatus } from './BotStatus';
import { BotStats } from './BotStats';
import { Button } from '@/components/ui/button';

interface BotCardProps {
  bot: Bot;
  onView?: (bot: Bot) => void;
  onEdit?: (bot: Bot) => void;
}

export function BotCard({ bot, onView, onEdit }: BotCardProps) {
  return (
    <Card className="flex flex-col">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>{bot.botName}</CardTitle>
          <p className="text-sm text-gray-500">{bot.exchange.toUpperCase()}</p>
        </div>
        <BotStatus status={bot.stats?.status ?? 'running'} />
      </CardHeader>
      <CardContent className="flex-1 flex flex-col gap-4">
        <BotStats bot={bot} />
        <div className="flex gap-2 mt-auto">
          <Button variant="outline" className="flex-1" onClick={() => onView?.(bot)}>
            View
          </Button>
          <Button variant="default" className="flex-1" onClick={() => onEdit?.(bot)}>
            Edit
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

