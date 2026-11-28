CREATE TABLE `automation_registrations` (
	`scope` text NOT NULL,
	`id` text NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `automation_registrations_pk` PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE TABLE `automation_state` (
	`scope` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);

--> statement-breakpoint
INSERT INTO automation_state SELECT * FROM temp.prior_automation_state;
--> statement-breakpoint
INSERT INTO automation_registrations SELECT * FROM temp.prior_automation_registrations ORDER BY rowid;
