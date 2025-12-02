import cron from 'node-cron';
import { Bot } from '../models/Bot.js';
import { ExchangeService } from '../services/ExchangeService.js';
import { TransferService } from '../services/TransferService.js';
import { WithdrawService } from '../services/WithdrawService.js';
import { TelegramService } from '../services/TelegramService.js';
import { DEFAULT_CRON_PATTERNS } from '../config/constants.js';
import logger from '../utils/logger.js';

/**
 * Balance Manager Job - Auto transfer and withdraw
 */
export class BalanceManager {
  constructor() {
    this.exchangeServices = new Map(); // botId -> ExchangeService
    this.transferServices = new Map(); // botId -> TransferService
    this.withdrawServices = new Map(); // botId -> WithdrawService
    this.telegramService = null;
    this.isRunning = false;
  }

  /**
   * Initialize services for all active bots
   */
  async initialize(telegramService) {
    this.telegramService = telegramService;

    try {
      const bots = await Bot.findAll(true); // Active bots only

      for (const bot of bots) {
        await this.addBot(bot);
      }
    } catch (error) {
      logger.error('Failed to initialize BalanceManager:', error);
    }
  }

  /**
   * Add bot to manager
   * @param {Object} bot - Bot object
   */
  async addBot(bot) {
    try {
      const exchangeService = new ExchangeService(bot);
      await exchangeService.initialize();
      this.exchangeServices.set(bot.id, exchangeService);

      const transferService = new TransferService(exchangeService, this.telegramService);
      this.transferServices.set(bot.id, transferService);

      const withdrawService = new WithdrawService(exchangeService, this.telegramService);
      this.withdrawServices.set(bot.id, withdrawService);

      logger.info(`BalanceManager initialized for bot ${bot.id}`);
    } catch (error) {
      logger.error(`Failed to initialize BalanceManager for bot ${bot.id}:`, error);
    }
  }

  /**
   * Remove bot from manager
   * @param {number} botId - Bot ID
   */
  removeBot(botId) {
    this.exchangeServices.delete(botId);
    this.transferServices.delete(botId);
    this.withdrawServices.delete(botId);
    logger.info(`Removed bot ${botId} from BalanceManager`);
  }

  /**
   * Manage balances for a bot
   * @param {Object} bot - Bot object
   */
  async manageBotBalances(bot) {
    try {
      const transferService = this.transferServices.get(bot.id);
      if (!transferService) {
        logger.warn(`TransferService not found for bot ${bot.id}`);
        return;
      }

      await transferService.autoManageBalances(bot);
    } catch (error) {
      logger.error(`Error managing balances for bot ${bot.id}:`, error);
    }
  }

  /**
   * Auto withdraw for a bot
   * @param {Object} bot - Bot object
   */
  async autoWithdrawBot(bot) {
    try {
      const withdrawService = this.withdrawServices.get(bot.id);
      if (!withdrawService) {
        logger.warn(`WithdrawService not found for bot ${bot.id}`);
        return;
      }

      await withdrawService.autoWithdraw(bot);
    } catch (error) {
      logger.error(`Error auto withdrawing for bot ${bot.id}:`, error);
    }
  }

  /**
   * Manage all bot balances
   */
  async manageAllBalances() {
    if (this.isRunning) {
      logger.debug('BalanceManager already running, skipping...');
      return;
    }

    this.isRunning = true;

    try {
      const bots = await Bot.findAll(true); // Active bots only

      // Process bots sequentially to avoid rate limits
      for (const bot of bots) {
        await this.manageBotBalances(bot);
        
        // Small delay between bots
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      logger.debug(`Managed balances for ${bots.length} bots`);
    } catch (error) {
      logger.error('Error in manageAllBalances:', error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Auto withdraw for all bots
   */
  async autoWithdrawAll() {
    if (this.isRunning) {
      logger.debug('BalanceManager withdraw already running, skipping...');
      return;
    }

    this.isRunning = true;

    try {
      const bots = await Bot.findAll(true); // Active bots only

      // Process bots sequentially
      for (const bot of bots) {
        await this.autoWithdrawBot(bot);
        
        // Small delay between bots
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      logger.debug(`Auto withdrew for ${bots.length} bots`);
    } catch (error) {
      logger.error('Error in autoWithdrawAll:', error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Start the cron jobs
   */
  start() {
    // Balance check (based on transfer_frequency)
    const balancePattern = DEFAULT_CRON_PATTERNS.BALANCE_CHECK;
    cron.schedule(balancePattern, async () => {
      await this.manageAllBalances();
    });

    // Withdraw check (hourly)
    const withdrawPattern = DEFAULT_CRON_PATTERNS.WITHDRAW_CHECK;
    cron.schedule(withdrawPattern, async () => {
      await this.autoWithdrawAll();
    });

    logger.info(`BalanceManager started with patterns: ${balancePattern}, ${withdrawPattern}`);
  }
}

