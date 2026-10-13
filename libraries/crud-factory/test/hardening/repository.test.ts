// Edge cases for the repository against a real Postgres (PGlite): finders, sorting, paging, scope,
// soft delete, hidden columns, `extend` and the SQLSTATE mapping.
import { PGlite } from '@electric-sql/pglite';
import { asc, eq, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { customType, integer, pgEnum, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { BadRequestError, ConflictError, createRepository, defineEntity, NotFoundError, CrudFactoryError } from '../../src/index.ts';

const status = pgEnum('r_status', ['draft', 'live']);
const vendors = pgTable('r_vendors', { id: integer().primaryKey().generatedAlwaysAsIdentity(), name: text().notNull() });
const items = pgTable('r_items', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  sku: varchar({ length: 12 }).notNull(),
  name: text().notNull(),
  secret: text().notNull().default('s3cret'),
  status: status().notNull().default('draft'),
  qty: integer().notNull().default(0),
  rank: integer(),
  tenant: integer().notNull().default(1),
  vendorId: integer('vendor_id').references(() => vendors.id),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});
const int4range = customType<{ data: string }>({ dataType: () => 'int4range' });
const events = pgTable('r_events', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  at: timestamp({ mode: 'string' }),
  slot: int4range(),
});

const DDL = `
  create type r_status as enum ('draft', 'live');
  create table r_vendors (id integer primary key generated always as identity, name text not null);
  create table r_items (
    id integer primary key generated always as identity,
    sku varchar(12) not null constraint r_items_sku_unique unique,
    name text not null,
    secret text not null default 's3cret',
    status r_status not null default 'draft',
    qty integer not null default 0 constraint r_items_qty_check check (qty >= 0),
    rank integer,
    tenant integer not null default 1,
    vendor_id integer constraint r_items_vendor_fk references r_vendors(id),
    deleted_at timestamptz
  );
  create table r_events (
    id integer primary key generated always as identity,
    at timestamp,
    slot int4range,
    constraint r_events_no_overlap exclude using gist (slot with &&)
  );
`;

const itemConfig = {
  primaryKey: 'id',
  hidden: ['secret'],
  softDelete: 'deletedAt',
  filterable: { status: ['eq', 'in'], name: ['ilike'], qty: ['gte', 'lte'], tenant: ['eq'] },
} as const;
const itemEntity = defineEntity(items, itemConfig);
const cappedEntity = defineEntity(items, { ...itemConfig, pagination: { maxLimit: 3 } });

const client = new PGlite();
const db = drizzle({ client });
beforeAll(() => client.exec(DDL));
afterAll(() => client.close());

const repo = createRepository(db, itemEntity);
const capped = createRepository(db, cappedEntity);
const vendorRepo = createRepository(db, defineEntity(vendors, { primaryKey: 'id' }));
const eventRepo = createRepository(db, defineEntity(events, { primaryKey: 'id' }));
// A custom query built the documented way: visible columns, baseWhere, the caller's tx.
const extended = repo.extend(({ table, baseWhere, project, run }) => ({
  listRaw: (options: { scope?: SQL } = {}) => run(db.select(project()).from(table).where(baseWhere(options.scope)).orderBy(asc(table.id))),
  setNegativeQty: (id: number) => run(db.update(table).set({ qty: -1 }).where(eq(table.id, id))),
  failWithNotFound: async () => {
    throw new NotFoundError('custom');
  },
}));

const tenant2 = eq(items.tenant, 2);
const ids = (rows: readonly { id?: number }[]) => rows.map((row) => row.id);

/** Passes a value the types reject, as an untyped caller would. */
function untyped<T>(value: unknown): T {
  return value as T;
}

