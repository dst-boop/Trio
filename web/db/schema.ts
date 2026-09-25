import { integer, sqliteTable, text, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
export const workspaces = sqliteTable('workspaces', {
  userId: text('user_id').primaryKey(),
  revision: integer('revision').notNull().default(0),
  token: text('token').notNull(),
});
export const workspaceChunks = sqliteTable('workspace_chunks', {
  userId: text('user_id').notNull().references(() => workspaces.userId),
  position: integer('position').notNull(),
  content: text('content').notNull(),
}, t => [primaryKey({ columns: [t.userId, t.position] })]);
export const personalMemory = sqliteTable('personal_memory', {
  userId: text('user_id').primaryKey(),
  revision: integer('revision').notNull().default(0),
  enabled: integer('enabled').notNull().default(0),
  notes: text('notes').notNull().default(''),
});
export const providerCredentials = sqliteTable('provider_credentials', {
  userId: text('user_id').notNull(),
  provider: text('provider').notNull(),
  cipher: text('cipher'),
  iv: text('iv'),
  model: text('model').notNull(),
  enabled: integer('enabled').notNull().default(1),
  revision: integer('revision').notNull(),
  updatedAt: text('updated_at').notNull(),
}, t => [primaryKey({ columns: [t.userId, t.provider] })]);

export const qualityRuns = sqliteTable('quality_runs', {
  userId: text('user_id').notNull(),
  id: text('id').notNull(),
  status: text('status').notNull(),
  config: text('config').notNull(),
  startedAt: integer('started_at').notNull(),
  deadline: integer('deadline').notNull(),
  finishedAt: integer('finished_at'),
  cursor: integer('cursor').notNull().default(0),
  calls: integer('calls').notNull().default(0),
  lease: text('lease'),
  leaseUntil: integer('lease_until'),
  blindSeed: text('blind_seed').notNull(),
}, t => [primaryKey({columns:[t.userId,t.id]}), uniqueIndex('quality_one_active_account').on(t.userId).where(sql`${t.status} = 'running' OR ${t.lease} IS NOT NULL`)]);

export const qualityPhases = sqliteTable('quality_phases', {
  userId: text('user_id').notNull(),
  runId: text('run_id').notNull(),
  step: integer('step').notNull(),
  report: text('report').notNull(),
}, t => [primaryKey({columns:[t.userId,t.runId,t.step]})]);

export const workComparisonRuns = sqliteTable('work_comparison_runs', {
  userId: text('user_id').notNull(),
  id: text('id').notNull(),
  status: text('status').notNull(),
  config: text('config').notNull(),
  startedAt: integer('started_at').notNull(),
  deadline: integer('deadline').notNull(),
  finishedAt: integer('finished_at'),
  cursor: integer('cursor').notNull().default(0),
  calls: integer('calls').notNull().default(0),
  lease: text('lease'),
  leaseUntil: integer('lease_until'),
  blindSeed: text('blind_seed').notNull(),
  ratings: text('ratings'),
  ratedAt: integer('rated_at'),
}, t => [primaryKey({columns:[t.userId,t.id]}), uniqueIndex('work_comparison_one_active_account').on(t.userId).where(sql`${t.status} = 'running' OR ${t.lease} IS NOT NULL`)]);

export const workComparisonPhases = sqliteTable('work_comparison_phases', {
  userId: text('user_id').notNull(),
  runId: text('run_id').notNull(),
  step: integer('step').notNull(),
  report: text('report').notNull(),
}, t => [primaryKey({columns:[t.userId,t.runId,t.step]})]);
