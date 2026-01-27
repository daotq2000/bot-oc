import { configService } from './ConfigService.js';
import logger from '../utils/logger.js';
import { Position } from '../models/Position.js';

/**
 * LossStreakService
 * Uses DB closed positions to detect consecutive losses per bot.
 * Action is executed elsewhere (PositionMonitor/RiskManagement).
 */
export class LossStreakService {
  static async getLossStreak(botId) {
    const limit = Number(configService.getNumber('ADV_TPSL_LOSS_STREAK_LOOKBACK', 20));
    try {
      return await Position.getConsecutiveLosses(botId, limit);
    } catch (e) {
      logger.warn(`[LossStreak] failed to get streak for bot ${botId}: ${e?.message || e}`);
      return 0;
    }
  }
}


