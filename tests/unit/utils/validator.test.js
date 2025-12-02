import { describe, it, expect } from '@jest/globals';
import {
  validateProxy,
  validateExchange,
  validateSymbol,
  validateInterval,
  validateTradeType,
  validateAmount,
  validatePercentage,
  validateWalletAddress,
  validateNetwork,
} from '../../../src/utils/validator.js';

describe('Validator Utilities', () => {
  describe('validateProxy', () => {
    it('should validate correct proxy format', () => {
      expect(validateProxy('127.0.0.1:8080:user:pass')).toBe(true);
    });

    it('should return true for empty proxy (optional)', () => {
      expect(validateProxy(null)).toBe(true);
      expect(validateProxy('')).toBe(true);
    });

    it('should reject invalid proxy format', () => {
      expect(validateProxy('127.0.0.1:8080')).toBe(false);
      expect(validateProxy('invalid')).toBe(false);
    });
  });

  describe('validateExchange', () => {
    it('should validate mexc exchange', () => {
      expect(validateExchange('mexc')).toBe(true);
      expect(validateExchange('MEXC')).toBe(true);
    });

    it('should validate gate exchange', () => {
      expect(validateExchange('gate')).toBe(true);
      expect(validateExchange('GATE')).toBe(true);
    });

    it('should reject invalid exchange', () => {
      expect(validateExchange('binance')).toBe(false);
      expect(validateExchange('invalid')).toBe(false);
    });
  });

  describe('validateSymbol', () => {
    it('should validate correct symbol format', () => {
      expect(validateSymbol('BTC/USDT')).toBe(true);
      expect(validateSymbol('ETH/USDT')).toBe(true);
    });

    it('should reject invalid symbol format', () => {
      expect(validateSymbol('BTCUSDT')).toBe(false);
      expect(validateSymbol('BTC')).toBe(false);
      expect(validateSymbol('')).toBe(false);
      expect(validateSymbol(null)).toBe(false);
    });
  });

  describe('validateInterval', () => {
    it('should validate correct intervals', () => {
      expect(validateInterval('1m')).toBe(true);
      expect(validateInterval('5m')).toBe(true);
      expect(validateInterval('1h')).toBe(true);
    });

    it('should reject invalid intervals', () => {
      expect(validateInterval('2m')).toBe(false);
      expect(validateInterval('invalid')).toBe(false);
    });
  });

  describe('validateTradeType', () => {
    it('should validate correct trade types', () => {
      expect(validateTradeType('long')).toBe(true);
      expect(validateTradeType('short')).toBe(true);
      expect(validateTradeType('both')).toBe(true);
    });

    it('should reject invalid trade types', () => {
      expect(validateTradeType('invalid')).toBe(false);
      expect(validateTradeType(null)).toBe(false);
    });
  });

  describe('validateAmount', () => {
    it('should validate positive amounts', () => {
      expect(validateAmount(10)).toBe(true);
      expect(validateAmount(0.1)).toBe(true);
    });

    it('should reject negative or zero amounts', () => {
      expect(validateAmount(-10)).toBe(false);
      expect(validateAmount(0)).toBe(false);
    });
  });

  describe('validatePercentage', () => {
    it('should validate percentages within range', () => {
      expect(validatePercentage(50, 0, 100)).toBe(true);
      expect(validatePercentage(0, 0, 100)).toBe(true);
      expect(validatePercentage(100, 0, 100)).toBe(true);
    });

    it('should reject percentages outside range', () => {
      expect(validatePercentage(-1, 0, 100)).toBe(false);
      expect(validatePercentage(101, 0, 100)).toBe(false);
    });
  });

  describe('validateWalletAddress', () => {
    it('should validate correct wallet addresses', () => {
      expect(validateWalletAddress('0x1234567890123456789012345678901234567890')).toBe(true);
      expect(validateWalletAddress('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh')).toBe(true);
    });

    it('should reject invalid wallet addresses', () => {
      expect(validateWalletAddress('short')).toBe(false);
      expect(validateWalletAddress('')).toBe(false);
      expect(validateWalletAddress(null)).toBe(false);
    });
  });

  describe('validateNetwork', () => {
    it('should validate correct networks', () => {
      expect(validateNetwork('BEP20')).toBe(true);
      expect(validateNetwork('ERC20')).toBe(true);
      expect(validateNetwork('TRC20')).toBe(true);
    });

    it('should reject invalid networks', () => {
      expect(validateNetwork('invalid')).toBe(false);
      expect(validateNetwork(null)).toBe(false);
    });
  });
});

