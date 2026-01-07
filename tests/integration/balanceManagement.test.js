import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { TransferService } from '../../src/services/TransferService.js';
import { WithdrawService } from '../../src/services/WithdrawService.js';
import { mockExchangeService, mockTelegramService, mockBot } from '../utils/mocks.js';
import { Transaction } from '../../src/models/Transaction.js';

jest.mock('../../src/models/Transaction.js', () => ({
  Transaction: {
    create: jest.fn(),
    updateStatus: jest.fn(),
    findById: jest.fn(),
  },
}));

describe.skip('Balance Management Integration', () => {
  let transferService;
  let withdrawService;

  beforeEach(() => {
    transferService = new TransferService(mockExchangeService, mockTelegramService);
    withdrawService = new WithdrawService(mockExchangeService, mockTelegramService);
    jest.clearAllMocks();
  });

  describe('TransferService', () => {
    it('should transfer spot to future successfully', async () => {
      Transaction.create.mockResolvedValue({ id: 1, status: 'pending' });
      Transaction.updateStatus.mockResolvedValue(true);
      Transaction.findById.mockResolvedValue({ id: 1, status: 'success' });

      const result = await transferService.transferSpotToFuture(mockBot, 10);

      expect(mockExchangeService.transferSpotToFuture).toHaveBeenCalledWith(10);
      expect(Transaction.create).toHaveBeenCalled();
      expect(Transaction.updateStatus).toHaveBeenCalledWith(1, 'success');
      expect(mockTelegramService.sendBalanceUpdate).toHaveBeenCalled();
    });

    it('should auto manage balances when futures exceeds target', async () => {
      mockExchangeService.getBalance.mockResolvedValueOnce({
        total: 35, // Target is 20, threshold is 10, so excess = 15
        free: 35,
        used: 0,
      });

      Transaction.create.mockResolvedValue({ id: 1 });
      Transaction.updateStatus.mockResolvedValue(true);
      Transaction.findById.mockResolvedValue({ id: 1, status: 'success' });

      await transferService.autoManageBalances(mockBot);

      expect(mockExchangeService.transferFutureToSpot).toHaveBeenCalledWith(15);
    });

    it('should auto manage balances when futures below target', async () => {
      mockExchangeService.getBalance
        .mockResolvedValueOnce({ total: 15, free: 15, used: 0 }) // Futures
        .mockResolvedValueOnce({ total: 20, free: 10, used: 10 }); // Spot

      Transaction.create.mockResolvedValue({ id: 1 });
      Transaction.updateStatus.mockResolvedValue(true);
      Transaction.findById.mockResolvedValue({ id: 1, status: 'success' });

      await transferService.autoManageBalances(mockBot);

      expect(mockExchangeService.transferSpotToFuture).toHaveBeenCalledWith(5);
    });
  });

  describe('WithdrawService', () => {
    it('should withdraw successfully when enabled', async () => {
      const botWithWithdraw = { ...mockBot, withdraw_enabled: true, withdraw_address: '0x123' };
      Transaction.create.mockResolvedValue({ id: 1 });
      Transaction.updateStatus.mockResolvedValue(true);
      Transaction.findById.mockResolvedValue({ id: 1, status: 'success' });

      const result = await withdrawService.withdraw(botWithWithdraw, 20);

      expect(mockExchangeService.withdraw).toHaveBeenCalledWith(20, '0x123', 'BEP20');
      expect(mockTelegramService.sendBalanceUpdate).toHaveBeenCalled();
    });

    it('should reject withdraw when disabled', async () => {
      await expect(withdrawService.withdraw(mockBot, 20)).rejects.toThrow('not enabled');
    });

    it('should reject withdraw below minimum', async () => {
      const botWithWithdraw = { ...mockBot, withdraw_enabled: true };
      await expect(withdrawService.withdraw(botWithWithdraw, 5)).rejects.toThrow('Minimum');
    });

    it('should auto withdraw excess balance', async () => {
      const botWithWithdraw = {
        ...mockBot,
        withdraw_enabled: true,
        withdraw_address: '0x123',
        spot_balance_threshold: 10,
      };

      mockExchangeService.getBalance.mockResolvedValue({
        total: 25, // Threshold is 10, excess = 15
        free: 25,
        used: 0,
      });

      Transaction.create.mockResolvedValue({ id: 1 });
      Transaction.updateStatus.mockResolvedValue(true);
      Transaction.findById.mockResolvedValue({ id: 1, status: 'success' });

      await withdrawService.autoWithdraw(botWithWithdraw);

      expect(mockExchangeService.withdraw).toHaveBeenCalledWith(15, '0x123', 'BEP20');
    });
  });
});

