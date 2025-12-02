import express from 'express';
import botRoutes from './bot.routes.js';
import strategyRoutes from './strategy.routes.js';
import positionRoutes from './position.routes.js';
import priceAlertRoutes from './priceAlert.routes.js';
import { Bot } from '../models/Bot.js';
import { ExchangeService } from '../services/ExchangeService.js';
import { TransferService } from '../services/TransferService.js';
import { WithdrawService } from '../services/WithdrawService.js';
import { TelegramService } from '../services/TelegramService.js';
import logger from '../utils/logger.js';

const router = express.Router();

// API routes
router.use('/bots', botRoutes);
router.use('/strategies', strategyRoutes);
router.use('/positions', positionRoutes);
router.use('/price-alerts', priceAlertRoutes);

// Manual transfer endpoint
router.post('/transfer', async (req, res) => {
  try {
    const { bot_id, type, amount } = req.body;

    if (!bot_id || !type || !amount) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const bot = await Bot.findById(bot_id);
    if (!bot) {
      return res.status(404).json({ success: false, error: 'Bot not found' });
    }

    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();

    const telegramService = new TelegramService();
    await telegramService.initialize();

    const transferService = new TransferService(exchangeService, telegramService);

    let result;
    if (type === 'spot_to_future') {
      result = await transferService.transferSpotToFuture(bot, amount);
    } else if (type === 'future_to_spot') {
      result = await transferService.transferFutureToSpot(bot, amount);
    } else {
      return res.status(400).json({ success: false, error: 'Invalid transfer type' });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Error in transfer:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual withdraw endpoint
router.post('/withdraw', async (req, res) => {
  try {
    const { bot_id, amount, address, network } = req.body;

    if (!bot_id || !amount) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const bot = await Bot.findById(bot_id);
    if (!bot) {
      return res.status(404).json({ success: false, error: 'Bot not found' });
    }

    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();

    const telegramService = new TelegramService();
    await telegramService.initialize();

    const withdrawService = new WithdrawService(exchangeService, telegramService);
    const result = await withdrawService.withdraw(bot, amount, address, network);

    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Error in withdraw:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Stats endpoint
router.get('/stats', async (req, res) => {
  try {
    const { Position } = await import('../models/Position.js');
    const { Strategy } = await import('../models/Strategy.js');
    const { Bot } = await import('../models/Bot.js');

    const totalBots = (await Bot.findAll()).length;
    const activeBots = (await Bot.findAll(true)).length;
    const totalStrategies = (await Strategy.findAll()).length;
    const activeStrategies = (await Strategy.findAll(null, true)).length;
    const openPositions = (await Position.findOpen()).length;
    const closedPositions = (await Position.findAll({ status: 'closed' })).length;

    // Calculate total PnL
    const allPositions = await Position.findAll({ status: 'closed' });
    const totalPnL = allPositions.reduce((sum, p) => sum + (parseFloat(p.pnl) || 0), 0);

    res.json({
      success: true,
      data: {
        bots: { total: totalBots, active: activeBots },
        strategies: { total: totalStrategies, active: activeStrategies },
        positions: { open: openPositions, closed: closedPositions },
        totalPnL: totalPnL.toFixed(2)
      }
    });
  } catch (error) {
    logger.error('Error getting stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;

