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
    daily_solver_ticks INTEGER DEFAULT 0,
    last_solver_reset TIMESTAMP WITH TIME ZONE,
    timezone VARCHAR(50)
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
    base_name VARCHAR(255) NOT NULL DEFAULT 'Experiment',
    name VARCHAR(255) NOT NULL DEFAULT 'Experiment',
    state JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_simulation_sessions_email ON simulation_sessions(email);

-- Functions (RPC)
CREATE OR REPLACE FUNCTION bulk_increment_time_spent(updates JSONB)
RETURNS VOID AS $$
BEGIN
    -- No-op: seconds_spent is removed from schema
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION bulk_increment_user_stats(updates JSONB)
RETURNS VOID AS $$
DECLARE
    item RECORD;
BEGIN
    FOR item IN 
        SELECT * FROM jsonb_to_recordset(updates) AS (email VARCHAR(255), ticks INTEGER)
    LOOP
        UPDATE users 
        SET solver_ticks = COALESCE(solver_ticks, 0) + COALESCE(item.ticks, 0),
            daily_solver_ticks = COALESCE(daily_solver_ticks, 0) + COALESCE(item.ticks, 0)
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
    // Add new columns to users table if they do not exist
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_solver_ticks INTEGER DEFAULT 0');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_solver_reset TIMESTAMP WITH TIME ZONE');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone VARCHAR(50)');
    // Explicitly drop seconds_spent column if it exists in existing database
    await client.query('ALTER TABLE users DROP COLUMN IF EXISTS seconds_spent');
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
