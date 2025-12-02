import { Position } from '../models/Position.js';
import { OrderService } from '../services/OrderService.js';
import { ExchangeService } from '../services/ExchangeService.js';
import { TelegramService } from '../services/TelegramService.js';
import { Bot } from '../models/Bot.js';
import logger from '../utils/logger.js';

/**
 * Position Controller
 */
export class PositionController {
  /**
   * Get all positions
   */
  static async getAll(req, res) {
    try {
      const filters = {};
      
      if (req.query.status) {
        filters.status = req.query.status;
      }
      
      if (req.query.symbol) {
        filters.symbol = req.query.symbol;
      }
      
      if (req.query.strategy_id) {
        filters.strategy_id = parseInt(req.query.strategy_id);
      }

      const positions = await Position.findAll(filters);
      res.json({ success: true, data: positions });
    } catch (error) {
      logger.error('Error getting positions:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Get position by ID
   */
  static async getById(req, res) {
    try {
      const { id } = req.params;
      const position = await Position.findById(id);

      if (!position) {
        return res.status(404).json({ success: false, error: 'Position not found' });
      }

      res.json({ success: true, data: position });
    } catch (error) {
      logger.error('Error getting position:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Close position manually
   */
  static async close(req, res) {
    try {
      const { id } = req.params;
      const position = await Position.findById(id);

      if (!position) {
        return res.status(404).json({ success: false, error: 'Position not found' });
      }

      if (position.status !== 'open') {
        return res.status(400).json({ success: false, error: 'Position is not open' });
      }

      // Get bot and initialize services
      const { Strategy } = await import('../models/Strategy.js');
      const strategy = await Strategy.findById(position.strategy_id);
      if (!strategy) {
        return res.status(404).json({ success: false, error: 'Strategy not found' });
      }

      const bot = await Bot.findById(strategy.bot_id);
      if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
      }

      const exchangeService = new ExchangeService(bot);
      await exchangeService.initialize();

      const telegramService = new TelegramService();
      await telegramService.initialize();

      const orderService = new OrderService(exchangeService, telegramService);
      const closed = await orderService.closePosition(position);

      res.json({ success: true, data: closed });
    } catch (error) {
      logger.error('Error closing position:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }
}

