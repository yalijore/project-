-- Extra occurrence dates of a recurring event (RFC 5545 RDATE), in addition to its RRULE.
-- Same encoding as exdates: JSON array of UTC instants (timed) or floating dates (all-day).
ALTER TABLE calendar_events ADD COLUMN rdates TEXT NOT NULL DEFAULT '[]';
