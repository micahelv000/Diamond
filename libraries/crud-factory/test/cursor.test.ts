// Cursor (keyset) pagination: walking every page, ties, NULLs, column types, filters and scope,
// bad cursors, and the `?cursor=` round trip through the list route.
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { bigint, integer, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { crudRoutes } from '../src/fastify/index.ts';
import { BadRequestError, createRepository, createService, defineEntity, type ListOptions, type QueryOptions, type SortSpec } from '../src/index.ts';
import { useServer } from './helpers/server.ts';

const status = pgEnum('c_status', ['a', 'b', 'c']);
const items = pgTable('c_items', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: text().notNull(),
  status: status().notNull(),
  grp: integer().notNull(),
  rank: integer(),
  big: bigint({ mode: 'bigint' }).notNull(),
  at: timestamp({ withTimezone: true }).notNull(),
  tenant: integer().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

// 12 live rows plus one soft-deleted row. `grp` has many ties, `rank` has NULLs, `at` values differ only
// by microseconds (the same JS Date), and `big` is above Number.MAX_SAFE_INTEGER.
const DDL = `
  create type c_status as enum ('a', 'b', 'c');
  create table c_items (
    id integer primary key generated always as identity,
    name text not null,
    status c_status not null,
    grp integer not null,
    rank integer,
    big bigint not null,
    at timestamptz not null,
    tenant integer not null,
    deleted_at timestamptz
  );
  insert into c_items (name, status, grp, rank, big, at, tenant)
  select
    'item ' || (n % 5),
    (array['a', 'b', 'c'])[n % 3 + 1]::c_status,
    n % 2,
    case when n % 4 = 0 then null else n % 3 end,
    9007199254740993 + n % 2,
    timestamptz '2026-01-01 00:00:00.000001+00' + (n % 3) * interval '1 microsecond',
    case when n <= 9 then 1 else 2 end
  from generate_series(1, 12) as n;
  insert into c_items (name, status, grp, rank, big, at, tenant, deleted_at)
  values ('deleted', 'a', 0, 1, 1, now(), 1, now());
`;
const LIVE_ROWS = 12;
const DELETED_ID = 13;

const itemEntity = defineEntity(items, {
  primaryKey: 'id',
  filterable: { status: ['in'], tenant: ['eq'] },
  sortable: ['grp', 'rank', 'name'],
  softDelete: 'deletedAt',
});

const client = new PGlite();
const db = drizzle({ client });
beforeAll(() => client.exec(DDL));
afterAll(() => client.close());

const repo = createRepository(db, itemEntity);
type WalkOptions = Omit<ListOptions<typeof itemEntity>, 'cursor' | 'limit' | 'offset'> & QueryOptions;

/** Follows `nextCursor` from the first page to the last and returns every id in page order. */
async function walk(options: WalkOptions, limit: number): Promise<number[]> {
  const ids: number[] = [];
  let cursor: string | undefined;
  for (let pageCount = 0; pageCount <= LIVE_ROWS; pageCount++) {
    const page = await repo.findMany({ ...options, limit, cursor });
    ids.push(...page.items.map((item) => item.id));
    if (page.nextCursor === null) return ids;
    cursor = page.nextCursor;
  }
  throw new Error('the walk did not end');
}

/** The same query in one page, as the expected order. */
async function allIds(options: WalkOptions): Promise<number[]> {
  const page = await repo.findMany({ ...options, limit: 100 });
  return page.items.map((item) => item.id);
}

describe('walking pages with nextCursor', () => {
  test('many rows sharing one sort value: no duplicates and no gaps', async () => {
    const walked = await walk({ sort: ['grp'] }, 5);
    expect(new Set(walked).size).toBe(LIVE_ROWS);
    expect(walked).toEqual(await allIds({ sort: ['grp'] }));
  });

  const sorts: { name: string; sort: SortSpec<typeof itemEntity>[] }[] = [
    { name: 'descending', sort: ['-grp'] },
    { name: 'mixed directions over an enum and a nullable column', sort: ['status', '-rank'] },
    { name: 'a nullable column ascending (NULLs last)', sort: ['rank'] },
    { name: 'a nullable column descending (NULLs first)', sort: ['-rank', 'grp'] },
    { name: 'timestamps that differ only by microseconds', sort: ['at'] },
    { name: 'bigint descending, then text', sort: ['-big', 'name'] },
  ];
  test.each(sorts)('$name', async ({ sort }) => {
    expect(await walk({ sort }, 3)).toEqual(await allIds({ sort }));
  });

  test('filters, scope and soft delete apply on every page', async () => {
    const options: WalkOptions = { sort: ['-grp'], where: { status__in: ['a', 'b'] }, scope: eq(items.tenant, 1) };
    const walked = await walk(options, 2);
    expect(walked).toEqual(await allIds(options));
    expect(walked).not.toContain(DELETED_ID);
    const rows = (await repo.findMany({ ...options, limit: 100 })).items;
    expect(rows.every((row) => row.tenant === 1 && row.status !== 'c')).toBe(true);
  });

  test('an offset page also returns a cursor that continues after it', async () => {
    const offsetPage = await repo.findMany({ sort: ['grp'], limit: 4, offset: 4 });
    const nextPage = await repo.findMany({ sort: ['grp'], limit: 4, cursor: offsetPage.nextCursor ?? undefined });
    const expected = await allIds({ sort: ['grp'] });
    expect(nextPage.items.map((item) => item.id)).toEqual(expected.slice(8, 12));
  });

  test('withTotal counts every match, ignoring the cursor', async () => {
    const first = await repo.findMany({ limit: 5 });
    const second = await repo.findMany({ limit: 5, cursor: first.nextCursor ?? undefined, withTotal: true });
    expect(second.total).toBe(LIVE_ROWS);
  });
});

describe('nextCursor is null', () => {
  test('on a last page that is exactly full', async () => {
    expect((await repo.findMany({ limit: LIVE_ROWS })).nextCursor).toBeNull();
  });

  test('on an empty result', async () => {
    expect(await repo.findMany({ where: { tenant__eq: 99 } })).toMatchObject({ items: [], nextCursor: null });
  });
});

describe('bad cursors are a BadRequestError', () => {
  const firstCursor = async () => {
    const { nextCursor } = await repo.findMany({ sort: ['grp'], limit: 2 });
    if (nextCursor === null) throw new Error('expected a next page');
    return nextCursor;
  };
  const tampered = Buffer.from(JSON.stringify({ sort: ['grp'], values: ['zero', 1] })).toString('base64url');

  test.each([
    ['garbage', 'not a cursor!'],
    ['base64url that is not JSON', Buffer.from('{oops').toString('base64url')],
    ['a value of the wrong type', tampered],
  ])('%s', async (_name, cursor) => {
    await expect(repo.findMany({ sort: ['grp'], cursor })).rejects.toBeInstanceOf(BadRequestError);
  });

  test('a cursor made for a different sort', async () => {
    await expect(repo.findMany({ sort: ['-grp'], cursor: await firstCursor() })).rejects.toBeInstanceOf(BadRequestError);
  });

  test('a cursor together with a non-zero offset', async () => {
    await expect(repo.findMany({ sort: ['grp'], cursor: await firstCursor(), offset: 2 })).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe('GET / with ?cursor=', () => {
  const app = useServer({
    register: (app) => app.register(crudRoutes({ service: createService(repo) }), { prefix: '/items' }),
  });
  const pageSchema = z.object({ items: z.array(z.record(z.string(), z.unknown())), nextCursor: z.string().nullable() });

  /** Follows `nextCursor` through the list route and returns every item in page order. */
  async function walkRoute(query: string): Promise<Record<string, unknown>[]> {
    const walked: Record<string, unknown>[] = [];
    let cursorParam = '';
    for (let pageCount = 0; pageCount <= LIVE_ROWS; pageCount++) {
      const response = await app().inject({ method: 'GET', url: `/items?${query}${cursorParam}` });
      expect(response.statusCode).toBe(200);
      const page = pageSchema.parse(response.json());
      walked.push(...page.items);
      if (page.nextCursor === null) return walked;
      cursorParam = `&cursor=${page.nextCursor}`;
    }
    throw new Error('the walk did not end');
  }

  test('walks every page', async () => {
    const walked = await walkRoute('limit=5&sort=-rank');
    expect(walked.map((item) => item.id)).toEqual(await allIds({ sort: ['-rank'] }));
  });

  test('?fields= still pages correctly and returns only the requested fields', async () => {
    const walked = await walkRoute('limit=5&sort=rank&fields=name');
    expect(walked).toHaveLength(LIVE_ROWS);
    expect(walked.every((item) => Object.keys(item).join() === 'name')).toBe(true);
    const expected = (await repo.findMany({ sort: ['rank'], limit: 100 })).items.map((item) => ({ name: item.name }));
    expect(walked).toEqual(expected);
  });

  test('a garbage cursor, or a cursor with an offset, is a 400', async () => {
    const garbage = await app().inject({ method: 'GET', url: '/items?cursor=@@@' });
    expect(garbage.statusCode).toBe(400);
    const first = pageSchema.parse((await app().inject({ method: 'GET', url: '/items?limit=2' })).json());
    const withOffset = await app().inject({ method: 'GET', url: `/items?offset=2&cursor=${first.nextCursor}` });
    expect(withOffset.statusCode).toBe(400);
  });
});
