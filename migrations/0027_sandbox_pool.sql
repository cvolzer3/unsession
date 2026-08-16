-- Pool of pre-seeded sandbox orgs so "Try the sandbox" claims one instantly
-- instead of seeding a full demo org (~2s) while the visitor waits. A row is
-- one unclaimed, ready sandbox; claiming deletes the row. Topped up in the
-- background after each claim and by the 15-minute cron.
CREATE TABLE sandbox_pool (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id),
  created_at TEXT NOT NULL
);
