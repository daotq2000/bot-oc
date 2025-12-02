import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Bot } from '../../../src/models/Bot.js';
import pool from '../../../src/config/database.js';


describe('Bot Model', () => {
  beforeEach(() => {
    pool.execute = jest.fn();
    jest.clearAllMocks();
  });

  describe('findAll', () => {
    it('should find all bots', async () => {
      const mockBots = [{ id: 1, bot_name: 'Test Bot' }];
      pool.execute.mockResolvedValue([mockBots]);

      const result = await Bot.findAll();

      expect(pool.execute).toHaveBeenCalled();
      expect(result).toEqual(mockBots);
    });

    it('should find only active bots', async () => {
      const mockBots = [{ id: 1, bot_name: 'Active Bot', is_active: true }];
      pool.execute.mockResolvedValue([mockBots]);

      const result = await Bot.findAll(true);

      expect(pool.execute).toHaveBeenCalled();
      expect(result).toEqual(mockBots);
    });
  });

  describe('findById', () => {
    it('should find bot by id', async () => {
      const mockBot = { id: 1, bot_name: 'Test Bot' };
      pool.execute.mockResolvedValue([[mockBot]]);

      const result = await Bot.findById(1);

      expect(pool.execute).toHaveBeenCalledWith('SELECT * FROM bots WHERE id = ?', [1]);
      expect(result).toEqual(mockBot);
    });

    it('should return null if not found', async () => {
      pool.execute.mockResolvedValue([[]]);

      const result = await Bot.findById(999);

      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('should create a new bot', async () => {
      const botData = {
        bot_name: 'New Bot',
        exchange: 'mexc',
        access_key: 'key',
        secret_key: 'secret',
      };

      pool.execute
        .mockResolvedValueOnce([[], { insertId: 1 }]) // Insert result
        .mockResolvedValueOnce([[{ id: 1, ...botData }]]); // FindById result

      const result = await Bot.create(botData);

      expect(pool.execute).toHaveBeenCalled();
      expect(result).toHaveProperty('id', 1);
    });
  });
});

