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
  remote_path TEXT,
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
  -- 'repo' tasks own a branch and a worktree in repo_id; 'general' tasks carry
  -- none of that, so repo_id is NULL for them.
  kind TEXT NOT NULL DEFAULT 'repo',
  -- Set when this card was spun off from another one via `agentboard task
  -- create` run inside the parent's session. NULL for everything else.
  parent_task_id TEXT,
  -- The child task whose PR just opened, so this card can flag "review this
  -- subtask's PR" until acknowledged. NULL when there is nothing to review.
  child_pr_alert_task_id TEXT,
  -- Marks the card that coordinates other cards (typically its own subtasks).
  -- Purely presentational: the TUI pins it to the top of its column and gives
  -- it a distinct background. Set via `agentboard task orchestrator`.
  is_orchestrator INTEGER NOT NULL DEFAULT 0,
  -- When the card was pinned to the top of its list on the web board (among
  -- its siblings, for a subtask). NULL when not pinned. Set via `setTaskPinned`.
  pinned_at INTEGER,
  -- The agent CLI's own --name, so this card's session is addressable by a
  -- readable name (SendMessage/ListAgents) rather than only its task id.
  -- Assigned once at creation, same as branch_name; carries the parent's own
  -- session_name as a prefix for a subtask, so hierarchy reads directly off
  -- the flat session list without a lookup.
  session_name TEXT,
  repo_id TEXT REFERENCES repos(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL,
  pillar_id TEXT REFERENCES pillars(id) ON DELETE SET NULL,
  branch_name TEXT,
  worktree_path TEXT,
  session_id TEXT,
  secondary_session_id TEXT,
  sort_key REAL NOT NULL DEFAULT 0,
  pr_number INTEGER,
  pr_state TEXT NOT NULL DEFAULT 'none',
  pr_draft INTEGER NOT NULL DEFAULT 0,
  pr_url TEXT,
  ci_state TEXT NOT NULL DEFAULT 'none',
  review_state TEXT NOT NULL DEFAULT 'none',
  unresolved_thread_count INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER, -- unused: cards are no longer archived; kept so existing databases need no migration
  description TEXT,
  -- The card's brief, handed to the agent as its opening prompt the first time
  -- a conversation starts. Kept apart from `description` so a card whose notes
  -- were only ever meant for a human never turns into a prompt.
  initial_prompt TEXT,
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
  location TEXT NOT NULL DEFAULT 'local',
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
  slot TEXT NOT NULL DEFAULT 'primary',
  backend_type TEXT NOT NULL DEFAULT 'tmux',
  backend_session_id TEXT,
  attach_command TEXT,
  -- The agent CLI's own conversation id, so relaunching a card resumes the
  -- conversation instead of starting a blank one. Carried forward across
  -- session rows for the same task and slot.
  agent_session_id TEXT,
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

-- One repo + branch a card is working in, with the pull request that branch
-- carries. A feature spanning several repositories has one row per repository,
-- and stacked work in one repository has one row per branch — hence the
-- identity below being (task, repo, branch) rather than (task, repo).
--
-- The matching columns on tasks are a rollup of these rows, kept so everything
-- that only wants "how is this card doing?" reads one row as it always has.
CREATE TABLE IF NOT EXISTS task_branches (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  branch_name TEXT NOT NULL,
  base_branch TEXT,
  worktree_path TEXT,
  sort_key REAL NOT NULL DEFAULT 0,
  pr_number INTEGER,
  pr_url TEXT,
  pr_state TEXT NOT NULL DEFAULT 'none',
  pr_draft INTEGER NOT NULL DEFAULT 0,
  merge_commit_sha TEXT,
  merged_at INTEGER,
  ci_state TEXT NOT NULL DEFAULT 'none',
  ci_summary TEXT,
  failing_check_name TEXT,
  ci_required_total INTEGER NOT NULL DEFAULT 0,
  ci_required_passed INTEGER NOT NULL DEFAULT 0,
  ci_required_failed INTEGER NOT NULL DEFAULT 0,
  ci_required_pending INTEGER NOT NULL DEFAULT 0,
  review_state TEXT NOT NULL DEFAULT 'none',
  review_summary TEXT,
  unresolved_thread_count INTEGER NOT NULL DEFAULT 0,
  git_state TEXT NOT NULL DEFAULT 'unknown',
  git_ahead_count INTEGER NOT NULL DEFAULT 0,
  git_behind_count INTEGER NOT NULL DEFAULT 0,
  has_untracked INTEGER NOT NULL DEFAULT 0,
  has_conflicts INTEGER NOT NULL DEFAULT 0,
  github_sync_status TEXT NOT NULL DEFAULT 'idle',
  github_sync_error TEXT,
  github_last_synced_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_branches_identity
  ON task_branches(task_id, repo_id, branch_name);
CREATE INDEX IF NOT EXISTS idx_task_branches_task ON task_branches(task_id, sort_key);
CREATE INDEX IF NOT EXISTS idx_task_branches_lookup ON task_branches(repo_id, branch_name);

-- How far each merged pull request has travelled towards production, per
-- artifact it touched. Keyed by the pull request rather than by any task-side
-- row so it survives the card's own branch bookkeeping changing shape.
--
-- artifact_name is '' for a verdict that belongs to the pull request as a whole
-- (nothing tracked to ship, or the repository is not tracked at all).
CREATE TABLE IF NOT EXISTS pr_release_status (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  repo_slug TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  artifact_name TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'unknown',
  confidence TEXT NOT NULL DEFAULT 'unknown',
  evidence TEXT NOT NULL DEFAULT 'none',
  reason TEXT,
  gates INTEGER NOT NULL DEFAULT 1,
  containing_rc_version TEXT,
  containing_rc_commit TEXT,
  ga_version_at_check TEXT,
  rollout_to_version TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL,
  next_check_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, repo_slug, pr_number, artifact_name)
);

-- Messages sent to a card whose session was not running at the time.
--
-- `agentboard task notify` types into a live pane; with no pane the message
-- used to be dropped and reported as undelivered, which is why the board
-- needed a badge to stand in for it. Queued here instead, it is handed to the
-- agent on the card's own argv the next time its session opens — so a
-- cross-task message reaches the conversation whether or not anyone was
-- listening when it was sent.
CREATE TABLE IF NOT EXISTS pending_messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  slot TEXT NOT NULL DEFAULT 'primary',
  body TEXT NOT NULL,
  -- The card that sent it, when a card sent it. NULL for a person.
  from_task_id TEXT,
  created_at INTEGER NOT NULL,
  -- Set when a session was launched to carry this message, cleared/removed
  -- once that hand-off is resolved. A row is NOT deleted at launch: the pane
  -- may die before the agent ever reads it. See PendingMessageService.
  claimed_session_id TEXT,
  claimed_at INTEGER,
  -- The prompt file the claiming session was supposed to read. Its continued
  -- existence is the proof the hand-off never happened.
  claim_notice_path TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_messages_task ON pending_messages(task_id, slot);

CREATE INDEX IF NOT EXISTS idx_pr_release_next_check ON pr_release_status(next_check_at);
CREATE INDEX IF NOT EXISTS idx_pr_release_task ON pr_release_status(task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_repo ON tasks(repo_id);
CREATE INDEX IF NOT EXISTS idx_tasks_track ON tasks(track_id);
CREATE INDEX IF NOT EXISTS idx_tasks_pillar ON tasks(pillar_id);
CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived_at);
CREATE INDEX IF NOT EXISTS idx_tasks_sort ON tasks(track_id, sort_key);
CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
