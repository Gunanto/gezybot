ALTER TABLE `kins` ADD `scout_model` text;--> statement-breakpoint
ALTER TABLE `kins` ADD `scout_provider_id` text REFERENCES providers(id);--> statement-breakpoint
ALTER TABLE `projects` ADD `scout_model` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `scout_provider_id` text;