CREATE TABLE `assignment_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `instances` (
	`id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `managed_repositories` (
	`root` text NOT NULL,
	`id` text NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `managed_repositories_pk` PRIMARY KEY(`root`, `id`)
);
--> statement-breakpoint
CREATE TABLE `pickup_enrollments` (
	`runtime` text NOT NULL,
	`scope` text NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `pickup_enrollments_pk` PRIMARY KEY(`runtime`, `scope`)
);
--> statement-breakpoint
CREATE TABLE `sidebar_placements` (
	`scope` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
