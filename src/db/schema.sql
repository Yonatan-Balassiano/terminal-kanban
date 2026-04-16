CREATE TABLE IF NOT EXISTS _schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  github_owner TEXT,
  github_repo TEXT,
  default_base_branch TEXT NOT NULL DEFAULT 'main',
  default_pillar_id TEXT,
  health TEXT NOT NULL DEFAULT 'ok',
  github_url TEXT,
  preferred_ide TEXT,
  ide_command TEXT,
  worktree_mode TEXT NOT NULL DEFAULT 'auto',
  worktree_root TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pillars (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  icon TEXT,
  color TEXT
);

CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  color TEXT
);

CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL,
  pillar_id TEXT REFERENCES pillars(id) ON DELETE SET NULL,
  branch_name TEXT,
  worktree_path TEXT,
  session_id TEXT,
  sort_key REAL NOT NULL DEFAULT 0,
  pr_number INTEGER,
  pr_state TEXT NOT NULL DEFAULT 'none',
  pr_draft INTEGER NOT NULL DEFAULT 0,
  pr_url TEXT,
  ci_state TEXT NOT NULL DEFAULT 'none',
  review_state TEXT NOT NULL DEFAULT 'none',
  unresolved_thread_count INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  description TEXT,
  last_session_cwd TEXT,
  ci_summary TEXT,
  failing_check_name TEXT,
  review_summary TEXT,
  git_state TEXT NOT NULL DEFAULT 'unknown',
  git_ahead_count INTEGER NOT NULL DEFAULT 0,
  git_behind_count INTEGER NOT NULL DEFAULT 0,
  has_untracked INTEGER NOT NULL DEFAULT 0,
  has_conflicts INTEGER NOT NULL DEFAULT 0,
  github_sync_status TEXT NOT NULL DEFAULT 'idle',
  github_sync_error TEXT,
  github_last_synced_at INTEGER,
  ci_required_total INTEGER NOT NULL DEFAULT 0,
  ci_required_passed INTEGER NOT NULL DEFAULT 0,
  ci_required_failed INTEGER NOT NULL DEFAULT 0,
  ci_required_pending INTEGER NOT NULL DEFAULT 0,
  session_attention_needed INTEGER NOT NULL DEFAULT 0,
  session_attention_updated_at INTEGER,
  agent_cli TEXT NOT NULL DEFAULT 'claude',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_labels (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  backend_type TEXT NOT NULL DEFAULT 'tmux',
  backend_session_id TEXT,
  attach_command TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  cwd TEXT,
  branch TEXT,
  last_heartbeat INTEGER,
  last_buffer_snapshot TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS saved_views (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  filters_json TEXT NOT NULL DEFAULT '{}',
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ui_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

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

CREATE INDEX IF NOT EXISTS idx_tasks_repo ON tasks(repo_id);
CREATE INDEX IF NOT EXISTS idx_tasks_track ON tasks(track_id);
CREATE INDEX IF NOT EXISTS idx_tasks_pillar ON tasks(pillar_id);
CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived_at);
CREATE INDEX IF NOT EXISTS idx_tasks_sort ON tasks(track_id, sort_key);
CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_missions_sort ON missions(sort_key);
CREATE INDEX IF NOT EXISTS idx_mission_tasks_mission ON mission_tasks(mission_id, sort_key);
CREATE INDEX IF NOT EXISTS idx_mission_tasks_released ON mission_tasks(released_to_board);
CREATE INDEX IF NOT EXISTS idx_mission_deps_blocked ON mission_dependencies(blocked_task_id);
CREATE INDEX IF NOT EXISTS idx_mission_deps_blocker ON mission_dependencies(blocker_task_id);
