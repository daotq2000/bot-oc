import { ExchangeService } from './ExchangeService.js';
import logger from '../utils/logger.js';

/**
 * ExchangeService Pool - Singleton pattern to avoid creating multiple instances per bot
 * This prevents redundant API initialization and reduces logs spam
 */
class ExchangeServicePool {
  constructor() {
    this.services = new Map(); // botId -> ExchangeService
  }

  /**
   * Get or create ExchangeService for a bot
   * @param {Object} bot - Bot object
   * @returns {Promise<ExchangeService>} ExchangeService instance
   */
  async getOrCreate(bot) {
    if (this.services.has(bot.id)) {
      logger.debug(`[ExchangeServicePool] Reusing ExchangeService for bot ${bot.id}`);
      return this.services.get(bot.id);
    }

    logger.debug(`[ExchangeServicePool] Creating new ExchangeService for bot ${bot.id}`);
    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();
    this.services.set(bot.id, exchangeService);
    return exchangeService;
  }

  /**
   * Get ExchangeService for a bot (must already exist)
   * @param {number} botId - Bot ID
   * @returns {ExchangeService|null} ExchangeService instance or null if not found
   */
  get(botId) {
    return this.services.get(botId) || null;
  }

  /**
   * Remove ExchangeService for a bot
   * @param {number} botId - Bot ID
   */
  remove(botId) {
    this.services.delete(botId);
    logger.debug(`[ExchangeServicePool] Removed ExchangeService for bot ${botId}`);
  }

  /**
   * Clear all services
   */
  clear() {
    this.services.clear();
    logger.info('[ExchangeServicePool] Cleared all ExchangeServices');
  }

  /**
   * Get all services
   * @returns {Map} Map of botId -> ExchangeService
   */
  getAll() {
    return new Map(this.services);
  }
}

// Export singleton instance
export const exchangeServicePool = new ExchangeServicePool();

