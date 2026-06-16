-- Drop obsolete tick and question columns from users table
ALTER TABLE users DROP COLUMN solver_ticks;
ALTER TABLE users DROP COLUMN daily_solver_ticks;
ALTER TABLE users DROP COLUMN last_solver_reset;
ALTER TABLE users DROP COLUMN questions;
