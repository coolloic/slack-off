// Ordered migrations; index + 1 is the PRAGMA user_version after applying.
// JSON columns are TEXT; timestamps are ISO-8601 TEXT.
const m1 = `
CREATE TABLE ticket (
  key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT,
  jira_status TEXT,
  state TEXT NOT NULL,
  prev_state TEXT,
  blocked_reason TEXT,
  review_ac INTEGER NOT NULL DEFAULT 0,
  repo_path TEXT,
  branch TEXT,
  worktree_path TEXT,
  review_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ticket_snapshot (
  id INTEGER PRIMARY KEY,
  ticket_key TEXT NOT NULL REFERENCES ticket(key),
  prev_snapshot_id INTEGER REFERENCES ticket_snapshot(id),
  fetched_at TEXT NOT NULL,
  jira_updated_at TEXT,
  title TEXT NOT NULL,
  description TEXT,
  content_hash TEXT NOT NULL,
  change_summary TEXT
);
CREATE INDEX idx_snapshot_ticket ON ticket_snapshot(ticket_key);

CREATE TABLE snapshot_comment (
  id INTEGER PRIMARY KEY,
  snapshot_id INTEGER NOT NULL REFERENCES ticket_snapshot(id),
  jira_comment_id TEXT,
  author TEXT,
  created TEXT,
  body TEXT
);

CREATE TABLE snapshot_attachment (
  id INTEGER PRIMARY KEY,
  snapshot_id INTEGER NOT NULL REFERENCES ticket_snapshot(id),
  kind TEXT NOT NULL CHECK (kind IN ('attachment','inline_image')),
  filename TEXT,
  mime TEXT,
  local_path TEXT,
  sha256 TEXT,
  url TEXT
);

CREATE TABLE requirement (
  id INTEGER PRIMARY KEY,
  ticket_key TEXT NOT NULL REFERENCES ticket(key),
  snapshot_id INTEGER NOT NULL REFERENCES ticket_snapshot(id),
  version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  draft_comment TEXT,
  source TEXT NOT NULL CHECK (source IN ('agent','human')),
  created_at TEXT NOT NULL,
  UNIQUE (ticket_key, version)
);

CREATE TABLE ac_trace (
  id INTEGER PRIMARY KEY,
  requirement_id INTEGER NOT NULL REFERENCES requirement(id),
  ac_id TEXT NOT NULL,
  snapshot_id INTEGER NOT NULL REFERENCES ticket_snapshot(id),
  source_type TEXT NOT NULL CHECK (source_type IN ('description','comment','attachment','developer')),
  source_ref TEXT,
  quote TEXT,
  reason TEXT
);

CREATE TABLE drift_check (
  id INTEGER PRIMARY KEY,
  ticket_key TEXT NOT NULL REFERENCES ticket(key),
  requirement_id INTEGER NOT NULL REFERENCES requirement(id),
  baseline_snapshot_id INTEGER NOT NULL REFERENCES ticket_snapshot(id),
  latest_snapshot_id INTEGER NOT NULL REFERENCES ticket_snapshot(id),
  trigger TEXT NOT NULL CHECK (trigger IN ('ac_edited','snapshot_changed','before_review')),
  result_json TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE solution (
  id INTEGER PRIMARY KEY,
  ticket_key TEXT NOT NULL REFERENCES ticket(key),
  requirement_id INTEGER NOT NULL REFERENCES requirement(id),
  idx INTEGER NOT NULL,
  content_json TEXT NOT NULL
);

CREATE TABLE choice (
  id INTEGER PRIMARY KEY,
  ticket_key TEXT NOT NULL REFERENCES ticket(key),
  solution_id INTEGER NOT NULL REFERENCES solution(id),
  requirement_id INTEGER NOT NULL REFERENCES requirement(id),
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE prompt_version (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL,
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (role, version)
);

CREATE TABLE agent_run (
  id TEXT PRIMARY KEY,
  ticket_key TEXT REFERENCES ticket(key),
  role TEXT NOT NULL,
  executor TEXT NOT NULL CHECK (executor IN ('claude-code','claude-api')),
  skill_version TEXT,
  prompt_version_id INTEGER REFERENCES prompt_version(id),
  status TEXT NOT NULL CHECK (status IN ('running','ok','invalid_output','error')),
  cost_usd REAL,
  usage_json TEXT,
  permission_denials_json TEXT NOT NULL DEFAULT '[]',
  raw_log_path TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE audit_event (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  ticket_key TEXT REFERENCES ticket(key),
  payload_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE TRIGGER ticket_snapshot_no_update BEFORE UPDATE ON ticket_snapshot
BEGIN SELECT RAISE(ABORT, 'snapshots are immutable'); END;
CREATE TRIGGER ticket_snapshot_no_delete BEFORE DELETE ON ticket_snapshot
BEGIN SELECT RAISE(ABORT, 'snapshots are immutable'); END;
CREATE TRIGGER snapshot_comment_no_update BEFORE UPDATE ON snapshot_comment
BEGIN SELECT RAISE(ABORT, 'snapshots are immutable'); END;
CREATE TRIGGER snapshot_comment_no_delete BEFORE DELETE ON snapshot_comment
BEGIN SELECT RAISE(ABORT, 'snapshots are immutable'); END;
CREATE TRIGGER snapshot_attachment_no_update BEFORE UPDATE ON snapshot_attachment
BEGIN SELECT RAISE(ABORT, 'snapshots are immutable'); END;
CREATE TRIGGER snapshot_attachment_no_delete BEFORE DELETE ON snapshot_attachment
BEGIN SELECT RAISE(ABORT, 'snapshots are immutable'); END;
CREATE TRIGGER audit_event_no_update BEFORE UPDATE ON audit_event
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER audit_event_no_delete BEFORE DELETE ON audit_event
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
`;

