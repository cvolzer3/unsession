-- C — Public API + MCP server (DECISIONS R10): org-scoped bearer tokens.
-- The secret (`uns_<40 base36>`) is shown once at creation; only its SHA-256
-- lands here. `event_id` NULL = the token sees the whole org; set = requests
-- outside that event 404. Sandbox orgs cannot mint tokens (enforced in code).

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,              -- SHA-256 hex of the secret
  scopes TEXT NOT NULL,                  -- 'read' | 'read,write'
  event_id TEXT REFERENCES events(id),   -- NULL = whole org
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE UNIQUE INDEX idx_api_tokens_hash ON api_tokens(token_hash);
CREATE INDEX idx_api_tokens_org ON api_tokens(org_id);
