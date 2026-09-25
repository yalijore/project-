-- Keel schema v1.
-- Conventions:
--   * ids are TEXT (UUID v4), timestamps are UTC ISO-8601 strings ("2026-09-25T13:00:00.000Z"),
--     calendar dates are floating "YYYY-MM-DD" strings.
--   * A task's deadline (tasks.due_date), the day it is planned for (day_plan_entries.plan_date)
--     and its scheduled time (time_blocks) are three independent things.

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,             -- JSON
  updated_at TEXT NOT NULL
);

CREATE TABLE areas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  sort_order REAL NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  area_id TEXT REFERENCES areas(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  sort_order REAL NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_projects_area ON projects(area_id);

-- A recurring task series. Instances are ordinary rows in `tasks` that point back here.
CREATE TABLE recurrence_series (
  id TEXT PRIMARY KEY,
  rrule TEXT NOT NULL,             -- RFC 5545 RRULE value, e.g. FREQ=WEEKLY;BYDAY=MO,WE
  dtstart TEXT NOT NULL,           -- first occurrence (floating date)
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  area_id TEXT REFERENCES areas(id) ON DELETE SET NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  estimate_min INTEGER,
  tag_ids TEXT NOT NULL DEFAULT '[]',     -- JSON array of tag ids
  subtasks TEXT NOT NULL DEFAULT '[]',    -- JSON array of subtask titles
  start_time TEXT,                 -- optional "HH:MM" wall-clock time to auto-timebox
  due_offset_days INTEGER,         -- optional deadline = occurrence + N days
  generated_through TEXT,          -- last occurrence date materialized as a task row
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE recurrence_exceptions (
  series_id TEXT NOT NULL REFERENCES recurrence_series(id) ON DELETE CASCADE,
  occurrence_date TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'skip' CHECK (kind IN ('skip')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (series_id, occurrence_date)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  area_id TEXT REFERENCES areas(id) ON DELETE SET NULL,
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
  estimate_min INTEGER CHECK (estimate_min IS NULL OR estimate_min >= 0),
  due_date TEXT,                   -- deadline (floating date)
  backlog_order REAL NOT NULL DEFAULT 0,
  completed_at TEXT,
  archived_at TEXT,
  recurrence_id TEXT REFERENCES recurrence_series(id) ON DELETE SET NULL,
  recurrence_date TEXT,            -- which occurrence of the series this row is
  source TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_tasks_recurrence ON tasks(recurrence_id, recurrence_date)
  WHERE recurrence_id IS NOT NULL;
CREATE INDEX ix_tasks_project ON tasks(project_id);
CREATE INDEX ix_tasks_completed ON tasks(completed_at);

CREATE TABLE subtasks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  completed_at TEXT,
  sort_order REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_subtasks_task ON subtasks(task_id);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);
CREATE INDEX ix_task_tags_tag ON task_tags(tag_id);

CREATE TABLE task_links (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  sort_order REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_task_links_task ON task_links(task_id);

-- Which day a task is planned for. Exactly one "current" row (active or done) per task;
-- closed rows are kept as history for rollover counts and planned-vs-actual reviews.
CREATE TABLE day_plan_entries (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  plan_date TEXT NOT NULL,
  sort_order REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('active', 'done', 'rolled_over', 'moved', 'removed')),
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE UNIQUE INDEX ux_plan_current ON day_plan_entries(task_id)
  WHERE status IN ('active', 'done');
CREATE INDEX ix_plan_date ON day_plan_entries(plan_date, status);

CREATE TABLE integration_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected',
  config TEXT NOT NULL DEFAULT '{}',       -- non-secret options; secrets live in the OS keychain
  sync_state TEXT NOT NULL DEFAULT '{}',   -- provider cursors (sync tokens, delta links)
  last_sync_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE calendars (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES integration_accounts(id) ON DELETE CASCADE,
  source TEXT NOT NULL,            -- 'local' | 'ics-import' | 'ics-subscription' | provider id
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  timezone TEXT,
  is_visible INTEGER NOT NULL DEFAULT 1,
  is_writable INTEGER NOT NULL DEFAULT 1,
  counts_for_availability INTEGER NOT NULL DEFAULT 1,
  sort_order REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Meetings and other events. Never mixed with Keel's own time blocks.
CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  uid TEXT,                        -- iCalendar UID
  recurrence_id TEXT,              -- RECURRENCE-ID of an overridden instance (ISO)
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  url TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  start_utc TEXT,
  end_utc TEXT,
  start_date TEXT,                 -- all-day: floating dates, end exclusive
  end_date TEXT,
  tz TEXT,                         -- IANA zone of DTSTART (drives recurrence expansion)
  rrule TEXT,
  exdates TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'tentative', 'cancelled')),
  busy INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((all_day = 1 AND start_date IS NOT NULL AND end_date IS NOT NULL)
      OR (all_day = 0 AND start_utc IS NOT NULL AND end_utc IS NOT NULL AND end_utc >= start_utc))
);
CREATE INDEX ix_events_calendar_start ON calendar_events(calendar_id, start_utc);
CREATE INDEX ix_events_start_date ON calendar_events(start_date);
CREATE UNIQUE INDEX ux_events_uid ON calendar_events(calendar_id, uid, ifnull(recurrence_id, ''))
  WHERE uid IS NOT NULL;

-- A task scheduled into a specific interval ("timebox").
CREATE TABLE time_blocks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  tz TEXT NOT NULL,                -- zone the block was planned in
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (end_utc > start_utc)
);
CREATE INDEX ix_blocks_start ON time_blocks(start_utc);
CREATE INDEX ix_blocks_task ON time_blocks(task_id);

-- Tracked work. A row with end_utc NULL is the running timer; at most one may exist.
CREATE TABLE time_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  start_utc TEXT NOT NULL,
  end_utc TEXT,
  heartbeat_utc TEXT,
  source TEXT NOT NULL DEFAULT 'timer' CHECK (source IN ('timer', 'manual')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (end_utc IS NULL OR end_utc >= start_utc)
);
CREATE UNIQUE INDEX ux_single_running_timer ON time_sessions((end_utc IS NULL))
  WHERE end_utc IS NULL;
CREATE INDEX ix_sessions_task ON time_sessions(task_id);
CREATE INDEX ix_sessions_start ON time_sessions(start_utc);

-- Planning / shutdown / weekly review history.
CREATE TABLE rituals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('plan', 'shutdown', 'weekly')),
  period TEXT NOT NULL,            -- the day (or first day of the week for 'weekly')
  started_at TEXT,
  completed_at TEXT,
  reflection TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (kind, period)
);

CREATE TABLE integration_mappings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES integration_accounts(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,       -- 'task' | 'event' | 'time_block' | 'calendar' | 'project'
  local_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_version TEXT,
  external_url TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('remote', 'local')),
  last_synced_at TEXT,
  UNIQUE (account_id, entity_type, external_id),
  UNIQUE (account_id, entity_type, local_id)
);

-- Undo support (see src/db/undo.ts). Triggers generated at startup append inverse SQL here.
CREATE TABLE undo_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE undo_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  stmt TEXT NOT NULL
);
CREATE INDEX ix_undo_log_group ON undo_log(group_id);
CREATE TABLE undo_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_group INTEGER
);
INSERT INTO undo_state (id, current_group) VALUES (1, NULL);