// Phone remote access (task 15): paired devices and one-time pairing codes. Only sha256 hashes are stored.
const m2 = `
CREATE TABLE paired_device (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE TABLE pairing_code (
  code_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
`;

// F-I7: the browser agent could not load every comment (older ones collapsed in JIRA); null = complete.
const m3 = `
ALTER TABLE ticket_snapshot ADD COLUMN comments_not_loaded INTEGER;
`;

// H7: INSERT OR REPLACE / REPLACE INTO resolves a primary-key conflict by deleting the old row, which does not
// fire the BEFORE DELETE guards unless recursive_triggers is on. Refuse any insert onto an existing id instead.
const guard = (table: string, message: string) => `
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table}
WHEN EXISTS (SELECT 1 FROM ${table} WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, '${message}'); END;`;
const m4 = [
  guard("ticket_snapshot", "snapshots are immutable"),
  guard("snapshot_comment", "snapshots are immutable"),
  guard("snapshot_attachment", "snapshots are immutable"),
  guard("audit_event", "audit log is append-only"),
].join("\n");

// Author decision 2026-11-06: discovery reads every open ticket assigned to the developer.
// ticket.jira_open: 0 = a complete discovery no longer returned it (closed or reassigned in JIRA); NULL/1 = open.
// discovery_run: the outcome of each successful discovery (returned of total, complete or stopped at the limit).
const m5 = `
ALTER TABLE ticket ADD COLUMN jira_open INTEGER;

CREATE TABLE discovery_run (
  id INTEGER PRIMARY KEY,
  finished_at TEXT NOT NULL,
  returned INTEGER NOT NULL,
  total INTEGER NOT NULL,
  complete INTEGER NOT NULL CHECK (complete IN (0, 1))
);
`;

// Phase 2: design debate, development iterations, JIRA writes and per-repo ticket workspaces.
// One ADD COLUMN per statement (P-C14). debate_round, debate_ruling and dev_step are append-only;
// a design doc is immutable except for flipping is_final from 0 to 1.
const noUpdateDelete = (table: string, message: string) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, '${message}'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, '${message}'); END;`;
const m6 = [
  `
