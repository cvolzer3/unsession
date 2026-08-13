-- Speaker CRM — org-level contacts, notes, custom fields, segments and the
-- speaker pipeline. Contacts live on the org, not the event: the same person
-- carries across every event the org runs.
-- Id prefixes: ctc cno cfd seg pcd pph pno.

CREATE TABLE org_contacts (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL COLLATE NOCASE, name TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '', job_title TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '', tagline TEXT, pronouns TEXT,
  links_json TEXT,                                      -- {linkedin, x, website, other}
  headshot_file_id TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',                 -- ["keynote", "local"]
  custom_json TEXT NOT NULL DEFAULT '{}',               -- {org_fields.id: value}
  source TEXT NOT NULL DEFAULT 'manual',                -- manual | import | event
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (org_id, email)
);
CREATE INDEX idx_org_contacts_org ON org_contacts(org_id);

CREATE TABLE contact_notes (
  id TEXT PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES org_contacts(id),
  author_user_id TEXT REFERENCES users(id), body TEXT NOT NULL, created_at TEXT NOT NULL
);

-- Organizer-defined extra columns on a contact. Values live in
-- org_contacts.custom_json, keyed by org_fields.id.
CREATE TABLE org_fields (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), name TEXT NOT NULL,
  type TEXT NOT NULL,                                   -- text | dropdown
  options_json TEXT,                                    -- dropdown options
  created_at TEXT NOT NULL
);

CREATE TABLE org_segments (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), name TEXT NOT NULL,
  kind TEXT NOT NULL,                                   -- dynamic | curated
  query TEXT NOT NULL DEFAULT '',                       -- directory querystring, dynamic segments
  member_ids_json TEXT,                                 -- curated member ids
  created_at TEXT NOT NULL
);

-- One card per contact in the org's speaker pipeline. Stages are fixed
-- app-side: researching | identified | contacted | interested | confirmed |
-- declined.
CREATE TABLE pipeline_cards (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id),
  contact_id TEXT NOT NULL REFERENCES org_contacts(id),
  stage TEXT NOT NULL DEFAULT 'identified',
  score INTEGER, rationale TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (org_id, contact_id)
);

CREATE TABLE pipeline_history (
  id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES pipeline_cards(id),
  from_stage TEXT,                                      -- NULL = enrollment
  to_stage TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE pipeline_notes (
  id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES pipeline_cards(id),
  author_user_id TEXT REFERENCES users(id), body TEXT NOT NULL, created_at TEXT NOT NULL
);

-- Org-level sends (pipeline outreach) carry org_id and leave event_id NULL.
ALTER TABLE emails ADD COLUMN org_id TEXT;

-- Backfill: every event speaker becomes an org contact. One row per
-- (org, lowercase email); the most recent profile wins. SQLite hands the bare
-- columns of a max() group from the row that matched, so this takes the whole
-- profile from the newest one.
INSERT INTO org_contacts
  (id, org_id, email, name, company, job_title, bio, tagline, pronouns,
   links_json, headshot_file_id, source, created_at, updated_at)
SELECT 'ctc_' || lower(hex(randomblob(6))),
       org_id, email, name,
       coalesce(company, ''), coalesce(job_title, ''), bio,
       tagline, pronouns, links_json, headshot_file_id,
       'event', created_at, created_at
  FROM (
    SELECT e.org_id AS org_id, max(p.created_at) AS created_at,
           p.email AS email, p.name AS name, p.bio AS bio,
           p.company AS company, p.job_title AS job_title,
           p.tagline AS tagline, p.pronouns AS pronouns,
           p.links_json AS links_json, p.headshot_file_id AS headshot_file_id
      FROM speaker_profiles p
      JOIN events e ON e.id = p.event_id
     WHERE trim(p.email) != ''
     GROUP BY e.org_id, lower(p.email)
  );
