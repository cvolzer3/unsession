-- Unsession — foundation schema (Spec A §2)
-- TEXT ids: app-generated `<prefix>_<random 12 lowercase alnum>` (src/lib/ids.ts)
-- Timestamps: TEXT ISO-8601 UTC. All *_json columns hold JSON as TEXT.

CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT,
  google_id TEXT UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE,
  active_event_id TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE magic_tokens (
  id TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE, token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL,               -- signin | invite | confirm_participation | draft_link
  payload_json TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT
);
CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, is_sandbox INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE org_members (
  org_id TEXT NOT NULL REFERENCES orgs(id), user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,                  -- owner | admin | collaborator
  created_at TEXT NOT NULL, PRIMARY KEY (org_id, user_id)
);
CREATE TABLE invites (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL, invited_by TEXT REFERENCES users(id), status TEXT NOT NULL DEFAULT 'pending', -- pending|accepted|revoked
  created_at TEXT NOT NULL
);
CREATE TABLE events (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE, start_date TEXT NOT NULL, end_date TEXT NOT NULL, timezone TEXT NOT NULL,
  venue TEXT, mode TEXT NOT NULL DEFAULT 'in_person',   -- in_person | online | hybrid
  description TEXT, theme_json TEXT NOT NULL,           -- {primary, accent, bg, font, logoFileId}
  day_start_min INTEGER NOT NULL DEFAULT 30,            -- minutes from 08:00 grid origin (prototype: 08:30 first slot)
  day_end_min INTEGER NOT NULL DEFAULT 600,             -- 18:00
  published INTEGER NOT NULL DEFAULT 0, hide_unconfirmed INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE rooms (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), name TEXT NOT NULL,
  capacity INTEGER, priority INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE taxonomies (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), name TEXT NOT NULL,
  has_color INTEGER NOT NULL DEFAULT 0, has_duration INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE taxonomy_options (
  id TEXT PRIMARY KEY, taxonomy_id TEXT NOT NULL REFERENCES taxonomies(id), name TEXT NOT NULL,
  color TEXT, duration_min INTEGER, position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE forms (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), name TEXT NOT NULL, slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',                 -- draft | open | closed
  opens_at TEXT, closes_at TEXT, settings_json TEXT NOT NULL, -- {allowDrafts,lateLinkSecret,welcomeMd,coSpeakerCap,postSubmitMsg,notifyEmails[]}
  created_at TEXT NOT NULL, UNIQUE (event_id, slug)
);
CREATE TABLE form_versions (
  id TEXT PRIMARY KEY, form_id TEXT NOT NULL REFERENCES forms(id), version INTEGER NOT NULL,
  schema_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (form_id, version)
);
CREATE TABLE submissions (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), form_id TEXT NOT NULL REFERENCES forms(id),
  form_version_id TEXT REFERENCES form_versions(id),
  seq INTEGER NOT NULL,                                 -- per-event sequence; display id = 'SUB-' + seq
  status TEXT NOT NULL DEFAULT 'draft',                 -- draft|submitted|in_review|accepted|confirmed|declined|waitlisted|withdrawn
  title TEXT NOT NULL DEFAULT '', abstract TEXT NOT NULL DEFAULT '',
  answers_json TEXT NOT NULL DEFAULT '{}',              -- {fieldId: value}
  owner_user_id TEXT REFERENCES users(id), agent_mode INTEGER NOT NULL DEFAULT 0,
  withdraw_reason TEXT, submitted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_submissions_event ON submissions(event_id, status);
CREATE TABLE submission_speakers (
  id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES submissions(id), position INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '' COLLATE NOCASE, bio TEXT NOT NULL DEFAULT '',
  headshot_file_id TEXT, user_id TEXT REFERENCES users(id)
);
CREATE TABLE files (
  id TEXT PRIMARY KEY, event_id TEXT REFERENCES events(id), kind TEXT NOT NULL, -- headshot|upload|task_file|logo|sample
  subject_type TEXT, subject_id TEXT, r2_key TEXT NOT NULL, filename TEXT NOT NULL,
  size INTEGER NOT NULL, content_type TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  uploaded_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE comments (
  id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES submissions(id),
  author_user_id TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE activity (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id),
  subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, actor TEXT NOT NULL, -- user name or 'System'
  action TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_activity_subject ON activity(subject_type, subject_id);
CREATE TABLE eval_plans (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), name TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '', deadline TEXT, anonymized INTEGER NOT NULL DEFAULT 1,
  reminders INTEGER NOT NULL DEFAULT 1, reviews_per INTEGER NOT NULL DEFAULT 3,
  rules_json TEXT NOT NULL,                             -- {track:'all'|optId, form:'all'|formId, format:'all'|optId, level:'all'|optId, status:'active'|'all'|<status>}
  criteria_json TEXT NOT NULL,                          -- [{name,hint,scale}]
  automation_json TEXT,                                 -- {on,minLeft,d14,d7,d3,over,cooldown}
  created_at TEXT NOT NULL
);
CREATE TABLE eval_plan_reviewers (
  plan_id TEXT NOT NULL REFERENCES eval_plans(id), user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member',                  -- chair | member
  PRIMARY KEY (plan_id, user_id)
);
CREATE TABLE evaluations (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES eval_plans(id),
  submission_id TEXT NOT NULL REFERENCES submissions(id), reviewer_id TEXT NOT NULL REFERENCES users(id),
  scores_json TEXT NOT NULL DEFAULT '{}',               -- {criterionName: 1..5}
  note TEXT NOT NULL DEFAULT '', abstained INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  UNIQUE (plan_id, submission_id, reviewer_id)
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id),
  submission_id TEXT REFERENCES submissions(id), type TEXT NOT NULL DEFAULT 'talk', -- talk|sponsor|service
  title TEXT NOT NULL, abstract TEXT NOT NULL DEFAULT '',
  track_option_id TEXT REFERENCES taxonomy_options(id), format_option_id TEXT REFERENCES taxonomy_options(id),
  level TEXT, duration_min INTEGER NOT NULL DEFAULT 30,
  room_id TEXT REFERENCES rooms(id), all_rooms INTEGER NOT NULL DEFAULT 0,
  day INTEGER, start_min INTEGER, end_min INTEGER,      -- NULL day/start = unscheduled
  status TEXT NOT NULL DEFAULT 'pending',               -- pending | confirmed
  published INTEGER NOT NULL DEFAULT 1, sponsor_name TEXT, stream_url TEXT,
  visibility_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_event ON sessions(event_id, day);
CREATE TABLE session_speakers (
  session_id TEXT NOT NULL REFERENCES sessions(id), speaker_profile_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (session_id, speaker_profile_id)
);
CREATE TABLE speaker_profiles (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), user_id TEXT REFERENCES users(id),
  email TEXT NOT NULL COLLATE NOCASE, name TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '',
  headshot_file_id TEXT, slug TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (event_id, email), UNIQUE (event_id, slug)
);
CREATE TABLE task_templates (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, -- checkbox|file|form|profile
  target TEXT NOT NULL DEFAULT 'speaker',               -- speaker | session
  settings_json TEXT NOT NULL DEFAULT '{}',             -- {link,ext,capMb,maxFiles,sampleFileId,review,formSpec}
  required INTEGER NOT NULL DEFAULT 0, lock_on_complete INTEGER NOT NULL DEFAULT 0,
  due_json TEXT NOT NULL,                               -- {mode:'after'|'before'|'abs', n, date}
  grace_json TEXT,                                      -- {mode:'none'|'lock', days}
  trigger TEXT NOT NULL DEFAULT 'confirmation',         -- confirmation | acceptance | manual
  clauses_json TEXT NOT NULL DEFAULT '[]',              -- [{field:'Track'|'Format'|'Level'|'Form answer', value}]
  reminders_json TEXT NOT NULL,                         -- {on, days:[7,2], subject, body}
  archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id),
  template_id TEXT REFERENCES task_templates(id),       -- NULL = one-off
  one_off_json TEXT,                                    -- {name,type,due}
  target_type TEXT NOT NULL,                            -- speaker | session
  speaker_profile_id TEXT REFERENCES speaker_profiles(id), session_id TEXT REFERENCES sessions(id),
  status TEXT NOT NULL DEFAULT 'open',                  -- open | pending_review | done
  due_date TEXT, completed_by TEXT, completed_at TEXT, review_note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE email_templates (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), key TEXT NOT NULL, -- accept|decline|waitlist|reminder|task_nag|schedule_notice|confirm_submission
  name TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (event_id, key)
);
CREATE TABLE emails (
  id TEXT PRIMARY KEY, event_id TEXT REFERENCES events(id), to_email TEXT NOT NULL,
  to_name TEXT, template_key TEXT, subject TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL,                                 -- queued | sent | failed | simulated
  error TEXT, subject_type TEXT, subject_id TEXT, created_at TEXT NOT NULL, sent_at TEXT
);
CREATE TABLE counters (event_id TEXT NOT NULL, key TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (event_id, key));
