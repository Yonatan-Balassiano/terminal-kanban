ALTER TABLE tasks ADD COLUMN secondary_session_id TEXT;
ALTER TABLE sessions ADD COLUMN slot TEXT NOT NULL DEFAULT 'primary';
