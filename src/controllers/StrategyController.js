import { Strategy } from '../models/Strategy.js';
import { Bot } from '../models/Bot.js';
import { validateSymbol, validateInterval, validateTradeType, validateAmount, validatePercentage } from '../utils/validator.js';
import logger from '../utils/logger.js';

/**
 * Strategy Controller
 */
export class StrategyController {
  /**
   * Get all strategies
   */
  static async getAll(req, res) {
    try {
      const botId = req.query.bot_id ? parseInt(req.query.bot_id) : null;
      const activeOnly = req.query.active === 'true';
      const strategies = await Strategy.findAll(botId, activeOnly);
      res.json({ success: true, data: strategies });
    } catch (error) {
      logger.error('Error getting strategies:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Get strategy by ID
   */
  static async getById(req, res) {
    try {
      const { id } = req.params;
      const strategy = await Strategy.findById(id);

      if (!strategy) {
        return res.status(404).json({ success: false, error: 'Strategy not found' });
      }

      res.json({ success: true, data: strategy });
    } catch (error) {
      logger.error('Error getting strategy:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Create new strategy
   */
  static async create(req, res) {
    try {
      const data = req.body;

      // Validate required fields
      if (!data.bot_id || !data.symbol || !data.interval) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
      }

      // Validate bot exists
      const bot = await Bot.findById(data.bot_id);
      if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
      }

      // Validate inputs
      if (!validateSymbol(data.symbol)) {
        return res.status(400).json({ success: false, error: 'Invalid symbol format' });
      }

      if (!validateInterval(data.interval)) {
        return res.status(400).json({ success: false, error: 'Invalid interval' });
      }

      if (data.trade_type && !validateTradeType(data.trade_type)) {
        return res.status(400).json({ success: false, error: 'Invalid trade type' });
      }

      if (!validateAmount(data.amount)) {
        return res.status(400).json({ success: false, error: 'Invalid amount' });
      }

      if (!validatePercentage(data.oc, 0, 100)) {
        return res.status(400).json({ success: false, error: 'Invalid OC value' });
      }

      if (!validatePercentage(data.extend, 0, 1000)) {
        return res.status(400).json({ success: false, error: 'Invalid extend value' });
      }

      if (!validatePercentage(data.take_profit, 0, 1000)) {
        return res.status(400).json({ success: false, error: 'Invalid take profit value' });
      }

      // Check if strategy already exists for this bot with the same unique key
      const existing = await Strategy.findByUniqueKey(
        data.bot_id,
        data.symbol,
        data.interval,
        (data.trade_type || 'both'),
        data.oc
      );
      if (existing) {
        return res.status(400).json({ success: false, error: 'Strategy already exists for this bot/symbol/interval/trade_type/oc' });
      }

      const strategy = await Strategy.create(data);
      res.status(201).json({ success: true, data: strategy });
    } catch (error) {
      logger.error('Error creating strategy:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Update strategy
   */
  static async update(req, res) {
    try {
      const { id } = req.params;
      const data = req.body;

      // Validate inputs if provided
      if (data.symbol && !validateSymbol(data.symbol)) {
        return res.status(400).json({ success: false, error: 'Invalid symbol format' });
      }

      if (data.interval && !validateInterval(data.interval)) {
        return res.status(400).json({ success: false, error: 'Invalid interval' });
      }

      if (data.trade_type && !validateTradeType(data.trade_type)) {
        return res.status(400).json({ success: false, error: 'Invalid trade type' });
      }

      if (data.amount && !validateAmount(data.amount)) {
        return res.status(400).json({ success: false, error: 'Invalid amount' });
      }

      const strategy = await Strategy.update(id, data);
      
      if (!strategy) {
        return res.status(404).json({ success: false, error: 'Strategy not found' });
      }

      res.json({ success: true, data: strategy });
    } catch (error) {
      logger.error('Error updating strategy:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Delete strategy
   */
  static async delete(req, res) {
    try {
      const { id } = req.params;
      const deleted = await Strategy.delete(id);

      if (!deleted) {
        return res.status(404).json({ success: false, error: 'Strategy not found' });
      }

      res.json({ success: true, message: 'Strategy deleted successfully' });
    } catch (error) {
      logger.error('Error deleting strategy:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }
}

