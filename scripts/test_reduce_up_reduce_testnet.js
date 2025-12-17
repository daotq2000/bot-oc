import logger from '../src/utils/logger.js';
import { Bot } from '../src/models/Bot.js';
import { Position } from '../src/models/Position.js';
import { ExchangeService } from '../src/services/ExchangeService.js';

/**
 * Script: test_reduce_up_reduce_testnet.js
 *
 * Mục tiêu:
 * - Test logic đuổi giá TP theo docs Reduce / Up Reduce trên BINANCE TESTNET
 * - Sử dụng position thật của bot testnet (ví dụ bot_id = 2) với symbol CTSIUSDT
 * - Cứ mỗi chu kỳ, tính TP mới dựa trên giá market và rate (reduce)
 * - (TÙY CHỌN) Có thể hủy TP cũ và đặt TP mới trên testnet với khối lượng nhỏ
 *
 * Lưu ý:
 * - Script CHỈ nên chạy trên bot testnet (binance_testnet = true)
 * - Mặc định chỉ log ra TP mới, KHÔNG gửi order thật. Nếu muốn gửi order,
 *   bật cờ ENABLE_LIVE_UPDATE = true phía dưới.
 */

const TEST_BOT_ID = 2;
const TEST_SYMBOL = 'CTSIUSDT';

// Tham số Reduce / Up Reduce để test
const TEST_REDUCE = 10;    // 10 => Rate = 10%
const TEST_UP_REDUCE = 0;  // Tạm thời chưa dùng trong rate, có thể map thành K sau

// Cấu hình test vòng lặp
const LOOP_COUNT = 10;         // Số lần cập nhật TP
const LOOP_INTERVAL_MS = 60_000; // 60s / lần cho gần với thực tế

// Cờ bật/tắt việc gửi order thật lên testnet
const ENABLE_LIVE_UPDATE = false; // Để true nếu anh muốn nó cancel + đặt TP limit trên testnet

/**
 * Công thức đuổi TP theo docs:
 *   P_n = P_{n-1} + (P_market - P_{n-1}) * Rate
 *
 * Trong đó:
 *   - currentTp  = P_{n-1}
 *   - market     = P_market
 *   - rate       = reduce / 100 (reduce = 10 => 10%)
 *
 * Với SHORT: TP nằm dưới market, công thức trên sẽ kéo TP lên dần gần market.
 * Với LONG: TP nằm trên market, công thức trên sẽ kéo TP xuống dần gần market.
 *
 * Để an toàn:
 * - Không cho TP vượt qua market (đụng vào giá hiện tại)
 * - Có thể chừa offset 0.1% để tránh khớp market ngay lập tức
 */
function calculateChasingTp(currentTp, marketPrice, reduceRate, side) {
  const tp = Number(currentTp);
  const m = Number(marketPrice);
  const r = Number(reduceRate);

  if (!Number.isFinite(tp) || !Number.isFinite(m) || !Number.isFinite(r) || r <= 0) {
    return tp;
  }

  const rate = Math.min(Math.max(r / 100, 0), 1); // 10 => 0.1 (10%), clamp 0..1
  const rawNext = tp + (m - tp) * rate;

  // Offset an toàn 0.1% quanh giá market
  const offset = m * 0.001;

  if (side === 'short') {
    // TP phải luôn <= market - offset
    const maxTp = m - offset;
    return Math.min(rawNext, maxTp);
  } else {
    // LONG: TP phải luôn >= market + offset
    const minTp = m + offset;
    return Math.max(rawNext, minTp);
  }
}

async function findTestnetBot(botId) {
  const bot = await Bot.findById(botId);
  if (!bot) {
    throw new Error(`Không tìm thấy bot id=${botId}`);
  }
  if (!bot.binance_testnet) {
    logger.warn(`[TestReduce] Bot ${botId} không bật testnet (binance_testnet=false). Vẫn tiếp tục nhưng HÃY ĐẢM BẢO đây là tài khoản test.`);
  }
  return bot;
}