ALTER TABLE choice ADD COLUMN affected_repos_json TEXT;
ALTER TABLE agent_run ADD COLUMN rules_hash TEXT;
ALTER TABLE agent_run ADD COLUMN repo_prompt_hash TEXT;

CREATE TABLE ticket_repo (
  ticket_key TEXT NOT NULL REFERENCES ticket(key),
  repo_name TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  branch TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  install_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ticket_key, repo_name)
);

CREATE TABLE design_doc (
  id INTEGER PRIMARY KEY,
  ticket_key TEXT NOT NULL REFERENCES ticket(key),
  requirement_id INTEGER NOT NULL REFERENCES requirement(id),
  choice_id INTEGER NOT NULL REFERENCES choice(id),
  version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  checklist_json TEXT NOT NULL,
  responses_json TEXT NOT NULL,
  is_final INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (ticket_key, version)
);

CREATE TABLE debate_round (
  id INTEGER PRIMARY KEY,
  ticket_key TEXT NOT NULL REFERENCES ticket(key),
  choice_id INTEGER NOT NULL REFERENCES choice(id),
  design_doc_id INTEGER NOT NULL REFERENCES design_doc(id),
  round INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('designer','critic')),
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_debate_round_ticket ON debate_round(ticket_key);

CREATE TABLE debate_ruling (
  id INTEGER PRIMARY KEY,
  ticket_key TEXT NOT NULL REFERENCES ticket(key),
  debate_round_id INTEGER NOT NULL REFERENCES debate_round(id),
  comment_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('designer','critic','custom')),
  note TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (debate_round_id, comment_id)
);

CREATE TABLE dev_iteration (
  id INTEGER PRIMARY KEY,
  ticket_key TEXT NOT NULL REFERENCES ticket(key),
  iteration INTEGER NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('initial','developer_request','review_failed','rejected','retry')),
  note TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','done','failed')),
  summary TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (ticket_key, iteration)
);

CREATE TABLE dev_step (
  id INTEGER PRIMARY KEY,
  iteration_id INTEGER NOT NULL REFERENCES dev_iteration(id),
  step INTEGER NOT NULL,
  summary TEXT NOT NULL,
  repos_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (iteration_id, step)
);