/** Resolves with what the promise rejects with; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => { throw new Error(`expected a rejection, got ${JSON.stringify(value)}`); },
    (error: unknown) => error,
  );
}

// ids 1-6; row 6 is soft-deleted, rows 4-5 belong to tenant 2.
beforeEach(async () => {
  await db.execute(sql`truncate r_items, r_vendors, r_events restart identity cascade`);
  await db.insert(items).values([
    { sku: 'A1', name: 'Alpha', status: 'live', qty: 5, rank: 2 },
    { sku: 'A2', name: '100% pure', status: 'draft', qty: 5, rank: null },
    { sku: 'A3', name: 'back\\slash', status: 'live', qty: 1, rank: 2 },
    { sku: 'A4', name: "O'Brien", status: 'live', qty: 5, rank: null, tenant: 2 },
    { sku: 'A5', name: 'under_score', status: 'draft', qty: 9, rank: 1, tenant: 2 },
    { sku: 'A6', name: 'Deleted', status: 'live', qty: 5, rank: 2, deletedAt: new Date() },
  ]);
});

describe('finders', () => {
  test('an empty In array returns no rows instead of failing', async () => {
    expect((await repo.findByStatusIn([])).items).toEqual([]);
  });

  test('an In filter given a non-array is a BadRequestError', async () => {
    expect(await rejection(repo.findMany({ where: untyped({ status__in: 'live' }) }))).toBeInstanceOf(BadRequestError);
  });

  test('a reversed Between returns no rows, and equal bounds include the bound', async () => {
    expect((await repo.findByQtyBetween(9, 1)).items).toEqual([]);
    expect(ids((await repo.findByQtyBetween(5, 5)).items)).toEqual([1, 2, 4]);
  });

  test.each([
    ['a backslash', 'k\\s', 3],
    ['a single quote', "o'b", 4],
  ])('ilike matches %s literally', async (_label, term, id) => {
    expect(ids((await repo.findByNameContaining(term)).items)).toEqual([id]);
  });

  test('an injection attempt in ilike is a literal search and leaves the table intact', async () => {
    expect((await repo.findByNameContaining("'; drop table r_items; --")).items).toEqual([]);
    expect((await repo.findMany({ withTotal: true })).total).toBe(5);
  });

  test('a filter key naming an Object.prototype member is a BadRequestError', async () => {
    expect(await rejection(repo.findMany({ where: untyped({ constructor__eq: 1 }) }))).toBeInstanceOf(BadRequestError);
  });
});

describe('sort', () => {
  test('an unknown column is a BadRequestError', async () => {
    expect(await rejection(repo.findMany({ sort: untyped(['nope']) }))).toBeInstanceOf(BadRequestError);
  });

  test('a sort key naming an Object.prototype member is a BadRequestError', async () => {
    expect(await rejection(repo.findMany({ sort: untyped(['constructor']) }))).toBeInstanceOf(BadRequestError);
  });

  test('equal sort values are ordered by the primary key', async () => {
    expect(ids((await repo.findMany({ sort: ['-qty'] })).items)).toEqual([5, 1, 2, 4, 3]);
  });

  test('paging a sort with ties and NULLs visits every row exactly once', async () => {
    const seen: (number | undefined)[] = [];
    for (let offset = 0; offset < 6; offset += 2) {
      seen.push(...ids((await repo.findMany({ sort: ['rank'], limit: 2, offset })).items));
    }
    expect(seen).toEqual([5, 1, 3, 2, 4]);
  });
});

describe('limit and offset', () => {
  test('an offset past the end returns no items but the full total', async () => {
    expect(await repo.findMany({ offset: 100, withTotal: true })).toEqual({ items: [], limit: 25, offset: 100, nextCursor: null, total: 5 });
  });

  test('a negative offset is treated as 0', async () => {
    const page = await repo.findMany({ offset: -5, limit: 1 });
    expect(page.offset).toBe(0);
    expect(ids(page.items)).toEqual([1]);
  });

  test('an Infinity limit is capped at maxLimit', async () => {
    const page = await capped.findMany({ limit: Number.POSITIVE_INFINITY });
    expect(page.limit).toBe(3);
    expect(page.items).toHaveLength(3);
  });

  test('a NaN offset is treated as 0', async () => {
    const page = await repo.findMany({ offset: Number.NaN, limit: 1 });
    expect(page.offset).toBe(0);
    expect(ids(page.items)).toEqual([1]);
  });

  test('a fractional limit is a BadRequestError, not a 500', async () => {
    expect(await rejection(repo.findMany({ limit: 1.5 }))).toBeInstanceOf(BadRequestError);
  });

  test('a NaN limit never bypasses maxLimit', async () => {
    expect((await capped.findMany({ limit: Number.NaN })).items.length).toBeLessThanOrEqual(3);
  });
});

describe('scope applies to every method', () => {
  test.each<[string, () => Promise<unknown>]>([
    ['findMany', async () => expect(ids((await repo.findMany({ scope: tenant2 })).items)).toEqual([4, 5])],
    ['findById', async () => expect(await repo.findById(1, { scope: tenant2 })).toBeNull()],
    ['a finder', async () => expect(ids((await repo.findByStatus('live', { scope: tenant2 })).items)).toEqual([4])],
    ['the withTotal count', async () => expect((await repo.findMany({ scope: tenant2, limit: 1, withTotal: true })).total).toBe(2)],
    ['update', async () => {
      expect(await rejection(repo.update(1, { name: 'stolen' }, { scope: tenant2 }))).toBeInstanceOf(NotFoundError);
      expect(await repo.findById(1, { columns: ['name'] })).toEqual({ name: 'Alpha' });
    }],
    ['delete', async () => {
      expect(await rejection(repo.delete(1, { scope: tenant2 }))).toBeInstanceOf(NotFoundError);
      expect(await repo.findById(1)).not.toBeNull();
    }],
    ['an extend query using baseWhere', async () => expect(ids(await extended.listRaw({ scope: tenant2 }))).toEqual([4, 5])],
  ])('%s', async (_label, check) => {
    await check();
  });
});

describe('soft delete applies to every path', () => {
  test.each<[string, () => Promise<unknown>]>([
    ['findById returns null', async () => expect(await repo.findById(6)).toBeNull()],
    ['findMany and its total skip the row', async () => {
      const page = await repo.findMany({ withTotal: true });
      expect(ids(page.items)).not.toContain(6);
      expect(page.total).toBe(5);
    }],
    ['a finder skips the row', async () => expect(ids((await repo.findByNameContaining('Deleted')).items)).toEqual([])],
    ['update is a NotFoundError', async () => expect(await rejection(repo.update(6, { name: 'back' }))).toBeInstanceOf(NotFoundError)],
    ['deleting again is a NotFoundError', async () => expect(await rejection(repo.delete(6))).toBeInstanceOf(NotFoundError)],
    ['an extend query using baseWhere skips the row', async () => expect(ids(await extended.listRaw())).not.toContain(6)],
    ['the unique constraint still sees the kept row', async () => {
      expect(await rejection(repo.create({ sku: 'A6', name: 'again' }))).toBeInstanceOf(ConflictError);
    }],
  ])('%s', async (_label, check) => {
    await check();
  });
});

describe('hidden columns', () => {
  test('are never returned by create, update, delete, findMany, findById or a finder', async () => {
    const created = await repo.create({ sku: 'H1', name: 'h', secret: 'TOPSECRET' });
    const results = [
      created,
      await repo.update(created.id, { name: 'h2', secret: 'TOPSECRET2' }),
      await repo.findById(created.id),
      (await repo.findMany()).items,
      (await repo.findByStatus('draft')).items,
      await repo.delete(created.id),
    ];
    expect(JSON.stringify(results)).not.toMatch(/secret/i);
  });

  test('asking for the hidden column in columns returns no value for it', async () => {
    expect(await repo.findById(1, { columns: untyped<readonly 'name'[]>(['secret', 'name']) })).toEqual({ name: 'Alpha' });
  });

  test("extend's project() leaves the hidden column out", async () => {
    expect(Object.keys((await extended.listRaw())[0] ?? {})).not.toContain('secret');
  });
});

describe('extend', () => {
  test('a check violation in a custom method is a BadRequestError', async () => {
    expect(await rejection(extended.setNegativeQty(1))).toBeInstanceOf(BadRequestError);
  });

  test('a CrudFactoryError thrown by a custom method passes through unchanged', async () => {
    const error = await rejection(extended.failWithNotFound());
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error instanceof CrudFactoryError && error.message).toBe('custom');
  });
});

describe('real database errors map to client errors', () => {
  test.each<[string, () => Promise<unknown>, typeof BadRequestError | typeof ConflictError, string?]>([
    ['23505 unique violation', () => repo.create({ sku: 'A1', name: 'dup' }), ConflictError, 'r_items_sku_unique'],
    ['23502 not-null violation', () => repo.create(untyped({ sku: 'N1', name: null })), BadRequestError],
    ['23503 missing foreign key', () => repo.create({ sku: 'F1', name: 'f', vendorId: 999 }), BadRequestError],
    ['23514 check violation', () => repo.create({ sku: 'C1', name: 'c', qty: -1 }), BadRequestError],
    ['22P02 invalid enum value', () => repo.create(untyped({ sku: 'E1', name: 'e', status: 'bogus' })), BadRequestError],
    ['22003 integer out of range', () => repo.create({ sku: 'O1', name: 'o', qty: 2 ** 31 }), BadRequestError],
    ['22001 value too long', () => repo.create({ sku: 'x'.repeat(13), name: 'long' }), BadRequestError],
    ['22007 invalid date format', () => eventRepo.create({ at: 'not a date' }), BadRequestError],
    ['22008 timestamp out of range', () => eventRepo.create({ at: '300000-01-01 00:00:00' }), BadRequestError],
    ['22000 range with lower bound above upper', () => eventRepo.create({ slot: '[5,1)' }), BadRequestError],
  ])('%s', async (_label, run, expected, constraint) => {
    const error = await rejection(run());
    expect(error).toBeInstanceOf(expected);
    expect(error).toMatchObject(constraint ? { constraint } : {});
  });

  test('23P01 exclusion violation is a ConflictError naming the constraint', async () => {
    await eventRepo.create({ slot: '[1,5)' });
    const error = await rejection(eventRepo.create({ slot: '[3,8)' }));
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ constraint: 'r_events_no_overlap' });
  });

  test('23503 on a hard delete of a referenced row is a ConflictError', async () => {
    const vendor = await vendorRepo.create({ name: 'v' });
    await repo.create({ sku: 'V1', name: 'v', vendorId: vendor.id });
    expect(await rejection(vendorRepo.delete(vendor.id))).toMatchObject({ code: 'CONFLICT', constraint: 'r_items_vendor_fk' });
  });

  test('22021 NUL byte in a text value is a BadRequestError', async () => {
    expect(await rejection(repo.create({ sku: 'Z1', name: 'a\u0000b' }))).toBeInstanceOf(BadRequestError);
  });
});
