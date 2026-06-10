-- 1. Create users table
CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    name TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    premium_until TEXT,
    premium_tier INTEGER DEFAULT 0,
    auto_renew INTEGER DEFAULT 0,
    solver_ticks INTEGER DEFAULT 0,
    visits INTEGER DEFAULT 0,
    last_visit TEXT,
    questions INTEGER DEFAULT 0
);

-- 2. Create user_sessions table
CREATE TABLE IF NOT EXISTS user_sessions (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_email ON user_sessions(email);

-- 3. Create chat_limits table
CREATE TABLE IF NOT EXISTS chat_limits (
    identifier TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0,
    last_reset TEXT DEFAULT (datetime('now')),
    timezone TEXT DEFAULT 'UTC'
);

-- 4. Create chat_history table
CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identifier TEXT NOT NULL,
    role TEXT NOT NULL,
    message TEXT NOT NULL,
    context TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_history_identifier ON chat_history(identifier);
