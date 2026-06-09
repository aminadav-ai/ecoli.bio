import pg from 'pg';

const schemaSql = `
-- 1. Create users table
CREATE TABLE IF NOT EXISTS users (
    email VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    premium_until TIMESTAMP WITH TIME ZONE,
    premium_tier INTEGER DEFAULT 0,
    auto_renew BOOLEAN DEFAULT FALSE,
    solver_ticks INTEGER DEFAULT 0,
    visits INTEGER DEFAULT 0,
    last_visit TIMESTAMP WITH TIME ZONE,
    questions INTEGER DEFAULT 0,
    seconds_spent INTEGER DEFAULT 0
);

-- 2. Create user_sessions table
CREATE TABLE IF NOT EXISTS user_sessions (
    token UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) REFERENCES users(email) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_email ON user_sessions(email);

-- 3. Create chat_limits table
CREATE TABLE IF NOT EXISTS chat_limits (
    identifier VARCHAR(255) PRIMARY KEY,
    count INTEGER DEFAULT 0,
    last_reset TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    timezone VARCHAR(50) DEFAULT 'UTC'
);

-- 4. Create chat_history table
CREATE TABLE IF NOT EXISTS chat_history (
    id BIGSERIAL PRIMARY KEY,
    identifier VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    context JSONB DEFAULT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chat_history_identifier ON chat_history(identifier);

-- 5. Create simulation_sessions table
CREATE TABLE IF NOT EXISTS simulation_sessions (
    id VARCHAR(255) PRIMARY KEY,
    email VARCHAR(255) REFERENCES users(email) ON DELETE CASCADE,
    state JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_simulation_sessions_email ON simulation_sessions(email);

-- Functions (RPC)
CREATE OR REPLACE FUNCTION bulk_increment_time_spent(updates JSONB)
RETURNS VOID AS $$
DECLARE
    item RECORD;
BEGIN
    FOR item IN 
        SELECT * FROM jsonb_to_recordset(updates) AS (email VARCHAR(255), seconds INTEGER)
    LOOP
        UPDATE users 
        SET seconds_spent = COALESCE(seconds_spent, 0) + item.seconds 
        WHERE email = item.email;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION bulk_increment_user_stats(updates JSONB)
RETURNS VOID AS $$
DECLARE
    item RECORD;
BEGIN
    FOR item IN 
        SELECT * FROM jsonb_to_recordset(updates) AS (email VARCHAR(255), seconds INTEGER, ticks INTEGER)
    LOOP
        UPDATE users 
        SET seconds_spent = COALESCE(seconds_spent, 0) + COALESCE(item.seconds, 0),
            solver_ticks = COALESCE(solver_ticks, 0) + COALESCE(item.ticks, 0)
        WHERE email = item.email;
    END LOOP;
END;
$$ LANGUAGE plpgsql;
`;

export async function initializeDatabase(pool) {
  console.log('[DB Init] Checking and initializing database schema...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(schemaSql);
    await client.query('COMMIT');
    console.log('[DB Init] Database schema initialized successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DB Init] Failed to initialize database schema:', err);
    throw err;
  } finally {
    client.release();
  }
}
