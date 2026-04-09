CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    room_id TEXT UNIQUE,
    name TEXT NOT NULL UNIQUE,
    working_directory TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT 'sonnet',
    permission_mode TEXT NOT NULL DEFAULT 'default',
    port INTEGER,
    pid INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_message_at TEXT
);

CREATE TABLE IF NOT EXISTS permission_requests (
    request_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    event_id TEXT,
    tool_name TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions (id)
);

CREATE TABLE IF NOT EXISTS config (
    "key" TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
