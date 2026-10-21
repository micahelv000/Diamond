import { getColumns, type Column } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { bigintStringModeSchema, createSchemaFactory } from 'drizzle-orm/zod';
import { z } from 'zod';
import { isBigintColumn, isBooleanColumn, isDateObjectColumn, isFloatColumn } from './columns.ts';
import type { AnyEntity, EntityConfig, EntitySchemas, FilterOperator } from './types.ts';

const bodyFactory = createSchemaFactory();
// Path params and query values arrive as strings.
const queryFactory = createSchemaFactory({ coerce: { number: true, bigint: true } });

// JSON has no bigint type, so clients may send one as a string. drizzle caps floats far below what Postgres stores.
const writeSchemas = {
  int64: z.union([z.int(), bigintStringModeSchema]).pipe(z.coerce.bigint()),
  float: z.number(),
};
// Responses send bigints back as strings.
const readInt64 = z.codec(z.string(), z.bigint(), { decode: BigInt, encode: String });

/**
 * JSON has no date type, so clients send every date and time as an ISO 8601 string, checked with Zod's
 * built-in validators: `2026-03-01T10:00:00Z` (a timezone is required), `2026-03-01`, `10:00:00` or `PT1H30M`.
 */
function isoSchema(column: Column): z.ZodType | undefined {
  const sqlType = column.getSQLType();
  if (sqlType.startsWith('timestamp')) return z.iso.datetime({ offset: true });
  if (sqlType === 'date') return z.iso.date();
  if (sqlType.startsWith('time')) return z.iso.time();
  if (sqlType.startsWith('interval')) return z.iso.duration();
  return undefined;
}

function isTimestampWithoutTimeZone(column: Column): boolean {
  const sqlType = column.getSQLType();
  return sqlType.startsWith('timestamp') && !sqlType.endsWith('with time zone');
}

function writeSchema(column: Column): z.ZodType | undefined {
  const iso = isoSchema(column);
  if (iso) {
    if (isDateObjectColumn(column)) return iso.pipe(z.coerce.date());
    if (isTimestampWithoutTimeZone(column)) return iso.pipe(z.coerce.date()).transform((date) => date.toISOString());
    return iso;
  }
  if (isBigintColumn(column)) return writeSchemas.int64;
  if (isFloatColumn(column)) return writeSchemas.float;
  return undefined;
}

// Query values are strings, so booleans need `stringbool` (coercion reads "false" as true) and dates use the body formats.
function queryValueSchema(column: Column): z.ZodType | undefined {
  if (isBooleanColumn(column)) return z.stringbool();
  if (isoSchema(column)) return writeSchema(column);
  return undefined;
}

// drizzle's refinement parameter is typed from the table's keys, which a generic table doesn't have;
// an empty object type is assignable to it.
type DrizzleRefinements = Record<never, never>;

// Refinement functions keep drizzle's nullable and optional wrapping. The keys are only known at runtime.
export function refinements(table: PgTable, pick: (column: Column) => z.ZodType | undefined): DrizzleRefinements {
  return Object.fromEntries(
    Object.entries(getColumns(table)).flatMap(([key, column]) => {
      const schema = pick(column);
      return schema ? [[key, () => schema]] : [];
    }),
  );
}

// The schemas come from the same table as the types, so they match `$inferSelect`/`$inferInsert`.
// TypeScript can't prove that for a generic table, so this is the one place they get their types.
function typed<Out, In = unknown>(schema: z.ZodType): z.ZodType<Out, In> {
  return schema as z.ZodType<Out, In>;
}

export type Shape = Record<string, z.ZodType>;

function objectWithout(shape: Shape, keys: readonly string[]) {
  const omitted = new Set(keys);
  return z.object(Object.fromEntries(Object.entries(shape).filter(([key]) => !omitted.has(key))));
}

// Treat a blank query value as missing, since coercion would otherwise turn it into 0.
function blankAsUndefined<S extends z.ZodType>(schema: S) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema);
}

/** Accepts a comma-separated value or a repeated query param as an array. */
function commaList<S extends z.ZodType>(item: S) {
  return z.preprocess((value) => (typeof value === 'string' ? value.split(',') : value), z.array(item));
}

