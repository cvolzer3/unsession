-- C addendum (DECISIONS D15) — OAuth 2.1 + Dynamic Client Registration for the
-- MCP endpoint. Clients are public (PKCE S256 only, no secrets); authorization
-- codes are 10-minute single-use rows; the tokens OAuth mints are ordinary
-- api_tokens rows with `oauth_client_id` set, an `expires_at` on the access
-- secret, and a `refresh_token_hash` that rotates on every refresh — so Bearer
-- auth, the /app/api list and Revoke keep working unchanged.

CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,                 -- the client_id (ocl_…)
  name TEXT NOT NULL,                  -- client_name, or the first redirect host
  redirect_uris_json TEXT NOT NULL,    -- JSON array; exact-match at /oauth/authorize
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE oauth_codes (
  id TEXT PRIMARY KEY,                                -- oac_…
  code_hash TEXT NOT NULL,                            -- SHA-256 hex of the raw code
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  org_id TEXT NOT NULL REFERENCES orgs(id),
  scopes TEXT NOT NULL,                               -- 'read' | 'read,write'
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,                       -- PKCE, S256 only
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE UNIQUE INDEX idx_oauth_codes_hash ON oauth_codes(code_hash);

ALTER TABLE api_tokens ADD COLUMN oauth_client_id TEXT REFERENCES oauth_clients(id);
ALTER TABLE api_tokens ADD COLUMN expires_at TEXT;      -- NULL = never (UI-minted tokens)
ALTER TABLE api_tokens ADD COLUMN refresh_token_hash TEXT;

CREATE UNIQUE INDEX idx_api_tokens_refresh ON api_tokens(refresh_token_hash);
