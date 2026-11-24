CREATE TABLE `dispatch_records` (
	`scope` text NOT NULL,
	`id` text NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `dispatch_records_pk` PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE TABLE `intake_records` (
	`scope` text NOT NULL,
	`id` text NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `intake_records_pk` PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE TABLE `reply_drafts` (
	`scope` text NOT NULL,
	`id` text NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `reply_drafts_pk` PRIMARY KEY(`scope`, `id`)
);
