CREATE TABLE `reply_publications` (
	`publisher` text NOT NULL,
	`target` text NOT NULL,
	CONSTRAINT `reply_publications_pk` PRIMARY KEY(`publisher`, `target`)
);--> statement-breakpoint
INSERT INTO reply_publications SELECT publisher, target FROM temp.prior_reply_publications;
