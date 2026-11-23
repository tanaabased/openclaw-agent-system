CREATE TABLE `automation_registrations` (
	`scope` text NOT NULL,
	`id` text NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `automation_registrations_pk` PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE TABLE `automation_reports` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `automation_state` (
	`scope` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `automation_threads` (
	`scope` text NOT NULL,
	`id` text NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `automation_threads_pk` PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE TABLE `direct_entries` (
	`scope` text NOT NULL,
	`id` text NOT NULL,
	`value` text NOT NULL,
	`kind` text NOT NULL,
	CONSTRAINT `direct_entries_pk` PRIMARY KEY(`scope`, `kind`, `id`)
);
--> statement-breakpoint
CREATE TABLE `dispatch_state` (
	`scope` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `github_identity_pins` (
	`scope` text NOT NULL,
	`id` text NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `github_identity_pins_pk` PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE TABLE `intake_state` (
	`scope` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_resets` (
	`scope` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `path_projections` (
	`scope` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
