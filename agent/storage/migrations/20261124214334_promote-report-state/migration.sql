CREATE TABLE `new_automation_reports` (
  `execution_id` text PRIMARY KEY NOT NULL,
  `state` text NOT NULL,
  `completed_at` text,
  `value` text NOT NULL
);--> statement-breakpoint
INSERT INTO `new_automation_reports` (execution_id, state, completed_at, value)
SELECT execution_id, json_extract(value, '$.state'), json_extract(value, '$.completedAt'),
       json_remove(value, '$.state', '$.completedAt')
FROM automation_reports;--> statement-breakpoint
DROP TABLE automation_reports;--> statement-breakpoint
ALTER TABLE new_automation_reports RENAME TO automation_reports;--> statement-breakpoint
CREATE INDEX `automation_reports_recovery` ON `automation_reports` (`execution_id`) WHERE not ("automation_reports"."state" in ('delivered', 'failed')) or "automation_reports"."completed_at" is null;--> statement-breakpoint
CREATE INDEX `automation_reports_expiry` ON `automation_reports` (coalesce(julianday("completed_at"), 0)) WHERE "automation_reports"."state" in ('delivered', 'failed');