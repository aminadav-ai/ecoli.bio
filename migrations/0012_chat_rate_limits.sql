-- Daily AI chat counters used to cap Gemini usage per guest IP and per registered user
CREATE TABLE IF NOT EXISTS chat_rate_limits (
    key TEXT NOT NULL,              -- 'ip:<address>' or 'user:<email>'
    day TEXT NOT NULL,              -- YYYY-MM-DD (UTC)
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key, day)
);
