CREATE TABLE `toolboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`tool_names` text,
	`builtin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `toolboxes_name_unique` ON `toolboxes` (`name`);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `toolbox_ids` text;