import { integer, interval, pgTable, time, timestamp } from 'drizzle-orm/pg-core';
import { describe, expect, test } from 'vitest';
import { defineEntity } from '../src/index.ts';
import { userEntity } from './fixtures/entities.ts';
import { users } from './fixtures/schema.ts';

const { schemas } = userEntity;

describe('listQuery', () => {
  test('parses sort, pagination, fields and total from strings', () => {
    const parsed = schemas.listQuery.parse({
      sort: '-createdAt,name',
      limit: '500',
      offset: '4',
      fields: 'id,name',
      total: 'true',
    });
    expect(parsed).toEqual({
      where: {},
      sort: ['-createdAt', 'name'],
      // Passed through: the repository applies the default and clamps to maxLimit.
      limit: 500,
      offset: 4,
      columns: ['id', 'name'],
      withTotal: true,
    });
  });

  test('leaves limit to the repository and defaults offset to 0', () => {
    expect(schemas.listQuery.parse({})).toEqual({ where: {}, sort: undefined, limit: undefined, offset: 0, columns: undefined, withTotal: undefined });
  });

  test('parses declared filters into where', () => {
    const parsed = schemas.listQuery.parse({ status__in: 'active,banned', createdAt__gte: '2026-01-01T00:00:00Z', orgId__eq: '7', name__ilike: '' });
    expect(parsed.where).toEqual({ status__in: ['active', 'banned'], createdAt__gte: new Date('2026-01-01T00:00:00Z'), orgId__eq: 7 });
  });

  test.each([
    ['unknown key', { nope: '1' }],
    ['an undeclared filter key', { email__eq: 'a@b.c' }],
    ['a timestamp filter without a time', { createdAt__gte: '2026-01-01' }],
    ['an ilike filter over 100 characters', { name__ilike: 'a'.repeat(101) }],
    ['hidden field', { fields: 'passwordHash' }],
    ['a visible but unsortable key', { sort: 'email' }],
    ['negative offset', { offset: '-1' }],
  ])('rejects %s', (_label, query) => {
    expect(schemas.listQuery.safeParse(query).success).toBe(false);
  });
});

describe('body schemas', () => {
  test('read strips hidden columns', () => {
    const row = { id: 1, email: 'a@b.c', name: 'A', passwordHash: 'x', status: 'active', orgId: 1, createdAt: new Date(), deletedAt: null };
    expect(schemas.read.parse(row)).not.toHaveProperty('passwordHash');
  });

  test('create omits configured keys and requires the rest', () => {
    const parsed = schemas.create.parse({ id: 5, email: 'a@b.c', name: 'A', passwordHash: 'x', orgId: 1 });
    expect(parsed).not.toHaveProperty('id');
    expect(schemas.create.safeParse({ name: 'A' }).success).toBe(false);
  });

  test('create and update always drop hidden and soft-delete columns', () => {
    const body = { email: 'a@b.c', name: 'A', orgId: 1, passwordHash: 'x', deletedAt: '2020-01-01T00:00:00Z' };
    expect(schemas.create.parse(body)).toEqual({ email: 'a@b.c', name: 'A', orgId: 1 });
    expect(schemas.update.parse({ name: 'B', passwordHash: 'x', deletedAt: '2020-01-01T00:00:00Z' })).toEqual({ name: 'B' });
  });

  test('update is partial, drops omitted keys and needs at least one field', () => {
    expect(schemas.update.parse({ name: 'B', email: 'ignored@b.c' })).toEqual({ name: 'B' });
    expect(schemas.update.safeParse({}).success).toBe(false);
  });

  test('params coerce the primary key', () => {
    expect(schemas.params.parse({ id: '42' })).toEqual({ id: 42 });
    expect(schemas.params.safeParse({ id: 'abc' }).success).toBe(false);
    // An empty id would otherwise coerce to 0.
    expect(schemas.params.safeParse({ id: '' }).success).toBe(false);
  });

  test('getQuery parses fields', () => {
    expect(schemas.getQuery.parse({ fields: 'id,email' })).toEqual({ columns: ['id', 'email'] });
  });
});

