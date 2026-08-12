-- Speaker CSV import ("Import CSV" on /app/speakers): organizers bulk-add
-- speakers who never came through the CFP — invited keynotes, a roster
-- carried over from last year's tool, sponsor speakers agreed over email.
--
-- The grid on /app/speakers only lists profiles that have tasks or an
-- accepted submission behind them, which would make an imported speaker
-- invisible until someone assigned them a task. `imported_at` marks the
-- organizer-added ones so they show up straight away (and records when).
ALTER TABLE speaker_profiles ADD COLUMN imported_at TEXT;
