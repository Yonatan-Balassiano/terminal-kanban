CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mission_steps (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  depends_on_step_id TEXT REFERENCES mission_steps(id) ON DELETE SET NULL,
  linked_task_id TEXT UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status);
CREATE INDEX IF NOT EXISTS idx_mission_steps_mission ON mission_steps(mission_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_mission_steps_repo ON mission_steps(repo_id);
CREATE INDEX IF NOT EXISTS idx_mission_steps_dependency ON mission_steps(depends_on_step_id);
