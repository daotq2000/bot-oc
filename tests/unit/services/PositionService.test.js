import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { PositionService } from '../../../src/services/PositionService.js';
import { mockExchangeService, mockPosition } from '../../utils/mocks.js';

describe('PositionService', () => {
  let positionService;

  beforeEach(() => {
    positionService = new PositionService(mockExchangeService);
    jest.clearAllMocks();
  });

  describe('isTakeProfitHit', () => {
    it('should detect TP hit for long position', () => {
      const position = { ...mockPosition, side: 'long', take_profit_price: 52500 };
      const currentPrice = 52500;

      const result = positionService.isTakeProfitHit(position, currentPrice);
      expect(result).toBe(true);
    });

    it('should detect TP hit for short position', () => {
      const position = { ...mockPosition, side: 'short', take_profit_price: 47500 };
      const currentPrice = 47500;

      const result = positionService.isTakeProfitHit(position, currentPrice);
      expect(result).toBe(true);
    });

    it('should not detect TP if not hit', () => {
      const position = { ...mockPosition, side: 'long', take_profit_price: 52500 };
      const currentPrice = 52000;

      const result = positionService.isTakeProfitHit(position, currentPrice);
      expect(result).toBe(false);
    });
  });

  describe('isStopLossHit', () => {
    it('should detect SL hit for long position', () => {
      const position = { ...mockPosition, side: 'long', stop_loss_price: 47500 };
      const currentPrice = 47500;

      const result = positionService.isStopLossHit(position, currentPrice);
      expect(result).toBe(true);
    });

    it('should detect SL hit for short position', () => {
      const position = { ...mockPosition, side: 'short', stop_loss_price: 52500 };
      const currentPrice = 52500;

      const result = positionService.isStopLossHit(position, currentPrice);
      expect(result).toBe(true);
    });

    it('should return false if no SL set', () => {
      const position = { ...mockPosition, stop_loss_price: null };
      const currentPrice = 50000;

      const result = positionService.isStopLossHit(position, currentPrice);
      expect(result).toBe(false);
    });
  });

  describe('calculateUpdatedStopLoss', () => {
    it('should calculate updated SL with elapsed time', () => {
      const position = {
        ...mockPosition,
        take_profit_price: 55000,
        reduce: 5,
        up_reduce: 5,
        minutes_elapsed: 2,
        oc: 2.0,
        side: 'long',
      };

      const updatedSL = positionService.calculateUpdatedStopLoss(position);
      expect(updatedSL).toBeLessThan(55000); // SL should be below TP for long
    });
  });
});

