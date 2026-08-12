-- Speaker tagline + submission-time links (Sessionize parity): a one-line
-- tagline ("CTO at Acme") joins the profile, and the CFP form's speaker cards
-- now collect tagline + social links directly instead of waiting for the
-- speaker to fill their portal profile. `links_json` mirrors the shape already
-- used on speaker_profiles ({linkedin, x, website, other}).
ALTER TABLE speaker_profiles ADD COLUMN tagline TEXT;
ALTER TABLE submission_speakers ADD COLUMN tagline TEXT NOT NULL DEFAULT '';
ALTER TABLE submission_speakers ADD COLUMN links_json TEXT;
