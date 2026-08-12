/** Shared ambient types for the Unsession worker. */

export interface SendEmailBinding {
  send(message: unknown): Promise<void>;
}

export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  /** R2 bucket `unsession-files`. Optional so local dev without R2 still boots. */
  FILES?: R2Bucket;
  /** Present only once `send_email` is uncommented in wrangler.jsonc (see DECISIONS D6). */
  EMAIL?: SendEmailBinding;
  APP_ORIGIN: string;
  EMAIL_FROM: string;
  EMAIL_ENABLED: string;
  /** Secrets — set with `wrangler secret put`. Google button hides when absent (D12). */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
};

export type Role = 'owner' | 'admin' | 'collaborator';

export type User = {
  id: string;
  email: string;
  name: string | null;
  google_id: string | null;
  created_at: string;
};

export type AuthSession = {
  id: string;
  user_id: string;
  token_hash: string;
  active_event_id: string | null;
  created_at: string;
  expires_at: string;
};

export type Org = { id: string; name: string; is_sandbox: number; created_at: string };

export type Theme = {
  primary: string;
  accent: string;
  bg: string;
  font: string;
  logoFileId?: string | null;
};

export type Event = {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  start_date: string;
  end_date: string;
  timezone: string;
  venue: string | null;
  mode: string;
  description: string | null;
  theme_json: string;
  day_start_min: number;
  day_end_min: number;
  published: number;
  hide_unconfirmed: number;
  created_at: string;
};

export type Variables = {
  user: User | null;
  session: AuthSession | null;
  event: Event | null;
  role: Role | null;
  events: Event[];
};

export type Ctx = { Bindings: Bindings; Variables: Variables };
