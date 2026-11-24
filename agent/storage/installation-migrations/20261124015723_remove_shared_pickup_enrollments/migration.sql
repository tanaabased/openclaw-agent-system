-- Enrollment is still JSON-backed. Preserve any unexpected SQLite rows for recovery.
CREATE TEMP TABLE pickup_drop_check (
  has_rows INTEGER CONSTRAINT shared_pickup_enrollments_must_be_empty CHECK (has_rows = 0)
);
--> statement-breakpoint
INSERT INTO pickup_drop_check VALUES (EXISTS (SELECT 1 FROM pickup_enrollments));
--> statement-breakpoint
DROP TABLE pickup_drop_check;
--> statement-breakpoint
DROP TABLE `pickup_enrollments`;