-- Review-round B6 — pronouns + social links become shipped speaker-profile
-- defaults. Both optional: `pronouns` is free text ("she/her"), `links_json`
-- is a JSON object holding only the keys the speaker filled in
-- ({linkedin, x, website, other} — normalized http(s) URLs).
ALTER TABLE speaker_profiles ADD COLUMN pronouns TEXT;
ALTER TABLE speaker_profiles ADD COLUMN links_json TEXT;
