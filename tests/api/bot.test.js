import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import routes from '../../src/routes/index.js';

jest.mock('../../src/models/Bot.js', () => ({
  Bot: {
    findAll: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock('../../src/services/ExchangeService.js');
jest.mock('../../src/services/TelegramService.js');
jest.mock('../../src/services/TransferService.js');
jest.mock('../../src/services/WithdrawService.js');

const app = express();
app.use(express.json());
app.use('/api', routes);

describe.skip('Bot API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/bots', () => {
    it('should get all bots', async () => {
      const { Bot } = await import('../../src/models/Bot.js');
      Bot.findAll.mockResolvedValue([{ id: 1, bot_name: 'Test Bot' }]);

      const response = await request(app).get('/api/bots');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(1);
    });
  });

  describe('POST /api/bots', () => {
    it('should create a new bot', async () => {
      const { Bot } = await import('../../src/models/Bot.js');
      const newBot = {
        id: 1,
        bot_name: 'New Bot',
        exchange: 'mexc',
        access_key: 'key',
        secret_key: 'secret',
      };
      Bot.create.mockResolvedValue(newBot);

      const response = await request(app)
        .post('/api/bots')
        .send({
          bot_name: 'New Bot',
          exchange: 'mexc',
          access_key: 'key',
          secret_key: 'secret',
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.bot_name).toBe('New Bot');
    });

    it('should reject invalid exchange', async () => {
      const response = await request(app)
        .post('/api/bots')
        .send({
          bot_name: 'New Bot',
          exchange: 'invalid',
          access_key: 'key',
          secret_key: 'secret',
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
  });
});

