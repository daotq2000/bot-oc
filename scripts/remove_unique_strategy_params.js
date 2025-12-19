import { createPool } from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const pool = createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'bot_oc'
});

async function removeUniqueConstraint() {
  try {
    // Check if constraint exists
    const [rows] = await pool.execute(
      `SHOW INDEX FROM strategies WHERE Key_name = 'unique_strategy_params'`
    );
    
    if (rows.length > 0) {
      // Remove the unique constraint
      await pool.execute(
        `ALTER TABLE strategies DROP INDEX unique_strategy_params`
      );
      console.log('✅ Successfully removed unique constraint unique_strategy_params from strategies table');
    } else {
      console.log('⚠️  Constraint unique_strategy_params does not exist, skipping...');
    }
  } catch (error) {
    if (error.message.includes("Unknown key name") || error.message.includes("doesn't exist")) {
      console.log('⚠️  Constraint unique_strategy_params does not exist, skipping...');
    } else {
      console.error('❌ Error removing constraint:', error.message);
      throw error;
    }
  } finally {
    await pool.end();
  }
}

removeUniqueConstraint()
  .then(() => {
    console.log('Migration completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });

