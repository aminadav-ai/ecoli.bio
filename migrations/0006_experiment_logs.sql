-- Create experiment_logs table
CREATE TABLE IF NOT EXISTS experiment_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES simulation_sessions(id) ON DELETE CASCADE,
    action_type TEXT NOT NULL,
    target TEXT NOT NULL,
    value REAL,
    growth_rate REAL,
    glucose_uptake REAL,
    oxygen_uptake REAL,
    atp_yield REAL,
    is_dead INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_experiment_logs_session_id ON experiment_logs(session_id);
