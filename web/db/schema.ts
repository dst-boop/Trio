import { integer, sqliteTable, text, primaryKey } from 'drizzle-orm/sqlite-core';
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
