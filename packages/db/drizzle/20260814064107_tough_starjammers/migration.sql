CREATE TABLE `sessions` (
	`id` text PRIMARY KEY,
	`source_language` text NOT NULL,
	`target_language` text NOT NULL,
	`provider` text NOT NULL,
	`started_at` integer NOT NULL,
	`stopped_at` integer
);
--> statement-breakpoint
CREATE TABLE `caption_segments` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`source_text` text NOT NULL,
	`translated_text` text NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_caption_segments_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`)
);
