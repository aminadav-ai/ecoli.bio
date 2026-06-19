-- Migration to add guest session statistics columns to guest_visits and seed the guest user
ALTER TABLE guest_visits ADD COLUMN chat_count INTEGER DEFAULT 0;
ALTER TABLE guest_visits ADD COLUMN report_count INTEGER DEFAULT 0;

-- Create reaction_activity table to count enzyme parameter changes (Vmax and Km)
CREATE TABLE IF NOT EXISTS reaction_activity (
    reaction TEXT PRIMARY KEY,
    vmax_count INTEGER DEFAULT 0,
    km_count INTEGER DEFAULT 0
);

-- Insert dummy 'guest' user to reference guest simulation sessions and logs
INSERT OR IGNORE INTO users (email, name, credits) VALUES ('guest', 'Guest User', 0.0);
