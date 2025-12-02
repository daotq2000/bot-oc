import { Telegraf } from 'telegraf';
import { Bot } from '../models/Bot.js';
import { Strategy } from '../models/Strategy.js';
import { Position } from '../models/Position.js';
import { ExchangeService } from '../services/ExchangeService.js';
import logger from '../utils/logger.js';

/**
 * Telegram Bot - Command handlers
 */
export class TelegramBot {
  constructor() {
    this.bot = null;
    this.initialized = false;
  }

  /**
   * Initialize Telegram bot
   */
  async initialize() {
    try {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        logger.warn('Telegram bot token not configured');
        return false;
      }

      this.bot = new Telegraf(token);
      this.setupCommands();
      this.initialized = true;
      
      logger.info('Telegram bot initialized');
      return true;
    } catch (error) {
      logger.error('Failed to initialize Telegram bot:', error);
      return false;
    }
  }

  /**
   * Setup command handlers
   */
  setupCommands() {
    // Start command
    this.bot.start((ctx) => {
      ctx.reply('Welcome to Bot OC Trading System!\n\nUse /help to see available commands.');
    });

    // Help command
    this.bot.help((ctx) => {
      const helpText = `
<b>Available Commands:</b>

/status - Show bot status
/bots - List all bots
/strategies - List all strategies
/positions - Show open positions
/balance [bot_id] - Get balance for bot
/stats - Show trading statistics

<i>Use /help [command] for more details</i>
      `.trim();
      ctx.reply(helpText, { parse_mode: 'HTML' });
    });

    // Status command
    this.bot.command('status', async (ctx) => {
      try {
        const { Bot } = await import('../models/Bot.js');
        const { Strategy } = await import('../models/Strategy.js');
        const { Position } = await import('../models/Position.js');

        const totalBots = (await Bot.findAll()).length;
        const activeBots = (await Bot.findAll(true)).length;
        const totalStrategies = (await Strategy.findAll()).length;
        const activeStrategies = (await Strategy.findAll(null, true)).length;
        const openPositions = (await Position.findOpen()).length;

        const status = `
<b>System Status</b>

Bots: ${activeBots}/${totalBots} active
Strategies: ${activeStrategies}/${totalStrategies} active
Open Positions: ${openPositions}
        `.trim();

        ctx.reply(status, { parse_mode: 'HTML' });
      } catch (error) {
        logger.error('Error in status command:', error);
        ctx.reply('Error getting status');
      }
    });

    // Bots command
    this.bot.command('bots', async (ctx) => {
      try {
        const bots = await Bot.findAll();
        
        if (bots.length === 0) {
          ctx.reply('No bots configured');
          return;
        }

        const botList = bots.map(bot => {
          const status = bot.is_active ? '✅' : '❌';
          return `${status} <b>${bot.bot_name}</b> (${bot.exchange}) - ID: ${bot.id}`;
        }).join('\n');

        ctx.reply(`<b>Bots:</b>\n\n${botList}`, { parse_mode: 'HTML' });
      } catch (error) {
        logger.error('Error in bots command:', error);
        ctx.reply('Error getting bots');
      }
    });

    // Strategies command
    this.bot.command('strategies', async (ctx) => {
      try {
        const strategies = await Strategy.findAll(null, true);
        
        if (strategies.length === 0) {
          ctx.reply('No active strategies');
          return;
        }

        const strategyList = strategies.slice(0, 10).map(strategy => {
          return `<b>${strategy.symbol}</b> ${strategy.interval} | OC: ${strategy.oc}% | Amount: $${strategy.amount}`;
        }).join('\n');

        const more = strategies.length > 10 ? `\n\n... and ${strategies.length - 10} more` : '';
        ctx.reply(`<b>Active Strategies:</b>\n\n${strategyList}${more}`, { parse_mode: 'HTML' });
      } catch (error) {
        logger.error('Error in strategies command:', error);
        ctx.reply('Error getting strategies');
      }
    });

    // Positions command
    this.bot.command('positions', async (ctx) => {
      try {
        const positions = await Position.findOpen();
        
        if (positions.length === 0) {
          ctx.reply('No open positions');
          return;
        }

        const positionList = positions.slice(0, 10).map(pos => {
          const sideEmoji = pos.side === 'long' ? '🟢' : '🔴';
          const pnl = parseFloat(pos.pnl || 0);
          const pnlText = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
          return `${sideEmoji} <b>${pos.symbol}</b> ${pos.side.toUpperCase()} | Entry: $${parseFloat(pos.entry_price).toFixed(2)} | PnL: ${pnlText}`;
        }).join('\n');

        const more = positions.length > 10 ? `\n\n... and ${positions.length - 10} more` : '';
        ctx.reply(`<b>Open Positions:</b>\n\n${positionList}${more}`, { parse_mode: 'HTML' });
      } catch (error) {
        logger.error('Error in positions command:', error);
        ctx.reply('Error getting positions');
      }
    });

    // Balance command
    this.bot.command('balance', async (ctx) => {
      try {
        const args = ctx.message.text.split(' ');
        const botId = args[1] ? parseInt(args[1]) : null;

        if (!botId) {
          ctx.reply('Usage: /balance [bot_id]');
          return;
        }

        const bot = await Bot.findById(botId);
        if (!bot) {
          ctx.reply('Bot not found');
          return;
        }

        const exchangeService = new ExchangeService(bot);
        await exchangeService.initialize();

        const spotBalance = await exchangeService.getBalance('spot');
        const futureBalance = await exchangeService.getBalance('future');

        const balance = `
<b>Balance for ${bot.bot_name}</b>

Spot: $${spotBalance.free.toFixed(2)} / $${spotBalance.total.toFixed(2)}
Futures: $${futureBalance.free.toFixed(2)} / $${futureBalance.total.toFixed(2)}
        `.trim();

        ctx.reply(balance, { parse_mode: 'HTML' });
      } catch (error) {
        logger.error('Error in balance command:', error);
        ctx.reply('Error getting balance');
      }
    });

    // Stats command
    this.bot.command('stats', async (ctx) => {
      try {
        const { Position } = await import('../models/Position.js');
        
        const openPositions = await Position.findOpen();
        const closedPositions = await Position.findAll({ status: 'closed' });

        const totalPnL = closedPositions.reduce((sum, p) => sum + (parseFloat(p.pnl) || 0), 0);
        const winCount = closedPositions.filter(p => parseFloat(p.pnl || 0) > 0).length;
        const lossCount = closedPositions.filter(p => parseFloat(p.pnl || 0) < 0).length;
        const winRate = closedPositions.length > 0 ? (winCount / closedPositions.length * 100).toFixed(2) : 0;

        const stats = `
<b>Trading Statistics</b>

Open Positions: ${openPositions.length}
Closed Positions: ${closedPositions.length}
Total PnL: $${totalPnL.toFixed(2)}
Win Rate: ${winRate}% (${winCount}W / ${lossCount}L)
        `.trim();

        ctx.reply(stats, { parse_mode: 'HTML' });
      } catch (error) {
        logger.error('Error in stats command:', error);
        ctx.reply('Error getting stats');
      }
    });

    // Error handling
    this.bot.catch((err, ctx) => {
      logger.error('Telegram bot error:', err);
      ctx.reply('An error occurred. Please try again.');
    });
  }

  /**
   * Start the bot
   */
  async start() {
    if (!this.initialized) {
      await this.initialize();
    }

    if (this.bot) {
      await this.bot.launch();
      logger.info('Telegram bot started');
    }
  }

  /**
   * Stop the bot
   */
  async stop() {
    if (this.bot) {
      try {
        this.bot.stop();
        logger.info('Telegram bot stopped');
      } catch (error) {
        // Bot may already be stopped, ignore error
        if (!error.message?.includes('not running')) {
          logger.warn('Error stopping Telegram bot:', error.message);
        }
      }
    }
  }
}

