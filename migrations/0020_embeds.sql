-- Embeds — saved, configurable public widgets (admin: /app/embeds).
-- Each row is one named embed of a widget type in an output format, with
-- display config (track filter, hidden fields, transparent, accent). The
-- public renderers look rows up by id (`?eid=`) and 404 disabled ones;
-- widget endpoints without an eid keep working unconfigured.

CREATE TABLE embeds (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  widget TEXT NOT NULL,              -- sessions | speakers | agenda | itinerary | gallery
  format TEXT NOT NULL,              -- styled | basic | json | xml | ical
  config_json TEXT,                  -- { transparent, accent, tracks[], hide[] }
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_embeds_event ON embeds(event_id);
