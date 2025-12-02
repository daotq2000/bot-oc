import { Transaction } from '../models/Transaction.js';
import { TelegramService } from './TelegramService.js';
import { TRANSACTION_TYPES, TRANSACTION_STATUS, MIN_WITHDRAW_AMOUNT } from '../config/constants.js';
import logger from '../utils/logger.js';

/**
 * Withdraw Service - Handle withdrawals to external wallets
 */
export class WithdrawService {
  constructor(exchangeService, telegramService) {
    this.exchangeService = exchangeService;
    this.telegramService = telegramService;
  }

  /**
   * Withdraw to external wallet
   * @param {Object} bot - Bot object
   * @param {number} amount - Amount to withdraw
   * @param {string} address - Withdrawal address (optional, uses bot default)
   * @param {string} network - Network (optional, uses bot default)
   * @returns {Promise<Object>} Transaction record
   */
  async withdraw(bot, amount, address = null, network = null) {
    // Validate withdrawal is enabled
    if (!bot.withdraw_enabled) {
      throw new Error('Withdrawal is not enabled for this bot');
    }

    // Validate amount
    if (amount < MIN_WITHDRAW_AMOUNT) {
      throw new Error(`Minimum withdrawal amount is ${MIN_WITHDRAW_AMOUNT} USDT`);
    }

    // Use bot defaults if not provided
    const withdrawAddress = address || bot.withdraw_address;
    const withdrawNetwork = network || bot.withdraw_network;

    if (!withdrawAddress) {
      throw new Error('Withdrawal address not configured');
    }

    let transaction = null;

    try {
      // Create transaction record
      transaction = await Transaction.create({
        bot_id: bot.id,
        type: TRANSACTION_TYPES.WITHDRAW,
        amount: amount,
        status: TRANSACTION_STATUS.PENDING
      });

      // Execute withdrawal
      const result = await this.exchangeService.withdraw(
        amount,
        withdrawAddress,
        withdrawNetwork
      );

      // Update transaction status
      await Transaction.updateStatus(
        transaction.id,
        TRANSACTION_STATUS.SUCCESS
      );

      logger.info(`Withdrawal successful for bot ${bot.id}:`, {
        amount,
        address: withdrawAddress,
        network: withdrawNetwork,
        txid: result.id
      });

      // Send Telegram notification
      await this.telegramService.sendBalanceUpdate(
        bot,
        'withdraw',
        amount
      );

      return await Transaction.findById(transaction.id);
    } catch (error) {
      logger.error(`Withdrawal failed for bot ${bot.id}:`, error);

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
   * Auto withdraw excess balance
   * @param {Object} bot - Bot object
   * @returns {Promise<void>}
   */
  async autoWithdraw(bot) {
    try {
      if (!bot.withdraw_enabled) {
        return; // Withdrawal not enabled
      }

      // Get spot balance
      const spotBalance = await this.exchangeService.getBalance('spot');
      const threshold = parseFloat(bot.spot_balance_threshold);

      // If balance exceeds threshold + minimum withdrawal, withdraw excess
      if (spotBalance.free > threshold + MIN_WITHDRAW_AMOUNT) {
        const excess = spotBalance.free - threshold;
        await this.withdraw(bot, excess);
        logger.info(`Auto-withdrew ${excess} USDT for bot ${bot.id}`);
      }
    } catch (error) {
      logger.error(`Auto withdrawal failed for bot ${bot.id}:`, error);
      // Don't throw - auto withdrawal failures shouldn't stop the bot
    }
  }
}

