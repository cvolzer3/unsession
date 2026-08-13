-- Split the speaker "tagline" into structured job title + company fields.
-- Public widgets and the speaker roster show "Job title · Company" and fall
-- back to the legacy free-text tagline for profiles that only have that.
ALTER TABLE speaker_profiles ADD COLUMN job_title TEXT;
ALTER TABLE speaker_profiles ADD COLUMN company TEXT;
ALTER TABLE submission_speakers ADD COLUMN job_title TEXT NOT NULL DEFAULT '';
ALTER TABLE submission_speakers ADD COLUMN company TEXT NOT NULL DEFAULT '';

-- Backfill from taglines shaped like "CTO at Acme"; anything else becomes the
-- job title alone. The tagline column stays as a read-only fallback.
UPDATE speaker_profiles
   SET job_title = trim(substr(tagline, 1, instr(tagline, ' at ') - 1)),
       company = trim(substr(tagline, instr(tagline, ' at ') + 4))
 WHERE tagline LIKE '%_ at _%';
UPDATE speaker_profiles
   SET job_title = trim(tagline)
 WHERE job_title IS NULL AND tagline IS NOT NULL AND trim(tagline) != '';

UPDATE submission_speakers
   SET job_title = trim(substr(tagline, 1, instr(tagline, ' at ') - 1)),
       company = trim(substr(tagline, instr(tagline, ' at ') + 4))
 WHERE tagline LIKE '%_ at _%';
UPDATE submission_speakers
   SET job_title = trim(tagline)
 WHERE job_title = '' AND trim(tagline) != '';
