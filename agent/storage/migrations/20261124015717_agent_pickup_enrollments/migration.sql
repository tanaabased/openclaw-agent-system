CREATE TABLE `pickup_enrollments` (
	`runtime` text NOT NULL,
	`scope` text NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `pickup_enrollments_pk` PRIMARY KEY(`runtime`, `scope`)
);
