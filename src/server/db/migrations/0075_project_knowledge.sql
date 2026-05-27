CREATE TABLE `project_knowledge` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`content` text NOT NULL,
	`embedding` blob,
	`category` text,
	`pinned` integer DEFAULT false NOT NULL,
	`author_kin_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_kin_id`) REFERENCES `kins`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_project_knowledge_project` ON `project_knowledge` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_project_knowledge_project_pinned` ON `project_knowledge` (`project_id`,`pinned`);
