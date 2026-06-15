-- Add prev_value column to experiment_logs
ALTER TABLE experiment_logs ADD COLUMN prev_value REAL;
