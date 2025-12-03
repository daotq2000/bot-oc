/**
 * Script to fix current_reduce column size
 * Run: node scripts/fix_current_reduce_column.js
 */

import pool from '../src/config/database.js';

async function fixCurrentReduceColumn() {
  try {
    console.log('🔧 Fixing current_reduce column size...');
    
    // Check current column definition
    const [columns] = await pool.execute(`
      SELECT COLUMN_TYPE 
      FROM information_schema.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'positions' 
        AND COLUMN_NAME = 'current_reduce'
    `);
    
    if (columns.length === 0) {
      console.log('❌ Column current_reduce not found');
      return;
    }
    
    const currentType = columns[0].COLUMN_TYPE;
    console.log(`Current column type: ${currentType}`);
    
    if (currentType.includes('decimal(10,2)') || currentType.includes('decimal(10, 2)')) {
      console.log('✅ Column already has correct size (DECIMAL(10,2))');
      return;
    }
    
    // Alter column
    console.log('Altering column to DECIMAL(10,2)...');
    await pool.execute(`
      ALTER TABLE positions 
      MODIFY COLUMN current_reduce DECIMAL(10,2) NULL
    `);
    
    console.log('✅ Successfully altered current_reduce column to DECIMAL(10,2)');
    
    // Verify
    const [newColumns] = await pool.execute(`
      SELECT COLUMN_TYPE 
      FROM information_schema.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'positions' 
        AND COLUMN_NAME = 'current_reduce'
    `);
    
    console.log(`New column type: ${newColumns[0].COLUMN_TYPE}`);
    
  } catch (error) {
    console.error('❌ Error fixing current_reduce column:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

fixCurrentReduceColumn()
  .then(() => {
    console.log('✅ Migration completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  });

