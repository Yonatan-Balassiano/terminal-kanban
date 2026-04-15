ALTER TABLE tasks ADD COLUMN session_attention_needed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN session_attention_updated_at INTEGER;