describe('date columns', () => {
  const events = pgTable('events', {
    id: integer().primaryKey(),
    at: timestamp({ withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
  });
  const { schemas: eventSchemas } = defineEntity(events, { primaryKey: 'id', softDelete: false });

  test.each([
    ['null', null],
    ['a boolean', true],
    ['a number', 0],
    ['an object', {}],
    ['an array', []],
    ['an unparseable string', 'not a date'],
  ])('rejects %s on a NOT NULL column in create and update', (_label, at) => {
    expect(eventSchemas.create.safeParse({ id: 1, at }).success).toBe(false);
    expect(eventSchemas.update.safeParse({ at }).success).toBe(false);
  });

  test('accepts an ISO string and returns a Date', () => {
    const expected = new Date('2026-03-04T05:06:07.000Z');
    expect(eventSchemas.create.parse({ id: 1, at: '2026-03-04T05:06:07.000Z' })).toEqual({ id: 1, at: expected });
    expect(eventSchemas.update.parse({ at: '2026-03-04T05:06:07.000Z' })).toEqual({ at: expected });
  });

  test('rejects a Date object: clients send ISO strings', () => {
    expect(eventSchemas.create.safeParse({ id: 1, at: new Date(0) }).success).toBe(false);
  });

  test('accepts null on a nullable column and still rejects other types', () => {
    expect(eventSchemas.create.parse({ id: 1, at: '1970-01-01T00:00:00Z', endsAt: null })).toEqual({ id: 1, at: new Date(0), endsAt: null });
    expect(eventSchemas.update.parse({ endsAt: null })).toEqual({ endsAt: null });
    expect(eventSchemas.update.safeParse({ endsAt: true }).success).toBe(false);
  });

  test('keeps a NOT NULL column without a default required on create', () => {
    expect(eventSchemas.create.safeParse({ id: 1 }).success).toBe(false);
  });
});

describe('every date and time column takes its ISO format, in bodies and URL filters', () => {
  const times = pgTable('times', {
    id: integer().primaryKey(),
    at: timestamp({ withTimezone: true, mode: 'string' }),
    localAt: timestamp('local_at', { mode: 'string' }),
    opensAt: time('opens_at'),
    lasts: interval(),
  });
  const { schemas } = defineEntity(times, {
    primaryKey: 'id',
    softDelete: false,
    filterable: { at: ['gte'], localAt: ['gte'], opensAt: ['gte'], lasts: ['gte'] },
  });
  const accepts = (key: string, value: string) =>
    schemas.create.safeParse({ id: 1, [key]: value }).success && schemas.listQuery.safeParse({ [`${key}__gte`]: value }).success;
  const rejects = (key: string, value: string) =>
    !schemas.create.safeParse({ id: 1, [key]: value }).success && !schemas.listQuery.safeParse({ [`${key}__gte`]: value }).success;

  test.each([
    ['a string-mode timestamp', 'at', '2026-03-04T05:06:07Z', ['2026-03-04T05:06:07', '2026-02-30T00:00:00Z', 'not a date']],
    ['a time', 'opensAt', '09:30:00', ['9am', '25:00:00', '2026-03-04T09:30:00Z']],
    ['an interval', 'lasts', 'PT1H30M', ['1 hour', 'P', '90']],
  ] as const)('%s', (_label, key, good, bad) => {
    expect(accepts(key, good)).toBe(true);
    for (const value of bad) expect(rejects(key, value)).toBe(true);
  });

  test('a string-mode timestamp with time zone keeps the string, offset included', () => {
    expect(schemas.create.parse({ id: 1, at: '2026-03-04T05:06:07+02:00' })).toMatchObject({ at: '2026-03-04T05:06:07+02:00' });
  });

  test('a timestamp without time zone gets the moment in UTC, so the offset is never lost', () => {
    expect(schemas.create.parse({ id: 1, localAt: '2026-03-04T10:00:00+02:00' })).toMatchObject({ localAt: '2026-03-04T08:00:00.000Z' });
    expect(schemas.listQuery.parse({ localAt__gte: '2026-03-04T10:00:00+02:00' })).toMatchObject({
      where: { localAt__gte: '2026-03-04T08:00:00.000Z' },
    });
  });
});

describe('defineEntity validation', () => {
  test('rejects keys that are not columns at load time', () => {
    // @ts-expect-error -- simulates a config built from untyped data
    expect(() => defineEntity(users, { primaryKey: 'id', sortable: ['missing'] })).toThrow('sortable references unknown column "missing"');
  });

  test('accepts a defaultSort on any visible column, rejects unknown columns and a hidden primary key', () => {
    // `sortable` only limits the URL, so the default order can use any visible column.
    expect(defineEntity(users, { primaryKey: 'id', sortable: ['name'], defaultSort: '-email' }).config.defaultSort).toBe('-email');
    expect(() =>
      defineEntity(users, {
        primaryKey: 'id',
        // @ts-expect-error -- defaultSort must name a column
        defaultSort: 'nope',
      }),
    ).toThrow('defaultSort references unknown column "nope"');
    expect(() => defineEntity(users, { primaryKey: 'id', hidden: ['id'] })).toThrow('primary key cannot be hidden');
  });

  test('rejects hidden columns in filterable, sortable and defaultSort', () => {
    expect(() =>
      defineEntity(users, {
        primaryKey: 'id',
        hidden: ['passwordHash'],
        // @ts-expect-error -- a hidden column can't be filterable
        filterable: { passwordHash: ['eq'] },
      }),
    ).toThrow('hidden column "passwordHash" cannot be filterable or sortable');
    expect(() =>
      defineEntity(users, {
        primaryKey: 'id',
        hidden: ['passwordHash'],
        // @ts-expect-error -- a hidden column can't be sortable
        sortable: ['name', 'passwordHash'],
      }),
    ).toThrow('hidden column "passwordHash" cannot be filterable or sortable');
    // Untyped data: the type check is bypassed, the load-time check still applies.
    const untyped: { primaryKey: 'id'; hidden: ['passwordHash']; sortable: ['name']; defaultSort: string } = {
      primaryKey: 'id',
      hidden: ['passwordHash'],
      sortable: ['name'],
      defaultSort: '-passwordHash',
    };
    // @ts-expect-error -- defaultSort is a plain string here
    expect(() => defineEntity(users, untyped)).toThrow('hidden column "passwordHash"');
  });

  test('rejects ilike on a column that is not text', () => {
    expect(() => defineEntity(users, { primaryKey: 'id', filterable: { status: ['ilike'] } })).toThrow('filterable.status uses ilike');
    expect(() => defineEntity(users, { primaryKey: 'id', filterable: { orgId: ['ilike'] } })).toThrow('filterable.orgId uses ilike');
  });
});
