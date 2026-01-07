import express from 'express';
import { PriceAlertConfig } from '../models/PriceAlertConfig.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * GET /api/price-alerts
 * Get all price alert configs
 */
router.get('/', async (req, res) => {
  try {
    const { exchange } = req.query;
    const configs = await PriceAlertConfig.findAll(exchange);
    res.json({ success: true, data: configs });
  } catch (error) {
    logger.error('Error getting price alerts:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/price-alerts/:id
 * Get price alert config by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const config = await PriceAlertConfig.findById(parseInt(req.params.id));
    if (!config) {
      return res.status(404).json({ success: false, error: 'Price alert config not found' });
    }
    res.json({ success: true, data: config });
  } catch (error) {
    logger.error('Error getting price alert:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/price-alerts
 * Create new price alert config
 */
router.post('/', async (req, res) => {
  try {
    const { exchange, symbols, intervals, threshold, telegram_chat_id, is_active } = req.body;

    if (!exchange || !symbols || !intervals || !threshold || !telegram_chat_id) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: exchange, symbols, intervals, threshold, telegram_chat_id'
      });
    }

    // Validate symbols and intervals are arrays
    if (!Array.isArray(symbols) || !Array.isArray(intervals)) {
      return res.status(400).json({
        success: false,
        error: 'symbols and intervals must be arrays'
      });
    }

    const config = await PriceAlertConfig.create({
      exchange,
      symbols,
      intervals,
      threshold: parseFloat(threshold),
      telegram_chat_id,
      is_active: is_active !== undefined ? is_active : true
    });

    res.json({ success: true, data: config });
  } catch (error) {
    logger.error('Error creating price alert:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/price-alerts/:id
 * Update price alert config
 */
router.put('/:id', async (req, res) => {
  try {
    const { symbols, intervals, threshold, telegram_chat_id, is_active } = req.body;

    const updateData = {};
    if (symbols !== undefined) updateData.symbols = symbols;
    if (intervals !== undefined) updateData.intervals = intervals;
    if (threshold !== undefined) updateData.threshold = parseFloat(threshold);
    if (telegram_chat_id !== undefined) updateData.telegram_chat_id = telegram_chat_id;
    if (is_active !== undefined) updateData.is_active = is_active;

    const config = await PriceAlertConfig.update(parseInt(req.params.id), updateData);
    if (!config) {
      return res.status(404).json({ success: false, error: 'Price alert config not found' });
    }

    res.json({ success: true, data: config });
  } catch (error) {
    logger.error('Error updating price alert:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/price-alerts/:id
 * Delete price alert config
 */
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await PriceAlertConfig.delete(parseInt(req.params.id));
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Price alert config not found' });
    }
    res.json({ success: true, message: 'Price alert config deleted' });
  } catch (error) {
    logger.error('Error deleting price alert:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;

