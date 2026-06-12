-- Add daily_solver_ticks and last_solver_reset to users table
ALTER TABLE users ADD COLUMN daily_solver_ticks INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN last_solver_reset TEXT DEFAULT NULL;
