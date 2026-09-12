CREATE TABLE `history_policy` (
	`id` integer PRIMARY KEY,
	`save_history` integer NOT NULL,
	`retention_days` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `caption_session_sequence` ON `caption_segments` (`session_id`,`sequence`);