CREATE TABLE jira_write (
  id INTEGER PRIMARY KEY,
  ticket_key TEXT NOT NULL REFERENCES ticket(key),
  target_status TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','confirmed','skipped','done','failed','not_needed')),
  detail TEXT,
  result_json TEXT,
  decided_by TEXT,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_jira_write_ticket ON jira_write(ticket_key);

CREATE TRIGGER design_doc_immutable BEFORE UPDATE ON design_doc
WHEN NOT (
  OLD.is_final = 0 AND NEW.is_final = 1
  AND NEW.id IS OLD.id AND NEW.ticket_key IS OLD.ticket_key AND NEW.requirement_id IS OLD.requirement_id
  AND NEW.choice_id IS OLD.choice_id AND NEW.version IS OLD.version AND NEW.content_json IS OLD.content_json
  AND NEW.checklist_json IS OLD.checklist_json AND NEW.responses_json IS OLD.responses_json
  AND NEW.created_at IS OLD.created_at
)
BEGIN SELECT RAISE(ABORT, 'design docs are immutable'); END;
CREATE TRIGGER design_doc_no_delete BEFORE DELETE ON design_doc
BEGIN SELECT RAISE(ABORT, 'design docs are immutable'); END;`,
  guard("design_doc", "design docs are immutable"),
  noUpdateDelete("debate_round", "debate rounds are immutable"),
  guard("debate_round", "debate rounds are immutable"),
  noUpdateDelete("debate_ruling", "debate rulings are immutable"),
  guard("debate_ruling", "debate rulings are immutable"),
  noUpdateDelete("dev_step", "dev steps are immutable"),
  guard("dev_step", "dev steps are immutable"),
].join("\n");

// Task 11 (T11-2, T11-3): the choice a ticket_repo row was built for, and the one branch name every affected repo uses
// for a choice (chosen when development first starts for it; a new choice starts a new branch from the base branch).
const m7 = `ALTER TABLE ticket_repo ADD COLUMN choice_id INTEGER REFERENCES choice(id);

CREATE TABLE choice_branch (
  choice_id INTEGER PRIMARY KEY REFERENCES choice(id),
  ticket_key TEXT NOT NULL REFERENCES ticket(key),
  branch TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (ticket_key, branch)
);`;

// F2-R1: the git hooks gate pinned per (ticket, repo) when the worktree is first prepared for a choice: core.hooksPath,
// the resolved hooks directory and a fingerprint of its hook files (JSON). Cleared with the branch (a new choice);
// changed only by the developer's explicit "Accept new git hooks".
const m8 = `ALTER TABLE ticket_repo ADD COLUMN hooks_pin_json TEXT;`;

// Phase 3: acceptance review (series = one round of attempts, immutable reports and evidence, developer decisions),
// acceptance runs (process bookkeeping for recovery), deliveries with their steps, and JIRA comments.
// One ADD COLUMN per statement; every new table refuses REPLACE onto an existing id (guard, H7).
const m9 = [
  `
CREATE TABLE review_series (
  id INTEGER PRIMARY KEY,
  ticket_key TEXT NOT NULL REFERENCES ticket(key),
  started_by TEXT NOT NULL CHECK (started_by IN ('handoff','rejected','retry')),
  note TEXT,
  decided_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_review_series_ticket ON review_series(ticket_key);

CREATE TABLE review_report (
  id INTEGER PRIMARY KEY,
  ticket_key TEXT NOT NULL REFERENCES ticket(key),
  series_id INTEGER NOT NULL REFERENCES review_series(id),
  requirement_id INTEGER NOT NULL REFERENCES requirement(id),
  snapshot_id INTEGER NOT NULL REFERENCES ticket_snapshot(id),
  attempt INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('passed','failed','not_executed')),
  report_json TEXT NOT NULL,
  developer_note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (series_id, attempt)
);
CREATE INDEX idx_review_report_ticket ON review_report(ticket_key);

CREATE TABLE review_evidence (
  id INTEGER PRIMARY KEY,
  report_id INTEGER NOT NULL REFERENCES review_report(id),
  ref_key TEXT NOT NULL,
  ac_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('screenshot','http','log')),
  path TEXT NOT NULL,
  caption TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (report_id, ref_key)
);

