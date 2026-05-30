-- Cross-Kin channel send: a Kin can borrow another Kin's channel to send a
-- message. Two schema changes on `channel_message_links`:
--   1. `message_id` becomes NULLABLE — proactive sends (send_channel_message /
--      send_to_contact) leave an audit link with no originating assistant
--      `messages` row.
--   2. add `sent_by_kin_id` (FK kins.id, set null on delete) — records which Kin
--      actually authored/sent the message, distinct from the channel owner
--      (channels.kin_id). Null for legacy rows and inbound links.
--
-- SQLite cannot drop a NOT NULL constraint in place, so rebuild the table.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_channel_message_links` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text,
	`platform_message_id` text NOT NULL,
	`platform_chat_id` text NOT NULL,
	`direction` text NOT NULL,
	`sent_by_kin_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sent_by_kin_id`) REFERENCES `kins`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_channel_message_links` (`id`, `channel_id`, `message_id`, `platform_message_id`, `platform_chat_id`, `direction`, `sent_by_kin_id`, `created_at`)
SELECT `id`, `channel_id`, `message_id`, `platform_message_id`, `platform_chat_id`, `direction`, NULL, `created_at` FROM `channel_message_links`;
--> statement-breakpoint
DROP TABLE `channel_message_links`;--> statement-breakpoint
ALTER TABLE `__new_channel_message_links` RENAME TO `channel_message_links`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_cml_message` ON `channel_message_links` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_cml_channel` ON `channel_message_links` (`channel_id`);
