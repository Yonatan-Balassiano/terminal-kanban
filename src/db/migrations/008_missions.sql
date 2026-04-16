CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  sort_key REAL NOT NULL DEFAULT 0,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mission_tasks (
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  sort_key REAL NOT NULL DEFAULT 0,
  released_to_board INTEGER NOT NULL DEFAULT 0,
  released_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (mission_id, task_id)
);

CREATE TABLE IF NOT EXISTS mission_dependencies (
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  blocker_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocked_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (mission_id, blocker_task_id, blocked_task_id)
);

CREATE INDEX IF NOT EXISTS idx_missions_sort ON missions(sort_key);
CREATE INDEX IF NOT EXISTS idx_mission_tasks_mission ON mission_tasks(mission_id, sort_key);
CREATE INDEX IF NOT EXISTS idx_mission_tasks_released ON mission_tasks(released_to_board);
CREATE INDEX IF NOT EXISTS idx_mission_deps_blocked ON mission_dependencies(blocked_task_id);
CREATE INDEX IF NOT EXISTS idx_mission_deps_blocker ON mission_dependencies(blocker_task_id);
