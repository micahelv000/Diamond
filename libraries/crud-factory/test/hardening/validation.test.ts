// Edge cases for the Zod schemas `defineEntity` derives from a table, and for its config checks.
import {
  bigint, boolean, date, doublePrecision, integer, json, numeric, pgEnum, pgTable, real, text, timestamp, uuid, varchar,
} from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, test } from 'vitest';
import { defineEntity } from '../../src/index.ts';

const mood = pgEnum('v_mood', ['happy', 'sad']);

/** One column per kind, NOT NULL and nullable where it matters. Only parsed, never created in a database. */
const kinds = pgTable('v_kinds', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  int: integer().notNull(),
  intN: integer('int_n'),
  bigBig: bigint('big_big', { mode: 'bigint' }),
  num: numeric(),
  re: real(),
  dbl: doublePrecision(),
  bool: boolean().notNull().default(false),
  en: mood().notNull().default('happy'),
  txt: text().notNull(),
  vc: varchar({ length: 10 }),
  ts: timestamp().notNull(),
  tsN: timestamp('ts_n'),
  day: date({ mode: 'date' }),
  dayStr: date('day_str', { mode: 'string' }),
  j: json().notNull(),
  jN: json('j_n'),
  u: uuid(),
  tags: text().array(),
  // Server-controlled columns.
  secret: text(),
  internal: text(),
  locked: text(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

const kindsEntity = defineEntity(kinds, {
  primaryKey: 'id',
  hidden: ['secret'],
  create: { omit: ['internal'] },
  update: { omit: ['internal', 'locked'] },
  softDelete: 'deletedAt',
  sortable: ['int', 'txt'],
  filterable: { txt: ['eq', 'ilike'], int: ['gte', 'lte'] },
});
const { schemas } = kindsEntity;

const tokens = pgTable('v_tokens', { id: uuid().primaryKey().defaultRandom(), label: text().notNull() });
const tokenEntity = defineEntity(tokens, { primaryKey: 'id' });

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const ISO = '2026-03-04T05:06:07.000Z';

/** The smallest body `create` accepts: every NOT NULL column without a default. */
const validCreate = (): Record<string, unknown> => ({ int: 1, txt: 'text', ts: ISO, j: { a: 1 } });

type Parsed = { ok: true; data: Record<string, unknown> } | { ok: false };

function parse(schema: { safeParse(input: unknown): { success: boolean; data?: unknown } }, input: unknown): Parsed {
  const result = schema.safeParse(input);
  if (!result.success) return { ok: false };
  const data: unknown = result.data;
  return { ok: true, data: typeof data === 'object' && data !== null ? Object.fromEntries(Object.entries(data)) : {} };
}

/** Parses `{ [key]: value }` as a patch and returns the parsed value, or `'rejected'`. */
function patchValue(key: string, value: unknown): unknown {
  const result = parse(schemas.update, { [key]: value });
  return result.ok ? result.data[key] : 'rejected';
}

/** Calls `defineEntity` with a config the types would reject, as config built from untyped data would be. */
function defineUntyped(table: PgTable, config: unknown) {
  // @ts-expect-error -- simulates a config built from untyped data or a cast
  return defineEntity(table, config);
}

describe('date and timestamp columns', () => {
  test('null is rejected on a NOT NULL timestamp and kept on a nullable one', () => {
    expect(parse(schemas.create, { ...validCreate(), ts: null }).ok).toBe(false);
    expect(patchValue('tsN', null)).toBeNull();
  });

  test.each([
    ['true', true],
    ['a millisecond timestamp', Date.UTC(2026, 2, 4)],
    ['a garbage string', 'not a date'],
    ['an invalid Date object', new Date('nope')],
  ])('rejects %s', (_label, value) => {
    expect(patchValue('ts', value)).toBe('rejected');
  });

  test.each([
    ['an ISO string with an offset', '2026-03-04T05:06:07+05:30', '2026-03-03T23:36:07.000Z'],
    ['a Date object', new Date(ISO), ISO],
  ])('accepts %s as the same instant', (_label, value, instant) => {
    const parsed = patchValue('ts', value);
    expect(parsed).toBeInstanceOf(Date);
    expect(parsed instanceof Date && parsed.toISOString()).toBe(instant);
  });

  test('a date-mode date column turns an ISO day into midnight UTC', () => {
    expect(patchValue('day', '2026-03-04')).toEqual(new Date('2026-03-04T00:00:00Z'));
  });

  test.each(['2026-02-30', '2026-13-01', '2026-00-10'])('rejects the impossible calendar date %s instead of rolling it over', (value) => {
    expect(patchValue('day', value)).toBe('rejected');
    expect(patchValue('dayStr', value)).toBe('rejected');
    expect(patchValue('ts', `${value}T00:00:00Z`)).toBe('rejected');
  });

  test('accepts a leap day only in a leap year', () => {
    expect(patchValue('dayStr', '2028-02-29')).toBe('2028-02-29');
    expect(patchValue('dayStr', '2026-02-29')).toBe('rejected');
  });

  test('rejects a bare digit string', () => {
    expect(patchValue('ts', '42')).toBe('rejected');
  });

  test('rejects a non-ISO date string', () => {
    expect(patchValue('ts', 'March 4, 2026')).toBe('rejected');
  });

  test.each([
    ['without an offset', '2026-03-04T05:06:07'],
    ['as a bare day', '2026-03-04'],
  ])('a timestamp rejects an ISO string %s', (_label, value) => {
    expect(patchValue('ts', value)).toBe('rejected');
  });

  test.each([
    ['a Z offset with fractional seconds', '2026-03-04T05:06:07.123456Z', '2026-03-04T05:06:07.123Z'],
    ['a +02:00 offset', '2026-03-04T05:06:07+02:00', '2026-03-04T03:06:07.000Z'],
  ])('a timestamp accepts %s', (_label, value, instant) => {
    const parsed = patchValue('ts', value);
    expect(parsed instanceof Date && parsed.toISOString()).toBe(instant);
  });

  test('a string-mode date column keeps the string it was given', () => {
    expect(patchValue('dayStr', '2026-03-04')).toBe('2026-03-04');
  });
});

describe('number and bigint columns', () => {
  test.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a numeric string', '42'],
    ['2^31, past int4', 2 ** 31],
  ])('an integer column rejects %s', (_label, value) => {
    expect(patchValue('int', value)).toBe('rejected');
  });

  test('a string-mode numeric keeps the exact decimal string and rejects a JS number', () => {
    expect(patchValue('num', '12345678901234567890.123')).toBe('12345678901234567890.123');
    expect(patchValue('num', 1.5)).toBe('rejected');
  });

  test('a bigint-mode column accepts a digit string from a JSON body', () => {
    expect(patchValue('bigBig', '9007199254740993')).toBe(9_007_199_254_740_993n);
    expect(patchValue('bigBig', '-42')).toBe(-42n);
  });

  test('a bigint-mode column accepts a safe integer and rejects an unsafe one', () => {
    expect(patchValue('bigBig', 42)).toBe(42n);
    expect(patchValue('bigBig', 2 ** 53)).toBe('rejected');
  });

  test.each([
    ['a float', 1.5],
    ['NaN', Number.NaN],
    ['a decimal string', '1.5'],
    ['junk', '12abc'],
  ])('a bigint-mode column rejects %s', (_label, value) => {
    expect(patchValue('bigBig', value)).toBe('rejected');
  });

  test('a response encodes a bigint-mode value as a string', () => {
    const row = { id: 1, bigBig: 9_007_199_254_740_993n };
    expect(schemas.readPartial.encode(row)).toEqual({ id: 1, bigBig: '9007199254740993' });
  });

  test('a real column accepts 2^31', () => {
    expect(patchValue('re', 2 ** 31)).toBe(2 ** 31);
  });

  test('a double precision column accepts 1e20', () => {
    expect(patchValue('dbl', 1e20)).toBe(1e20);
  });

  test.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('real and double precision columns reject %s', (_label, value) => {
    expect(patchValue('re', value)).toBe('rejected');
    expect(patchValue('dbl', value)).toBe('rejected');
  });
});

