import {sql} from 'drizzle-orm';
import {bigint, customType, index, pgTable, text, uniqueIndex} from 'drizzle-orm/pg-core';

const integer = () => bigint({mode: 'number'});
const bytea = customType<{data: Buffer; driverData: Buffer}>({
  dataType: () => 'bytea',
});

export const accounts = pgTable('accounts', {
  id: text().primaryKey(),
  owner: text().notNull(),
  name: text().notNull(),
  username: text().notNull(),
  cipher: text().notNull(),
  hint: text().notNull(),
  created_at: integer().notNull(),
  deleted_at: integer(),
}, table => [
  uniqueIndex('account_owner_username').on(table.owner, table.username),
]);

export const gpuSessions = pgTable('gpu_sessions', {
  id: text().primaryKey(),
  owner: text().notNull(),
  account_id: text().notNull(),
  username: text().notNull(),
  status: text().notNull(),
  profile: text().notNull(),
  token_hash: text().notNull(),
  worker_id: text(),
  kernel_ref: text().notNull(),
  version: integer(),
  kernel_session_id: integer(),
  created_at: integer().notNull(),
  expires_at: integer().notNull(),
  heartbeat_at: integer().notNull().default(0),
  idle_since: integer(),
  stop_requested_at: integer(),
  last_error: text(),
  sync_lease: integer().notNull().default(0),
  category: text().notNull().default('video'),
  model_id: text().notNull().default('h3'),
}, table => [
  uniqueIndex('one_live_gpu_session').on(table.account_id).where(sql`${table.status} NOT IN ('completed','failed')`),
  index('sessions_owner_date').on(table.owner, table.created_at),
]);

export const integrationKeys = pgTable('integration_keys', {
  id: text().primaryKey(),
  owner: text().notNull(),
  name: text().notNull(),
  hash: text().notNull(),
  hint: text().notNull(),
  created_at: integer().notNull(),
  expires_at: integer().notNull(),
  revoked_at: integer(),
  last_used_at: integer(),
  scopes: text().notNull().default('accounts:read accounts:write'),
  rate_window: integer().notNull().default(0),
  rate_count: integer().notNull().default(0),
}, table => [
  uniqueIndex('integration_key_hash').on(table.hash),
  index('integration_key_owner').on(table.owner),
]);

export const jobs = pgTable('jobs', {
  id: text().primaryKey(),
  owner: text().notNull(),
  account_id: text().notNull(),
  account_name: text().notNull(),
  username: text().notNull(),
  params: text().notNull(),
  status: text().notNull(),
  kernel_ref: text().notNull(),
  session_id: text(),
  claim_token: text(),
  artifact_key: text(),
  artifact_sha: text(),
  artifact_bytes: integer(),
  version: integer(),
  kernel_session_id: integer(),
  control_hash: text(),
  stop_requested_at: integer(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
  stage: text().notNull(),
  step: integer().notNull().default(0),
  total_steps: integer().notNull(),
  error: text(),
  metadata: text(),
  sync_lease: integer().notNull().default(0),
  category: text().notNull().default('video'),
  model_id: text().notNull().default('h3'),
  artifact_mime: text(),
}, table => [
  index('jobs_owner_date').on(table.owner, table.created_at),
  uniqueIndex('one_active_job_per_account').on(table.account_id)
    .where(sql`${table.status} IN ('submitting','queued','running','submission_unknown') AND ${table.session_id} IS NULL`),
  uniqueIndex('one_running_job_per_session').on(table.session_id)
    .where(sql`${table.status} = 'running' AND ${table.session_id} IS NOT NULL`),
]);

export const settings = pgTable('settings', {
  id: text().primaryKey(),
  value: text().notNull(),
});

export const objects = pgTable('h3_objects', {
  key: text().primaryKey(),
  body: bytea().notNull(),
  http_metadata: text().notNull(),
  sha: text().notNull(),
  updated_at: integer().notNull(),
});
