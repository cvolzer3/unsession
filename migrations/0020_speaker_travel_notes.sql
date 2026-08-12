-- Travel & logistics notes on the speaker record: an organizer-entered CRM
-- field for arrival/departure details, seating preferences, dietary needs.
-- Free text, edited from the speaker drawer on /app/speakers. Organizer-only —
-- never rendered on public surfaces or in the speaker portal (the speaker-
-- facing "Travel details" mini-form task remains the way to ASK the speaker).
ALTER TABLE speaker_profiles ADD COLUMN travel_notes TEXT;