CREATE TABLE review_decision (
  id INTEGER PRIMARY KEY,
  ticket_key TEXT NOT NULL REFERENCES ticket(key),
  report_id INTEGER NOT NULL REFERENCES review_report(id),
  decision TEXT NOT NULL CHECK (decision IN ('rejected','re_review','confirmed')),
  note TEXT,
  decided_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_review_decision_ticket ON review_decision(ticket_key);

CREATE TABLE acceptance_run (
  id INTEGER PRIMARY KEY,
  ticket_key TEXT NOT NULL REFERENCES ticket(key),
  series_id INTEGER NOT NULL REFERENCES review_series(id),
  attempt INTEGER NOT NULL,
  run_root TEXT NOT NULL,
  pgids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('running','finished','interrupted')),
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE delivery (
  id INTEGER PRIMARY KEY,
  ticket_key TEXT NOT NULL REFERENCES ticket(key),
  report_id INTEGER NOT NULL REFERENCES review_report(id),
  plan_json TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  ack_note TEXT,
  decided_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_delivery_ticket ON delivery(ticket_key);

CREATE TABLE jira_comment (
  id INTEGER PRIMARY KEY,
  ticket_key TEXT NOT NULL REFERENCES ticket(key),
  purpose TEXT NOT NULL CHECK (purpose IN ('clarification','delivery')),
  text TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','confirmed','skipped','done','failed','not_needed')),
  detail TEXT,
  result_json TEXT,
  decided_by TEXT,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_jira_comment_ticket ON jira_comment(ticket_key);

CREATE TABLE delivery_step (
  id INTEGER PRIMARY KEY,
  delivery_id INTEGER NOT NULL REFERENCES delivery(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('snapshot','push','pr','pr_links','jira_status','jira_comment')),
  repo TEXT,
  text TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','running','done','failed','not_needed')),
  detail TEXT,
  result_json TEXT,
  jira_write_id INTEGER REFERENCES jira_write(id),
  jira_comment_id INTEGER REFERENCES jira_comment(id),
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (delivery_id, seq)
);

CREATE TRIGGER delivery_step_no_delete BEFORE DELETE ON delivery_step
BEGIN SELECT RAISE(ABORT, 'delivery steps must not be deleted'); END;
-- the developer confirmed exactly these actions: only state, detail, result, timing and the JIRA links may change
CREATE TRIGGER delivery_step_action_immutable BEFORE UPDATE ON delivery_step
WHEN NOT (
  NEW.id IS OLD.id AND NEW.delivery_id IS OLD.delivery_id AND NEW.seq IS OLD.seq AND NEW.kind IS OLD.kind
  AND NEW.repo IS OLD.repo AND NEW.text IS OLD.text
)
BEGIN SELECT RAISE(ABORT, 'delivery steps: the confirmed action is immutable'); END;
CREATE TRIGGER jira_comment_text_immutable BEFORE UPDATE ON jira_comment
WHEN NOT (NEW.id IS OLD.id AND NEW.ticket_key IS OLD.ticket_key AND NEW.purpose IS OLD.purpose AND NEW.text IS OLD.text)
BEGIN SELECT RAISE(ABORT, 'JIRA comments: ticket, purpose and text are immutable'); END;`,
  noUpdateDelete("review_series", "review series are immutable"),
  guard("review_series", "review series are immutable"),
  noUpdateDelete("review_report", "review reports are immutable"),
  guard("review_report", "review reports are immutable"),
  noUpdateDelete("review_evidence", "review evidence is immutable"),
  guard("review_evidence", "review evidence is immutable"),
  noUpdateDelete("review_decision", "review decisions are immutable"),
  guard("review_decision", "review decisions are immutable"),
  guard("acceptance_run", "acceptance runs cannot be replaced"),
  noUpdateDelete("delivery", "deliveries are immutable"),
  guard("delivery", "deliveries are immutable"),
  guard("delivery_step", "delivery steps must not be deleted or replaced"),
  guard("jira_comment", "JIRA comments cannot be replaced"),
].join("\n");

// Phase 3 Task 9 (T9-6 L1): which development iterations came after a report, by id (never by wall clock).
const m10 = `ALTER TABLE review_report ADD COLUMN after_iteration_id INTEGER;`;

// Phase 3 Task 12 (fix round 1, M2): a delivery step can be `skipped` (the ticket was abandoned before it ran).
// SQLite cannot alter a CHECK: the table is rebuilt with the same rows, then its guards are created again.
const m11 = [
  `
CREATE TABLE delivery_step_new (
  id INTEGER PRIMARY KEY,
  delivery_id INTEGER NOT NULL REFERENCES delivery(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('snapshot','push','pr','pr_links','jira_status','jira_comment')),
  repo TEXT,
  text TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','running','done','failed','not_needed','skipped')),
  detail TEXT,
  result_json TEXT,
  jira_write_id INTEGER REFERENCES jira_write(id),
  jira_comment_id INTEGER REFERENCES jira_comment(id),
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (delivery_id, seq)
);
INSERT INTO delivery_step_new (id, delivery_id, seq, kind, repo, text, state, detail, result_json, jira_write_id, jira_comment_id, started_at, finished_at)
  SELECT id, delivery_id, seq, kind, repo, text, state, detail, result_json, jira_write_id, jira_comment_id, started_at, finished_at FROM delivery_step;
DROP TABLE delivery_step;
ALTER TABLE delivery_step_new RENAME TO delivery_step;
CREATE TRIGGER delivery_step_no_delete BEFORE DELETE ON delivery_step
BEGIN SELECT RAISE(ABORT, 'delivery steps must not be deleted'); END;
-- the developer confirmed exactly these actions: only state, detail, result, timing and the JIRA links may change
CREATE TRIGGER delivery_step_action_immutable BEFORE UPDATE ON delivery_step
WHEN NOT (
  NEW.id IS OLD.id AND NEW.delivery_id IS OLD.delivery_id AND NEW.seq IS OLD.seq AND NEW.kind IS OLD.kind
  AND NEW.repo IS OLD.repo AND NEW.text IS OLD.text
)
BEGIN SELECT RAISE(ABORT, 'delivery steps: the confirmed action is immutable'); END;`,
  guard("delivery_step", "delivery steps must not be deleted or replaced"),
].join("\n");

// Phase 3 Task 12 (T12-5): which drift checks existed when a delivery was confirmed, by id (never by wall clock):
// the confirm-time ack note covers only those.
const m12 = `ALTER TABLE delivery ADD COLUMN drift_id_at_confirm INTEGER;`;

// Phase 4b final fix pass (ruling F4B-4): the JIRA mode a snapshot was read in, and a write or comment was sent in
// ('browser' = the developer's Chrome, 'api' = Jira Cloud REST); NULL = before this column (always the browser) or not
// sent yet. The UI words each row by it.
const m13 = `
ALTER TABLE ticket_snapshot ADD COLUMN jira_source TEXT CHECK (jira_source IN ('browser','api'));
ALTER TABLE jira_write ADD COLUMN jira_source TEXT CHECK (jira_source IN ('browser','api'));
ALTER TABLE jira_comment ADD COLUMN jira_source TEXT CHECK (jira_source IN ('browser','api'));`;

// Phase 4c Task 2 (ruling 4C-0: 4b took m13): the usage pause. One row per pause; a pause is only ever resumed (once),
// never edited or deleted, so the history of why new agent runs stopped stays.
const m14 = `
CREATE TABLE usage_pause (
  id INTEGER PRIMARY KEY,
  reason TEXT NOT NULL CHECK (reason IN ('manual','threshold','limit_reached')),
  detail TEXT NOT NULL,
  paused_by TEXT NOT NULL,
  paused_at TEXT NOT NULL,
  resumed_by TEXT,
  resumed_at TEXT
);
CREATE TRIGGER usage_pause_no_delete BEFORE DELETE ON usage_pause
BEGIN SELECT RAISE(ABORT, 'usage pauses are append-only'); END;
CREATE TRIGGER usage_pause_resume_once BEFORE UPDATE ON usage_pause
WHEN OLD.resumed_at IS NOT NULL OR NEW.resumed_at IS NULL OR NEW.id IS NOT OLD.id OR NEW.reason IS NOT OLD.reason
  OR NEW.detail IS NOT OLD.detail OR NEW.paused_by IS NOT OLD.paused_by OR NEW.paused_at IS NOT OLD.paused_at
BEGIN SELECT RAISE(ABORT, 'usage pauses are append-only: a pause is resumed once'); END;
${guard("usage_pause", "usage pauses are append-only")}`;

// Phase 4c fix round 1 (ruling 4C-1; telemetry takes m16): the usage queries filter agent_run by started_at; and a pause is
// only resumed with a name (L2: the update trigger also rejects a NULL resumed_by).
const m15 = `
CREATE INDEX agent_run_started_at ON agent_run(started_at);
DROP TRIGGER usage_pause_resume_once;
CREATE TRIGGER usage_pause_resume_once BEFORE UPDATE ON usage_pause
WHEN OLD.resumed_at IS NOT NULL OR NEW.resumed_at IS NULL OR NEW.resumed_by IS NULL OR NEW.id IS NOT OLD.id OR NEW.reason IS NOT OLD.reason
  OR NEW.detail IS NOT OLD.detail OR NEW.paused_by IS NOT OLD.paused_by OR NEW.paused_at IS NOT OLD.paused_at
BEGIN SELECT RAISE(ABORT, 'usage pauses are append-only: a pause is resumed once, by someone'); END;`;

// Phase 4c Task 4 (rulings C-5, C-7; 4C-1: telemetry takes m16): each confirmed OTLP export, and which runs it sent.
// An export row is never deleted or replaced; only its outcome is written, once (running → done | failed). A run is
// recorded as exported only after a 2xx, and that record never changes, so a run is never sent twice.
const m16 = `
CREATE TABLE telemetry_export (
  id INTEGER PRIMARY KEY,
  endpoint_host TEXT NOT NULL,
  run_ids_json TEXT NOT NULL,
  run_ids_hash TEXT NOT NULL,
  include_content INTEGER NOT NULL CHECK (include_content IN (0, 1)),
  span_count INTEGER NOT NULL,
  decided_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','done','failed')),
  http_status INTEGER,
  detail TEXT
);
CREATE TRIGGER telemetry_export_no_delete BEFORE DELETE ON telemetry_export
BEGIN SELECT RAISE(ABORT, 'telemetry exports are append-only'); END;
CREATE TRIGGER telemetry_export_finish_once BEFORE UPDATE ON telemetry_export
WHEN OLD.status IS NOT 'running' OR NEW.status NOT IN ('done','failed') OR NEW.finished_at IS NULL
  OR NEW.id IS NOT OLD.id OR NEW.endpoint_host IS NOT OLD.endpoint_host OR NEW.run_ids_json IS NOT OLD.run_ids_json
  OR NEW.run_ids_hash IS NOT OLD.run_ids_hash OR NEW.include_content IS NOT OLD.include_content OR NEW.span_count IS NOT OLD.span_count
  OR NEW.decided_by IS NOT OLD.decided_by OR NEW.requested_at IS NOT OLD.requested_at
BEGIN SELECT RAISE(ABORT, 'telemetry exports are append-only: an export finishes once'); END;
${guard("telemetry_export", "telemetry exports are append-only")}
CREATE TABLE agent_run_exported (
  run_id TEXT PRIMARY KEY REFERENCES agent_run(id),
  export_id INTEGER NOT NULL REFERENCES telemetry_export(id)
);
CREATE TRIGGER agent_run_exported_no_replace BEFORE INSERT ON agent_run_exported
WHEN EXISTS (SELECT 1 FROM agent_run_exported WHERE run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'exported runs are append-only'); END;
${noUpdateDelete("agent_run_exported", "exported runs are append-only")}`;

// Phase 4c fix round 1 (ruling 4C-2, M-5): a run is recorded as exported only by an export that is done (m16 is already
// in the branch history, so this is a new migration rather than an edit of m16).
const m17 = `
CREATE TRIGGER agent_run_exported_done_only BEFORE INSERT ON agent_run_exported
WHEN (SELECT status FROM telemetry_export WHERE id = NEW.export_id) IS NOT 'done'
BEGIN SELECT RAISE(ABORT, 'exported runs are append-only: only a done export marks runs'); END;`;

// Final fix pass (ruling F4C-1, nit): at most one pause is open (pauseUsage already reuses an open pause; this makes it
// a database rule). An older open pause left beside a newer one is closed first, by the system, so the index can be built.
const m18 = `
UPDATE usage_pause SET resumed_by = 'system', resumed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE resumed_at IS NULL AND id < (SELECT MAX(id) FROM usage_pause WHERE resumed_at IS NULL);
CREATE UNIQUE INDEX usage_pause_one_open ON usage_pause ((resumed_at IS NULL)) WHERE resumed_at IS NULL;`;

// Phase 4d Task 1 (ruling 4D-0: the plan's m15 is taken, so m19). Preferences (§9.4, D-1–D-3): one signal per choice
// (features only, never text); a later choice on the same ticket marks the earlier signal superseded (0 -> 1, once) and
// nothing else about a signal ever changes. The summary is a list of versions (derived, edited by the developer, or
// cleared with a cut-off signal id), never changed or deleted. agent_run records the summary version a run saw, and
// (Task 5) why it ran and the hash of an unsaved draft prompt.
const m19 = `
CREATE TABLE preference_signal (
  id INTEGER PRIMARY KEY,
  ticket_key TEXT NOT NULL REFERENCES ticket(key),
  choice_id INTEGER NOT NULL UNIQUE REFERENCES choice(id),
  features_json TEXT NOT NULL,
  superseded INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX preference_signal_ticket ON preference_signal(ticket_key);
CREATE TRIGGER preference_signal_no_delete BEFORE DELETE ON preference_signal
BEGIN SELECT RAISE(ABORT, 'preference signals are append-only'); END;
CREATE TRIGGER preference_signal_supersede_once BEFORE UPDATE ON preference_signal
WHEN OLD.superseded IS NOT 0 OR NEW.superseded IS NOT 1 OR NEW.id IS NOT OLD.id OR NEW.ticket_key IS NOT OLD.ticket_key
  OR NEW.choice_id IS NOT OLD.choice_id OR NEW.features_json IS NOT OLD.features_json OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'preference signals are append-only: a signal is only superseded, once'); END;
${guard("preference_signal", "preference signals are append-only")}
CREATE TABLE preference_summary (
  id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  text TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('derived','edited','cleared')),
  signals_upto INTEGER,
  cleared_before INTEGER,
  decided_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
${noUpdateDelete("preference_summary", "preference summaries are append-only")}
${guard("preference_summary", "preference summaries are append-only")}
ALTER TABLE agent_run ADD COLUMN preference_version INTEGER;
ALTER TABLE agent_run ADD COLUMN purpose TEXT NOT NULL DEFAULT 'ticket' CHECK (purpose IN ('ticket','discover','trial'));
ALTER TABLE agent_run ADD COLUMN draft_hash TEXT;`;

/**
 * Chrome mode: the JIRA address of each attachment a read found, per ticket, file name and position among files of
 * that name. Snapshots stay immutable; an address is how the page shows the image with the developer's JIRA sign-in,
 * not content (snapshot-store recordAttachmentLinks).
 */
const m20 = `
CREATE TABLE attachment_link (
  ticket_key TEXT NOT NULL REFERENCES ticket(key),
  filename TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  url TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ticket_key, filename, ordinal)
);`;

/** The base branch of a ticket's repo when it is not the mapping's default (tickets/base-branch-repo). */
const m21 = `
CREATE TABLE ticket_base_branch (
  ticket_key TEXT NOT NULL REFERENCES ticket(key),
  repo_name TEXT NOT NULL,
  branch TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (ticket_key, repo_name)
);`;

/** A choice whose design is final as the designer writes it: no critic rounds (the developer judged the solution straightforward). */
const m22 = `ALTER TABLE choice ADD COLUMN skip_debate INTEGER NOT NULL DEFAULT 0 CHECK (skip_debate IN (0, 1));`;

/** The ticket branch's conventional type when the developer chose one (feat, fix, docs…; tickets/base-branch-repo). */
const m23 = `
CREATE TABLE ticket_branch_type (
  ticket_key TEXT PRIMARY KEY REFERENCES ticket(key),
  type TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL
);`;

/** The developer's answers on Retry, given to the developer agent with every later step (tickets/dev-note-repo). */
const m24 = `
CREATE TABLE dev_note (
  id INTEGER PRIMARY KEY,
  ticket_key TEXT NOT NULL REFERENCES ticket(key),
  note TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);`;

/** The developer agent's open question and its suggested answers, until a Retry answers it (tickets/dev-note-repo). */
const m25 = `
CREATE TABLE dev_question (
  ticket_key TEXT PRIMARY KEY REFERENCES ticket(key),
  question TEXT NOT NULL,
  options_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);`;

/** The arbiter's recommended ruling per disagreement of an escalated debate (design/design-repo debateAdvice). */
const m26 = `
CREATE TABLE debate_advice (
  choice_id INTEGER NOT NULL REFERENCES choice(id),
  round_id INTEGER NOT NULL REFERENCES debate_round(id),
  comment_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('designer', 'critic', 'custom')),
  note TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (choice_id, round_id, comment_id)
);`;

export const migrations: readonly string[] = [m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11, m12, m13, m14, m15, m16, m17, m18, m19, m20, m21, m22, m23, m24, m25, m26];
