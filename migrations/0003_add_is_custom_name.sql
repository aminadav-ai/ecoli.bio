-- Migration to add is_custom_name column to simulation_sessions
ALTER TABLE simulation_sessions ADD COLUMN is_custom_name INTEGER DEFAULT 0;
