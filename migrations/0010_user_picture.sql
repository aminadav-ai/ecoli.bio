-- Add picture column to users table to store Google profile picture URL
ALTER TABLE users ADD COLUMN picture TEXT DEFAULT NULL;
