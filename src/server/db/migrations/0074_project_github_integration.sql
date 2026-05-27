-- GitHub integration for projects.
--
-- Adds the columns the clone + worktree-per-subtask pipeline needs.
-- `github_url` is already on `projects` and is preserved as a free-form
-- display link; `github_repo` is the new authoritative "owner/name" used
-- by the GitHub API wrapper and the local clone path derivation.
--
-- The PAT itself is never stored on `projects`: `github_pat_vault_key`
-- references an entry in `vault_secrets.key`, and the value is resolved
-- at runtime via the vault service (decrypted on demand, never logged).
--
-- `clone_status` is a string enum: 'none' | 'cloning' | 'ready' | 'error'.
-- 'none' covers both "no repo configured" and "repo configured but clone
-- has not been kicked off yet" — the clone orchestrator distinguishes
-- by also checking `github_repo IS NOT NULL`.
ALTER TABLE projects ADD COLUMN github_pat_vault_key text;--> statement-breakpoint
ALTER TABLE projects ADD COLUMN github_repo text;--> statement-breakpoint
ALTER TABLE projects ADD COLUMN default_branch text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE projects ADD COLUMN clone_status text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE projects ADD COLUMN clone_error text;--> statement-breakpoint
ALTER TABLE projects ADD COLUMN cloned_at integer;
