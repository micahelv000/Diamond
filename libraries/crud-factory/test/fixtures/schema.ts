import { index, integer, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const userStatus = pgEnum('user_status', ['active', 'invited', 'banned']);

export const users = pgTable('users', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  email: text().notNull().unique(),
  name: text().notNull(),
  passwordHash: text('password_hash').notNull(),
  status: userStatus().notNull().default('invited'),
  orgId: integer('org_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const posts = pgTable(
  'posts',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    authorId: integer('author_id')
      .notNull()
      .references(() => users.id),
    orgId: integer('org_id').notNull(),
    title: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('posts_author_id_idx').on(table.authorId)],
);
