import { Position } from '../src/models/Position.js';
import { PositionService } from '../src/services/PositionService.js';
import logger from '../src/utils/logger.js';

/**
 * Script: test_trailing_reduce.js
 *
 * Mục tiêu:
 * - Test logic đuổi giá (dynamic stop loss) với reduce & up_reduce hiện tại
 * - Sử dụng position thật của bot { id: 2, name: "Binance Futures Bot" }
 * - Dùng position CTSIUSDT, set reduce = 10, up_reduce = 10 (trong memory)
 * - Tính toán stop loss mới theo từng phút để verify công thức:
 *   - current_reduce = reduce + minutes_elapsed * up_reduce
 *   - SL mới được tính qua PositionService.calculateUpdatedStopLoss()
 *
 * Lưu ý:
 * - Script KHÔNG gọi API exchange, chỉ test logic tính toán in-memory
 * - Không ghi thay đổi nào vào database (chỉ đọc position hiện tại)
 */

const TEST_BOT_ID = 2;
const TEST_SYMBOL = 'CTSIUSDT';
const TEST_REDUCE = 10;
const TEST_UP_REDUCE = 10;
const MAX_MINUTES = 10; // Số bước minutes để mô phỏng

async function findTestPosition() {
  logger.info(`\n============================================================`);
  logger.info(`Trailing SL Test - reduce=${TEST_REDUCE}, up_reduce=${TEST_UP_REDUCE}`);
  logger.info(`Bot ID = ${TEST_BOT_ID}, Symbol = ${TEST_SYMBOL}`);
  logger.info(`============================================================\n`);

  // Lấy tất cả open positions cho symbol
  const positions = await Position.findOpenBySymbol(TEST_SYMBOL);
  if (!positions || positions.length === 0) {
    throw new Error(`Không tìm thấy open position cho symbol ${TEST_SYMBOL}`);
  }

  // Lọc theo bot_id = 2
  const pos = positions.find(p => Number(p.bot_id) === TEST_BOT_ID);
  if (!pos) {
    logger.warn(`[Test] Tìm thấy ${positions.length} open position cho ${TEST_SYMBOL} nhưng không có bot_id = ${TEST_BOT_ID}`);
    positions.forEach(p => {
      logger.warn(`[Test]   - pos_id=${p.id}, bot_id=${p.bot_id}, side=${p.side}, amount=${p.amount}, entry=${p.entry_price}`);
    });
    throw new Error(`Không tìm thấy position CTSIUSDT cho bot_id=${TEST_BOT_ID}`);
  }

  logger.info(`[Test] ✅ Sử dụng position: id=${pos.id}, bot_id=${pos.bot_id}, symbol=${pos.symbol}, side=${pos.side}`);
  logger.info(`[Test]     entry_price=${pos.entry_price}, amount=${pos.amount}, tp_price=${pos.take_profit_price}, sl_price=${pos.stop_loss_price}`);
  logger.info(`[Test]     oc=${pos.oc}, take_profit=${pos.take_profit}, reduce=${pos.reduce}, up_reduce=${pos.up_reduce}, minutes_elapsed=${pos.minutes_elapsed}\n`);

  return pos;
}

async function runTrailingTest() {
  try {
    const basePos = await findTestPosition();

    // Tạo PositionService với exchangeService = null (không dùng tới trong calculateUpdatedStopLoss)
    const positionService = new PositionService(null);

    logger.info(`\n=== BẮT ĐẦU MÔ PHỎNG ĐUỔI GIÁ (TRAILING SL) ===`);
    logger.info(`Giả định: reduce = ${TEST_REDUCE}, up_reduce = ${TEST_UP_REDUCE}`);
    logger.info(`Mỗi bước minutes_elapsed tăng 1, tính lại stop loss mới.\n`);

    let prevSL = Number(basePos.stop_loss_price || 0) || 0;
    for (let minutes = 0; minutes <= MAX_MINUTES; minutes++) {
      // Clone position và override reduce/up_reduce + minutes_elapsed
      const testPos = {
        ...basePos,
        reduce: TEST_REDUCE,
        up_reduce: TEST_UP_REDUCE,
        minutes_elapsed: minutes,
      };

      // Tính effectiveReduce giống logic mới trong calculateDynamicStopLoss:
      // effectiveReduce = max(reduce - minutesElapsed * up_reduce, 0)
      const currentReduce = Math.max(
        TEST_REDUCE - ((minutes + 1) * TEST_UP_REDUCE),
        0
      );

      // Tính SL mới bằng logic hiện tại
      const newSL = positionService.calculateUpdatedStopLoss(testPos);

      const oc = Number(testPos.oc || 0);
      const tp = Number(testPos.take_profit_price || 0);

      logger.info(
        `[TrailTest] minute=${minutes + 1} ` +
        `oc=${oc} tp_price=${tp} ` +
        `reduce=${TEST_REDUCE} up_reduce=${TEST_UP_REDUCE} ` +
        `effective_reduce=${currentReduce.toFixed(2)} ` +
        `SL_prev=${prevSL || 'N/A'} SL_new=${newSL}`
      );

      // Kiểm tra monotonic: với long -> SL không được giảm; với short -> SL không được tăng
      if (prevSL > 0 && newSL > 0) {
        if (testPos.side === 'long' && newSL < prevSL) {
          logger.error(`[TrailTest] ❌ VI PHẠM MONOTONIC (LONG): SL mới (${newSL}) < SL cũ (${prevSL})`);
        } else if (testPos.side === 'short' && newSL > prevSL) {
          logger.error(`[TrailTest] ❌ VI PHẠM MONOTONIC (SHORT): SL mới (${newSL}) > SL cũ (${prevSL})`);
        }
      }

      prevSL = Number(newSL || prevSL) || prevSL;
    }

    logger.info(`\n=== KẾT THÚC MÔ PHỎNG ĐUỔI GIÁ ===`);
    logger.info(`Hãy so sánh log [TrailTest] với log [SL Update] trong PositionService để verify hành vi thực tế.`);
    process.exit(0);
  } catch (error) {
    logger.error(`[TrailTest] ❌ Lỗi khi chạy test trailing SL:`, error?.message || error);
    logger.error(error?.stack || '');
    process.exit(1);
  }
}

runTrailingTest();


