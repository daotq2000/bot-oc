/**
 * Migration: Fix current_reduce column size
 * 
 * Problem: current_reduce is DECIMAL(5,2) which can only store values up to 999.99
 * But the formula reduce + (minutesElapsed * up_reduce) can exceed this limit
 * 
 * Solution: Increase column size to DECIMAL(10,2) to support larger values
 */

import pool from '../src/config/database.js';

export async function up() {
  try {
    console.log('Altering current_reduce column to DECIMAL(10,2)...');
    
    await pool.execute(`
      ALTER TABLE positions 
      MODIFY COLUMN current_reduce DECIMAL(10,2) NULL
    `);
    
    console.log('✅ Successfully altered current_reduce column');
  } catch (error) {
    console.error('❌ Error altering current_reduce column:', error);
    throw error;
  }
}

export async function down() {
  try {
    console.log('Reverting current_reduce column to DECIMAL(5,2)...');
    
    // First, clamp any values that exceed 999.99
    await pool.execute(`
      UPDATE positions 
      SET current_reduce = LEAST(current_reduce, 999.99)
      WHERE current_reduce > 999.99
    `);
    
    await pool.execute(`
      ALTER TABLE positions 
      MODIFY COLUMN current_reduce DECIMAL(5,2) NULL
    `);
    
    console.log('✅ Successfully reverted current_reduce column');
  } catch (error) {
    console.error('❌ Error reverting current_reduce column:', error);
    throw error;
  }
}

