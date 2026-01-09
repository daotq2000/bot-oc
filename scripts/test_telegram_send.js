import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

async function testTelegramSend() {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    // Try to get chat ID from env or use default
    const chatId = process.env.TELEGRAM_ALERT_CHANNEL_ID || process.env.TELEGRAM_CHAT_ID || '-1003163801780';

    if (!token) {
      console.error('❌ TELEGRAM_BOT_TOKEN not found in .env');
      process.exit(1);
    }

    if (!chatId) {
      console.error('❌ TELEGRAM_ALERT_CHANNEL_ID or TELEGRAM_CHAT_ID not found in .env');
      console.error('   Please set TELEGRAM_ALERT_CHANNEL_ID or TELEGRAM_CHAT_ID in .env');
      process.exit(1);
    }

    console.log('📱 Initializing Telegram bot...');
    console.log(`   Token: ${token.substring(0, 10)}...${token.substring(token.length - 5)}`);
    console.log(`   Chat ID: ${chatId}`);

    const bot = new Telegraf(token);

    const testMessage = `
🧪 <b>Test Message from Bot OC</b>

✅ Telegram bot is working correctly!
📅 Time: ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}
🔧 Token: ${token.substring(0, 10)}...${token.substring(token.length - 5)}

This is a test message to verify TELEGRAM_BOT_TOKEN is working.
    `.trim();

    console.log('\n📤 Sending test message...');
    
    // Test bot info first
    try {
      const botInfo = await bot.telegram.getMe();
      console.log('✅ Bot info retrieved:');
      console.log(`   Username: @${botInfo.username}`);
      console.log(`   First Name: ${botInfo.first_name}`);
      console.log(`   ID: ${botInfo.id}`);
    } catch (e) {
      console.error('❌ Failed to get bot info:', e.message);
      throw e;
    }
    
    // Send message with timeout
    const sendPromise = bot.telegram.sendMessage(chatId, testMessage, {
      parse_mode: 'HTML'
    });
    
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Request timeout after 10 seconds')), 10000)
    );
    
    const result = await Promise.race([sendPromise, timeoutPromise]);

    console.log('✅ Message sent successfully!');
    console.log(`   Message ID: ${result.message_id}`);
    console.log(`   Chat ID: ${result.chat.id}`);
    console.log(`   Date: ${new Date(result.date * 1000).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to send message:', error.message);
    if (error.response) {
      console.error('   Error Code:', error.response.error_code);
      console.error('   Description:', error.response.description);
    }
    console.error('   Stack:', error.stack);
    process.exit(1);
  }
}

testTelegramSend();

