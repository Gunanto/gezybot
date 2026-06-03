CREATE TABLE `tool_domains` (
	`slug` text PRIMARY KEY NOT NULL,
	`label` text,
	`label_key` text,
	`icon` text NOT NULL,
	`color` text,
	`description` text,
	`builtin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
DROP TABLE IF EXISTS `custom_tools`;--> statement-breakpoint
CREATE TABLE `custom_tools` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`parameters` text NOT NULL,
	`entrypoint` text NOT NULL,
	`language` text,
	`domain_slug` text DEFAULT 'custom' NOT NULL,
	`timeout_ms` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text DEFAULT 'user' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`domain_slug`) REFERENCES `tool_domains`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_custom_tools_slug` ON `custom_tools` (`slug`);