/** The querystring value schema for one filter operator, given the column's own value schema. */
function filterValueSchema(operator: FilterOperator, columnValue: z.ZodType): z.ZodType {
  if (operator === 'in') return commaList(columnValue);
  if (operator === 'ilike') return z.string().max(100);
  return columnValue;
}

// Each operator in `filterable` becomes a `column__operator` key, parsed into the value type `where` expects.
function filterShape(config: EntityConfig<PgTable>, valueShape: Shape): Shape {
  const shape: Shape = {};
  for (const [column, operators = []] of Object.entries(config.filterable ?? {})) {
    const columnValue = valueShape[column];
    if (!columnValue) throw new Error(`Filterable column "${column}" has no schema`);
    for (const operator of operators) {
      shape[`${column}__${operator}`] = blankAsUndefined(filterValueSchema(operator, columnValue).optional());
    }
  }
  return shape;
}

// `.strict()` turns any unknown key, including an undeclared filter, into a 400.
function buildListQuery(config: EntityConfig<PgTable>, visibleKeys: [string, ...string[]], valueShape: Shape) {
  const sortable = config.sortable ?? [];
  const sortSpecs = sortable.flatMap((key) => [key, `-${key}`]);

  return z
    .object({
      ...filterShape(config, valueShape),
      sort: (sortSpecs.length > 0 ? commaList(z.enum(sortSpecs)) : z.never()).optional(),
      // The repository applies the default and the `maxLimit` cap, so code callers get them too.
      limit: z.coerce.number().int().min(1).optional(),
      offset: z.coerce.number().int().min(0).default(0),
      // The repository decodes and checks the cursor, so code callers get the same 400s.
      cursor: blankAsUndefined(z.string().optional()),
      fields: commaList(z.enum(visibleKeys)).optional(),
      total: z.stringbool().optional(),
    })
    .strict()
    .transform(({ sort, limit, offset, cursor, fields, total, ...where }) => ({
      where,
      sort,
      limit,
      offset,
      cursor,
      columns: fields,
      withTotal: total,
    }));
}

/** Derives every Zod schema for an entity from its table and config. */
export function buildSchemas<E extends AnyEntity>(
  table: PgTable,
  config: EntityConfig<PgTable>,
  visibleKeys: [string, ...string[]],
  // Hidden and soft-delete columns: never sent to clients or accepted from them. Service hooks can still set them.
  serverOnly: readonly string[],
): EntitySchemas<E> {
  const writes = refinements(table, writeSchema);
  const reads = refinements(table, (column) => (isBigintColumn(column) ? readInt64 : undefined));
  const read = objectWithout(bodyFactory.createSelectSchema(table, reads).shape, serverOnly);
  const create = objectWithout(bodyFactory.createInsertSchema(table, writes).shape, [...(config.create?.omit ?? []), ...serverOnly]);
  const update = objectWithout(bodyFactory.createUpdateSchema(table, writes).shape, [
    ...(config.update?.omit ?? []),
    ...serverOnly,
    config.primaryKey,
  ]).refine((patch) => Object.keys(patch).length > 0, { message: 'At least one field is required' });

  const queryShape: Shape = queryFactory.createSelectSchema(table, refinements(table, queryValueSchema)).shape;
  const primaryKeySchema = queryShape[config.primaryKey];
  if (!primaryKeySchema) throw new Error(`Primary key "${config.primaryKey}" has no schema`);

  const getQuery = z
    .object({ fields: commaList(z.enum(visibleKeys)).optional() })
    .strict()
    .transform(({ fields }) => ({ columns: fields }));

  return {
    read: typed(read),
    readPartial: typed(read.partial()),
    create: typed(create),
    update: typed(update),
    params: typed(z.object({ id: blankAsUndefined(primaryKeySchema) })),
    listQuery: typed(buildListQuery(config, visibleKeys, queryShape)),
    getQuery: typed(getQuery),
    listResult: typed(
      z.object({
        items: z.array(read.partial()),
        limit: z.number(),
        offset: z.number(),
        nextCursor: z.string().nullable(),
        total: z.number().optional(),
      }),
    ),
  };
}
