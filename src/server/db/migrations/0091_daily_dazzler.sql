ALTER TABLE `kins` ADD `kind` text DEFAULT 'regular' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_profiles` ADD `onboarding_modal_dismissed` integer DEFAULT false NOT NULL;