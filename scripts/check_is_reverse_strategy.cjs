const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config();

async function checkBots() {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'bot_oc'
  });

  try {
    const [rows] = await pool.execute('SELECT id, bot_name, exchange, is_reverse_strategy FROM bots ORDER BY id');
    console.log('All bots with is_reverse_strategy:');
    console.log('Total bots:', rows.length);
    console.log('');
    rows.forEach(bot => {
      const strategy = bot.is_reverse_strategy === 1 || bot.is_reverse_strategy === true 
        ? 'REVERSE (bullish→SHORT, bearish→LONG)' 
        : 'TREND-FOLLOWING (bullish→LONG, bearish→SHORT)';
      console.log(`Bot ID ${bot.id}: ${bot.bot_name || 'N/A'} (${bot.exchange || 'N/A'})`);
      console.log(`  is_reverse_strategy = ${bot.is_reverse_strategy} (${strategy})`);
      console.log('');
    });
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

checkBots().catch(console.error);

