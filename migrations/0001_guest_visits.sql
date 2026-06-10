CREATE TABLE IF NOT EXISTS guest_visits (
    session_id TEXT NOT NULL,
    visit_date TEXT NOT NULL, -- format YYYY-MM-DD (UTC)
    visit_count INTEGER DEFAULT 1,
    PRIMARY KEY (session_id, visit_date)
);

CREATE INDEX IF NOT EXISTS idx_guest_visits_date ON guest_visits(visit_date);
