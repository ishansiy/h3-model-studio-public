-- Baseline the existing Node PostgreSQL schema in place as well as fresh databases.
CREATE TABLE IF NOT EXISTS "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"username" text NOT NULL,
	"cipher" text NOT NULL,
	"hint" text NOT NULL,
	"created_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gpu_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"account_id" text NOT NULL,
	"username" text NOT NULL,
	"status" text NOT NULL,
	"profile" text NOT NULL,
	"token_hash" text NOT NULL,
	"worker_id" text,
	"kernel_ref" text NOT NULL,
	"version" bigint,
	"kernel_session_id" bigint,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"heartbeat_at" bigint DEFAULT 0 NOT NULL,
	"idle_since" bigint,
	"stop_requested_at" bigint,
	"last_error" text,
	"sync_lease" bigint DEFAULT 0 NOT NULL,
	"category" text DEFAULT 'video' NOT NULL,
	"model_id" text DEFAULT 'h3' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integration_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"hash" text NOT NULL,
	"hint" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"revoked_at" bigint,
	"last_used_at" bigint,
	"scopes" text DEFAULT 'accounts:read accounts:write' NOT NULL,
	"rate_window" bigint DEFAULT 0 NOT NULL,
	"rate_count" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"account_id" text NOT NULL,
	"account_name" text NOT NULL,
	"username" text NOT NULL,
	"params" text NOT NULL,
	"status" text NOT NULL,
	"kernel_ref" text NOT NULL,
	"session_id" text,
	"claim_token" text,
	"artifact_key" text,
	"artifact_sha" text,
	"artifact_bytes" bigint,
	"version" bigint,
	"kernel_session_id" bigint,
	"control_hash" text,
	"stop_requested_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"stage" text NOT NULL,
	"step" bigint DEFAULT 0 NOT NULL,
	"total_steps" bigint NOT NULL,
	"error" text,
	"metadata" text,
	"sync_lease" bigint DEFAULT 0 NOT NULL,
	"category" text DEFAULT 'video' NOT NULL,
	"model_id" text DEFAULT 'h3' NOT NULL,
	"artifact_mime" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "h3_objects" (
	"key" text PRIMARY KEY NOT NULL,
	"body" "bytea" NOT NULL,
	"http_metadata" text NOT NULL,
	"sha" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settings" (
	"id" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_owner_username" ON "accounts" USING btree ("owner","username");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "one_live_gpu_session" ON "gpu_sessions" USING btree ("account_id") WHERE "gpu_sessions"."status" NOT IN ('completed','failed');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_owner_date" ON "gpu_sessions" USING btree ("owner","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integration_key_hash" ON "integration_keys" USING btree ("hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_key_owner" ON "integration_keys" USING btree ("owner");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_owner_date" ON "jobs" USING btree ("owner","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "one_active_job_per_account" ON "jobs" USING btree ("account_id") WHERE "jobs"."status" IN ('submitting','queued','running','submission_unknown') AND "jobs"."session_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "one_running_job_per_session" ON "jobs" USING btree ("session_id") WHERE "jobs"."status" = 'running' AND "jobs"."session_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_keys" ADD COLUMN IF NOT EXISTS "scopes" text DEFAULT 'accounts:read accounts:write' NOT NULL;--> statement-breakpoint
ALTER TABLE "gpu_sessions" ADD COLUMN IF NOT EXISTS "category" text DEFAULT 'video' NOT NULL;--> statement-breakpoint
ALTER TABLE "gpu_sessions" ADD COLUMN IF NOT EXISTS "model_id" text DEFAULT 'h3' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "category" text DEFAULT 'video' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "model_id" text DEFAULT 'h3' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "artifact_mime" text;
