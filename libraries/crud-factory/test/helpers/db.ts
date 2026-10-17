import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll } from 'vitest';

const DDL = `
  create type user_status as enum ('active', 'invited', 'banned');
  create table users (
    id integer primary key generated always as identity,
    email text not null constraint users_email_unique unique,
    name text not null,
    password_hash text not null,
    status user_status not null default 'invited',
    org_id integer not null,
    created_at timestamptz not null default now(),
    deleted_at timestamptz
  );
  create table posts (
    id integer primary key generated always as identity,
    author_id integer not null references users(id),
    org_id integer not null,
    title text not null,
    created_at timestamptz not null default now()
  );
  create index posts_author_id_idx on posts (author_id);
`;

/**
 * A fresh in-memory Postgres with the fixture tables, created in `beforeAll` and closed in
 * `afterAll`. `db` is usable right away; PGlite waits for startup before the first query.
 */
export function useTestDb() {
  const client = new PGlite();
  const db = drizzle({ client });
  beforeAll(() => client.exec(DDL));
  afterAll(() => client.close());
  return { db, client };
}
