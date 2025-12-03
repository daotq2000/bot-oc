-- Migration: Fix current_reduce column size
-- Problem: current_reduce is DECIMAL(5,2) which can only store values up to 999.99
-- But the formula reduce + (minutesElapsed * up_reduce) can exceed this limit
-- Solution: Increase column size to DECIMAL(10,2) to support larger values

USE bot_oc;

-- Alter current_reduce column to support larger values
ALTER TABLE positions 
MODIFY COLUMN current_reduce DECIMAL(10,2) NULL;

