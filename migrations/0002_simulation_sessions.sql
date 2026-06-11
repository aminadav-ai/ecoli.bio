-- Create simulation_sessions table for experiments
CREATE TABLE IF NOT EXISTS simulation_sessions (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
    base_name TEXT NOT NULL,
    name TEXT NOT NULL,
    state TEXT NOT NULL, -- JSON string of simulation state (bounds, concentrations, status)
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_simulation_sessions_email ON simulation_sessions(email);
