/**
 * Migration: Fix positions foreign key CASCADE DELETE
 * 
 * CRITICAL FIX: Change foreign key constraint from ON DELETE CASCADE to ON DELETE RESTRICT
 * to prevent accidental deletion of positions when bot/strategy is deleted.
 * 
 * This ensures:
 * - Positions are NEVER deleted automatically
 * - Bot/Strategy deletion is blocked if there are open positions
 * - Only explicit position.close() or position.cancel() can change position status
 */

const pool = require('../src/config/database.js').default;

async function up() {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Step 1: Drop existing foreign key constraint if exists
    try {
      await connection.execute(`
        ALTER TABLE positions 
        DROP FOREIGN KEY fk_positions_bot_id
      `);
      console.log('✅ Dropped existing fk_positions_bot_id constraint');
    } catch (e) {
      if (e?.code === 'ER_CANT_DROP_FIELD_OR_KEY' || e?.message?.includes('doesn\'t exist')) {
        console.log('ℹ️  Foreign key fk_positions_bot_id does not exist, skipping drop');
      } else {
        throw e;
      }
    }

    // Step 2: Add new foreign key constraint with RESTRICT (default, but explicit)
    // RESTRICT prevents deletion of bot if there are positions referencing it
    await connection.execute(`
      ALTER TABLE positions 
      ADD CONSTRAINT fk_positions_bot_id 
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE RESTRICT
    `);
    console.log('✅ Added fk_positions_bot_id constraint with ON DELETE RESTRICT');

    await connection.commit();
    console.log('✅ Migration completed: positions foreign key now uses RESTRICT instead of CASCADE');
  } catch (error) {
    await connection.rollback();
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    connection.release();
  }
}

async function down() {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Revert to CASCADE (not recommended, but for rollback purposes)
    await connection.execute(`
      ALTER TABLE positions 
      DROP FOREIGN KEY fk_positions_bot_id
    `);

    await connection.execute(`
      ALTER TABLE positions 
      ADD CONSTRAINT fk_positions_bot_id 
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    `);

    await connection.commit();
    console.log('⚠️  Rolled back: positions foreign key reverted to CASCADE (NOT RECOMMENDED)');
  } catch (error) {
    await connection.rollback();
    console.error('❌ Rollback failed:', error);
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { up, down };

