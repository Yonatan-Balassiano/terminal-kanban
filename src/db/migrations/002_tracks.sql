-- Tracks (kanban columns) stored in DB so services can query them directly
CREATE TABLE IF NOT EXISTS tracks (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