async function findTestPosition(botId, symbol) {
  const positions = await Position.findOpenBySymbol(symbol);
  if (!positions || positions.length === 0) {
    throw new Error(`Không có open position cho ${symbol}`);
  }
  const pos = positions.find(p => Number(p.bot_id) === Number(botId));
  if (!pos) {
    logger.warn(`[TestReduce] Có ${positions.length} open position cho ${symbol} nhưng không thuộc bot_id=${botId}`);
    positions.forEach(p => {
      logger.warn(`[TestReduce]   - pos_id=${p.id}, bot_id=${p.bot_id}, side=${p.side}, entry=${p.entry_price}, tp=${p.take_profit_price}`);
    });
    throw new Error(`Không tìm thấy position ${symbol} cho bot_id=${botId}`);
  }
  return pos;
}

async function runTest() {
  try {
    logger.info('\n============================================================');
    logger.info('Test Reduce / Up Reduce - Binance Testnet');
    logger.info(`Bot ID = ${TEST_BOT_ID}, Symbol = ${TEST_SYMBOL}`);
    logger.info(`Reduce = ${TEST_REDUCE}, Up_Reduce = ${TEST_UP_REDUCE}`);
    logger.info(`ENABLE_LIVE_UPDATE = ${ENABLE_LIVE_UPDATE}`);
    logger.info('============================================================\n');

    const bot = await findTestnetBot(TEST_BOT_ID);
    const position = await findTestPosition(TEST_BOT_ID, TEST_SYMBOL);

    logger.info(`[TestReduce] ✅ Position: id=${position.id}, bot_id=${position.bot_id}, side=${position.side}`);
    logger.info(`[TestReduce]     entry=${position.entry_price}, amount=${position.amount}, tp=${position.take_profit_price}, sl=${position.stop_loss_price}`);

    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();
    logger.info('[TestReduce] ✅ ExchangeService initialized for testnet');

    let currentTp = Number(position.take_profit_price || 0);
    const side = position.side === 'short' ? 'short' : 'long';

    if (!Number.isFinite(currentTp) || currentTp <= 0) {
      throw new Error(`TP hiện tại không hợp lệ: ${currentTp}`);
    }

    for (let i = 1; i <= LOOP_COUNT; i++) {
      const marketPrice = await exchangeService.getTickerPrice(TEST_SYMBOL);
      if (!marketPrice || !Number.isFinite(Number(marketPrice))) {
        logger.warn(`[TestReduce] Giá market không hợp lệ cho ${TEST_SYMBOL}: ${marketPrice}`);
        break;
      }

      const nextTp = calculateChasingTp(currentTp, Number(marketPrice), TEST_REDUCE, side);

      logger.info(
        `[TestReduce] loop=${i} side=${side} ` +
        `market=${marketPrice} tp_prev=${currentTp} tp_new=${nextTp}`
      );

      if (ENABLE_LIVE_UPDATE) {
        try {
          // Lấy qty có thể đóng
          const qty = await exchangeService.getClosableQuantity(TEST_SYMBOL, side);
          if (qty && qty > 0) {
            // (Không hủy TP cũ để tránh lỗi, chỉ thêm TP mới rất sát market trên testnet)
            const res = await exchangeService.createTakeProfitLimit(TEST_SYMBOL, side, nextTp, qty);
            logger.info(`[TestReduce] ✅ Đã gửi TP limit mới trên testnet: price=${nextTp}, qty=${qty}, res=${JSON.stringify(res)}`);
          } else {
            logger.warn('[TestReduce] Không tìm thấy qty để đặt TP (qty <= 0), bỏ qua gửi order');
          }
        } catch (e) {
          logger.error('[TestReduce] ❌ Lỗi khi gửi TP limit lên testnet:', e?.message || e);
        }
      }

      currentTp = nextTp;

      if (i < LOOP_COUNT) {
        await new Promise(resolve => setTimeout(resolve, LOOP_INTERVAL_MS));
      }
    }

    logger.info('\n[TestReduce] ✅ Kết thúc test Reduce / Up Reduce trên testnet');
    process.exit(0);
  } catch (error) {
    logger.error('[TestReduce] ❌ Lỗi khi chạy test:', error?.message || error);
    logger.error(error?.stack || '');
    process.exit(1);
  }
}

runTest();


