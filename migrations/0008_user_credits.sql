-- Add credits column to users table with a default of 250.0 credits for new signups
ALTER TABLE users ADD COLUMN credits REAL DEFAULT 250.0;
