import { createPool } from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const pool = createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'bot_oc'
});

async function addStoplossColumn() {
  try {
    // Check if column already exists
    const [columns] = await pool.execute(
      `SHOW COLUMNS FROM strategies LIKE 'stoploss'`
    );
    
    if (columns.length > 0) {
      console.log('⚠️  Column stoploss already exists in strategies table, skipping...');
      return;
    }
    
    // Add stoploss column
    await pool.execute(
      `ALTER TABLE strategies 
       ADD COLUMN stoploss DECIMAL(10, 2) NULL DEFAULT NULL 
       COMMENT 'Stop loss percentage (same format as take_profit: e.g., 50 = 5%). If > 0, used to calculate initial SL from entry price. If <= 0 or NULL, no SL is set.'`
    );
    
    console.log('✅ Successfully added stoploss column to strategies table');
  } catch (error) {
    console.error('❌ Error adding stoploss column:', error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

addStoplossColumn()
  .then(() => {
    console.log('Migration completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });

