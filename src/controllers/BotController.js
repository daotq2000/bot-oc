import { Bot } from '../models/Bot.js';
import { validateExchange, validateProxy } from '../utils/validator.js';
import logger from '../utils/logger.js';

/**
 * Bot Controller
 */
export class BotController {
  /**
   * Get all bots
   */
  static async getAll(req, res) {
    try {
      const activeOnly = req.query.active === 'true';
      const bots = await Bot.findAll(activeOnly);
      res.json({ success: true, data: bots });
    } catch (error) {
      logger.error('Error getting bots:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Get bot by ID
   */
  static async getById(req, res) {
    try {
      const { id } = req.params;
      const bot = await Bot.findById(id);

      if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
      }

      res.json({ success: true, data: bot });
    } catch (error) {
      logger.error('Error getting bot:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Create new bot
   */
  static async create(req, res) {
    try {
      const data = req.body;

      // Validate exchange
      if (!validateExchange(data.exchange)) {
        return res.status(400).json({ success: false, error: 'Invalid exchange' });
      }

      // Validate proxy if provided
      if (data.proxy && !validateProxy(data.proxy)) {
        return res.status(400).json({ success: false, error: 'Invalid proxy format (IP:PORT:USER:PASS)' });
      }

      // Required fields
      if (!data.bot_name || !data.access_key || !data.secret_key) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
      }

      const bot = await Bot.create(data);
      res.status(201).json({ success: true, data: bot });
    } catch (error) {
      logger.error('Error creating bot:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Update bot
   */
  static async update(req, res) {
    try {
      const { id } = req.params;
      const data = req.body;

      // Validate exchange if provided
      if (data.exchange && !validateExchange(data.exchange)) {
        return res.status(400).json({ success: false, error: 'Invalid exchange' });
      }

      // Validate proxy if provided
      if (data.proxy && !validateProxy(data.proxy)) {
        return res.status(400).json({ success: false, error: 'Invalid proxy format' });
      }

      const bot = await Bot.update(id, data);
      
      if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
      }

      res.json({ success: true, data: bot });
    } catch (error) {
      logger.error('Error updating bot:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Delete bot
   */
  static async delete(req, res) {
    try {
      const { id } = req.params;
      const deleted = await Bot.delete(id);

      if (!deleted) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
      }

      res.json({ success: true, message: 'Bot deleted successfully' });
    } catch (error) {
      logger.error('Error deleting bot:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }
}

