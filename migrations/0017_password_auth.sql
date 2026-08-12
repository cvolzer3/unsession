-- Password auth — email + password replaces Google OAuth and magic-link sign-in.
-- Magic tokens stay for emailed action links (invite | confirm_participation |
-- draft_link | password_reset); only the `signin` purpose dies.
--
-- `users.google_id` carries an inline UNIQUE (and so an implicit index), which
-- makes SQLite reject `ALTER TABLE … DROP COLUMN` — rebuild the table instead.
-- Nine tables carry `REFERENCES users(id)`, so FK enforcement is deferred to
-- the end of the migration's transaction: dropping `users` orphans every child
-- row, and re-inserting the same ids into the rebuilt `users` clears the
-- deferred counter again before commit. (The rows must come back under the
-- name `users` for that to happen, hence the scratch table rather than a
-- `users_new` + rename.)
PRAGMA defer_foreign_keys = true;

CREATE TABLE users_backup (id TEXT, email TEXT, name TEXT, created_at TEXT);
INSERT INTO users_backup (id, email, name, created_at) SELECT id, email, name, created_at FROM users;

DROP TABLE users;

CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT,
  password_hash TEXT,                  -- pbkdf2$<iterations>$<b64 salt>$<b64 hash>; NULL = pre-password account
  created_at TEXT NOT NULL
);

INSERT INTO users (id, email, name, password_hash, created_at)
  SELECT id, email, name, NULL, created_at FROM users_backup;

DROP TABLE users_backup;

DELETE FROM magic_tokens WHERE purpose = 'signin';
