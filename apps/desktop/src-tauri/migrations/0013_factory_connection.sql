CREATE TABLE IF NOT EXISTS factory_connection (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    mode TEXT NOT NULL CHECK (mode IN ('demo', 'live')),
    endpoint TEXT NOT NULL,
    credential_reference TEXT
);