describe('boolean, enum, text and uuid columns', () => {
  test.each([
    ["the string 'true'", 'true'],
    ['the number 1', 1],
  ])('a boolean column rejects %s', (_label, value) => {
    expect(patchValue('bool', value)).toBe('rejected');
  });

  test.each([
    ['a different case', 'HAPPY'],
    ['an unknown value', 'angry'],
  ])('an enum column rejects %s', (_label, value) => {
    expect(patchValue('en', value)).toBe('rejected');
  });

  test('varchar(10) accepts 10 characters and rejects 11', () => {
    expect(patchValue('vc', 'a'.repeat(10))).toBe('a'.repeat(10));
    expect(patchValue('vc', 'a'.repeat(11))).toBe('rejected');
  });

  test('varchar(10) counts characters, not UTF-16 units: 10 emoji fit', () => {
    expect(patchValue('vc', '😀'.repeat(10))).toBe('😀'.repeat(10));
  });

  test('a uuid column accepts a canonical uuid and rejects anything else', () => {
    expect(patchValue('u', UUID)).toBe(UUID);
    expect(patchValue('u', 'not-a-uuid')).toBe('rejected');
    expect(patchValue('u', `${UUID}0`)).toBe('rejected');
  });

  test('a nullable json column keeps null, and a NOT NULL json column is required on create', () => {
    expect(patchValue('jN', null)).toBeNull();
    const { j: _omitted, ...withoutJson } = validCreate();
    expect(parse(schemas.create, withoutJson).ok).toBe(false);
  });

  test('a patch with only unknown keys is an empty patch and is rejected', () => {
    expect(parse(schemas.update, { isAdmin: true }).ok).toBe(false);
  });

  test('__proto__ and constructor keys from a JSON body are stripped and pollute nothing', () => {
    const body: unknown = JSON.parse(`{"int":1,"txt":"t","ts":"${ISO}","j":{},"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}`);
    const result = parse(schemas.create, body);
    expect(result.ok).toBe(true);
    expect(result.ok && Object.keys(result.data).sort()).toEqual(['int', 'j', 'ts', 'txt']);
    expect(Reflect.get({}, 'polluted')).toBeUndefined();
  });

  test.each([
    ['a create.omit column', 'internal', 'x'],
    ['the hidden column', 'secret', 'x'],
    ['the soft-delete column', 'deletedAt', ISO],
  ])('create strips %s', (_label, key, value) => {
    const result = parse(schemas.create, { ...validCreate(), [key]: value });
    expect(result.ok && key in result.data).toBe(false);
  });

  test.each([
    ['an update.omit column', 'locked', 'x'],
    ['the soft-delete column', 'deletedAt', null],
  ])('update strips %s, leaving an empty patch', (_label, key, value) => {
    expect(parse(schemas.update, { [key]: value }).ok).toBe(false);
  });

  test('an integer id coerces a decimal string', () => {
    expect(parse(schemas.params, { id: '42' })).toEqual({ ok: true, data: { id: 42 } });
  });

  test('a uuid id accepts a uuid and rejects a number or a truncated value', () => {
    expect(parse(tokenEntity.schemas.params, { id: UUID })).toEqual({ ok: true, data: { id: UUID } });
    expect(parse(tokenEntity.schemas.params, { id: '1' }).ok).toBe(false);
    expect(parse(tokenEntity.schemas.params, { id: UUID.slice(0, -1) }).ok).toBe(false);
  });
});

