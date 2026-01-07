import { Transaction } from '../models/Transaction.js';
import { TelegramService } from './TelegramService.js';
import { TRANSACTION_TYPES, TRANSACTION_STATUS } from '../config/constants.js';
import logger from '../utils/logger.js';

/**
 * Transfer Service - Handle transfers between spot and futures
 */
export class TransferService {
  constructor(exchangeService, telegramService) {
    this.exchangeService = exchangeService;
    this.telegramService = telegramService;
  }

  /**
   * Normalize amount for exchanges that limit decimal precision
   * @param {number} amount
   * @returns {number} Safe amount with up to 8 decimal places, or 0 if invalid
   */
  normalizeAmount(amount) {
    const num = Number(amount);
    if (!Number.isFinite(num) || num <= 0) return 0;
    return parseFloat(num.toFixed(8));
  }

  /**
   * Transfer from spot to futures
   * @param {Object} bot - Bot object
   * @param {number} amount - Amount to transfer
   * @returns {Promise<Object>} Transaction record
   */
  async transferSpotToFuture(bot, amount) {
    let transaction = null;

    try {
      const safeAmount = this.normalizeAmount(amount);
      if (safeAmount <= 0) {
        throw new Error('Invalid transfer amount');
      }

      // Create transaction record
      transaction = await Transaction.create({
        bot_id: bot.id,
        type: TRANSACTION_TYPES.SPOT_TO_FUTURE,
        amount: safeAmount,
        status: TRANSACTION_STATUS.PENDING
      });

      // Execute transfer
      await this.exchangeService.transferSpotToFuture(safeAmount);

      // Update transaction status
      await Transaction.updateStatus(
        transaction.id,
        TRANSACTION_STATUS.SUCCESS
      );

      logger.info(`Spot to future transfer successful for bot ${bot.id}: ${safeAmount} USDT`);

      // Send Telegram notification
      await this.telegramService.sendBalanceUpdate(
        bot,
        'spot_to_future',
        safeAmount
      );

      return await Transaction.findById(transaction.id);
    } catch (error) {
      logger.error(`Spot to future transfer failed for bot ${bot.id}:`, error);

      if (transaction) {
        await Transaction.updateStatus(
          transaction.id,
          TRANSACTION_STATUS.FAILED,
          error.message
        );
      }

      // Send error notification
      await this.telegramService.sendErrorNotification(bot, error);

      throw error;
    }
  }

  /**
   * Transfer from futures to spot
   * @param {Object} bot - Bot object
   * @param {number} amount - Amount to transfer
   * @returns {Promise<Object>} Transaction record
   */
  async transferFutureToSpot(bot, amount) {
    let transaction = null;

    try {
      const safeAmount = this.normalizeAmount(amount);
      if (safeAmount <= 0) {
        throw new Error('Invalid transfer amount');
      }

      // Create transaction record
      transaction = await Transaction.create({
        bot_id: bot.id,
        type: TRANSACTION_TYPES.FUTURE_TO_SPOT,
        amount: safeAmount,
        status: TRANSACTION_STATUS.PENDING
      });

      // Execute transfer
      await this.exchangeService.transferFutureToSpot(safeAmount);

      // Update transaction status
      await Transaction.updateStatus(
        transaction.id,
        TRANSACTION_STATUS.SUCCESS
      );

      logger.info(`Future to spot transfer successful for bot ${bot.id}: ${safeAmount} USDT`);

      // Send Telegram notification
      await this.telegramService.sendBalanceUpdate(
        bot,
        'future_to_spot',
        safeAmount
      );

      return await Transaction.findById(transaction.id);
    } catch (error) {
      logger.error(`Future to spot transfer failed for bot ${bot.id}:`, error);

      if (transaction) {
        await Transaction.updateStatus(
          transaction.id,
          TRANSACTION_STATUS.FAILED,
          error.message
        );
      }

      // Send error notification
      await this.telegramService.sendErrorNotification(bot, error);

      throw error;
    }
  }

  /**
   * Auto manage balances based on bot configuration
   * @param {Object} bot - Bot object
   * @returns {Promise<void>}
   */
  async autoManageBalances(bot) {
    try {
      // Temporarily disable auto balance management for Gate.io and Binance
      // Gate: avoid SERVER_ERROR from transfer API on testnet
      // Binance: direct client path doesn't implement spot/future transfer APIs here
      if (bot.exchange === 'gate' || bot.exchange === 'binance') {
        logger.debug(`Auto balance management disabled for ${bot.exchange} bot ${bot.id}`);
        return;
      }

      // Get futures balance
      const futureBalance = await this.exchangeService.getBalance('future');
      const target = parseFloat(bot.future_balance_target);
      const threshold = parseFloat(bot.spot_transfer_threshold);

      // If balance exceeds target + threshold, transfer excess to spot
      if (futureBalance.total > target + threshold) {
        const excess = futureBalance.total - target;
        const safeExcess = this.normalizeAmount(excess);
        if (safeExcess > 0) {
          await this.transferFutureToSpot(bot, safeExcess);
          logger.info(`Auto-transferred ${safeExcess} USDT from future to spot for bot ${bot.id}`);
        }
      }
      // If balance is below target, transfer from spot to futures
      else if (futureBalance.total < target) {
        const spotBalance = await this.exchangeService.getBalance('spot');
        const needed = target - futureBalance.total;
        const transferAmount = Math.min(needed, spotBalance.free);
        const safeAmount = this.normalizeAmount(transferAmount);

        if (safeAmount > 0) {
          await this.transferSpotToFuture(bot, safeAmount);
          logger.info(`Auto-transferred ${safeAmount} USDT from spot to future for bot ${bot.id}`);
        }
      }
    } catch (error) {
      logger.error(`Auto balance management failed for bot ${bot.id}:`, error);
      throw error;
    }
  }
}