describe('listQuery', () => {
  test.each(['0', '1.5', 'abc', ''])('rejects limit=%j', (limit) => {
    expect(parse(schemas.listQuery, { limit }).ok).toBe(false);
  });

  test('passes a huge limit through for the repository to cap', () => {
    const result = parse(schemas.listQuery, { limit: '1000000' });
    expect(result.ok && result.data.limit).toBe(1_000_000);
  });

  test.each(['-1', 'abc'])('rejects offset=%j', (offset) => {
    expect(parse(schemas.listQuery, { offset }).ok).toBe(false);
  });

  test.each([
    ['an unsortable column', 'id'],
    ['the hidden column', 'secret'],
    ['a bare dash', '-'],
    ['an empty item', 'int,'],
  ])('rejects sort with %s', (_label, sort) => {
    expect(parse(schemas.listQuery, { sort }).ok).toBe(false);
  });

  test('rejects fields naming the hidden column or an unknown one', () => {
    expect(parse(schemas.listQuery, { fields: 'id,secret' }).ok).toBe(false);
    expect(parse(schemas.listQuery, { fields: 'id,nope' }).ok).toBe(false);
  });

  test("parses total=true and total=false, and rejects total=maybe", () => {
    expect(parse(schemas.listQuery, { total: 'true' })).toMatchObject({ ok: true, data: { withTotal: true } });
    expect(parse(schemas.listQuery, { total: 'false' })).toMatchObject({ ok: true, data: { withTotal: false } });
    expect(parse(schemas.listQuery, { total: 'maybe' }).ok).toBe(false);
  });

  test.each(['txt__eq', 'where'])('a filter-like key %j in the URL is rejected', (key) => {
    expect(parse(schemas.listQuery, { [key]: 'x' }).ok).toBe(false);
  });
});

describe('defineEntity config errors', () => {
  const base = { primaryKey: 'id' };

  test('a NOT NULL softDelete column throws', () => {
    expect(() => defineUntyped(kinds, { ...base, softDelete: 'ts' })).toThrow('softDelete column must be nullable');
  });

  test('hiding the primary key throws', () => {
    expect(() => defineUntyped(kinds, { ...base, hidden: ['id'] })).toThrow('the primary key cannot be hidden');
  });

  test('an unknown operator throws', () => {
    expect(() => defineUntyped(kinds, { ...base, filterable: { txt: ['like'] } })).toThrow('filterable.txt has unknown operator "like"');
  });

  test("a defaultSort of '-' alone throws", () => {
    expect(() => defineUntyped(kinds, { ...base, defaultSort: '-' })).toThrow('defaultSort references unknown column ""');
  });

  test("an empty-string operator throws", () => {
    expect(() => defineUntyped(kinds, { ...base, filterable: { txt: ['eq', ''] } })).toThrow('unknown operator');
  });

  test('ilike on a text[] column throws', () => {
    expect(() => defineUntyped(kinds, { ...base, filterable: { tags: ['ilike'] } })).toThrow('uses ilike');
  });

  test('a non-timestamp softDelete column throws', () => {
    expect(() => defineUntyped(kinds, { ...base, softDelete: 'intN' })).toThrow();
  });

  test('a fractional, zero or negative limit throws', () => {
    for (const pagination of [{ maxLimit: 2.5 }, { maxLimit: 0 }, { defaultLimit: -1 }]) {
      expect(() => defineUntyped(kinds, { ...base, pagination })).toThrow('must be a positive integer');
    }
  });
});
