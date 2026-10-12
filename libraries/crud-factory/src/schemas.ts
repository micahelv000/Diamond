import { extractExtendedColumnType, getColumns, type Column } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { bigintStringModeSchema, createSchemaFactory } from 'drizzle-orm/zod';
import { z } from 'zod';
import type { AnyEntity, EntityConfig, EntitySchemas } from './types.ts';

const bodyFactory = createSchemaFactory();
// Path params arrive as strings.
const queryFactory = createSchemaFactory({ coerce: { number: true, bigint: true } });

// JSON has no Date or bigint type. Request bodies send them as strings, checked by Zod's and drizzle's validators.
const writeSchemas = {
  timestamp: z.union([z.date(), z.iso.datetime({ offset: true }).pipe(z.coerce.date())]),
  day: z.union([z.date(), z.iso.date().pipe(z.coerce.date())]),
  dayString: z.iso.date(),
  int64: z.union([z.int(), bigintStringModeSchema]).pipe(z.coerce.bigint()),
  // drizzle caps floats far below what Postgres stores.
  float: z.number(),
};
// Responses send bigints back as strings.
const readInt64 = z.codec(z.string(), z.bigint(), { decode: BigInt, encode: String });

function writeSchema(column: Column): z.ZodType | undefined {
  const { type, constraint } = extractExtendedColumnType(column);
  if (constraint === 'date') return type === 'string' ? writeSchemas.dayString : column.getSQLType() === 'date' ? writeSchemas.day : writeSchemas.timestamp;
  if (constraint === 'int64' && type === 'bigint') return writeSchemas.int64;
  if (constraint === 'float' || constraint === 'double') return writeSchemas.float;
  return undefined;
}

// Refinement functions keep drizzle's nullable and optional wrapping. The keys are only known at runtime.
function refinements(table: PgTable, pick: (column: Column) => z.ZodType | undefined): Record<never, never> {
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

type Shape = Record<string, z.ZodType>;

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

// The URL takes no filters, since `filterable` only generates finder methods for code.
// `.strict()` turns any unknown key into a 400.
function buildListQuery(config: EntityConfig<PgTable>, visibleKeys: [string, ...string[]]) {
  const sortable = config.sortable ?? [];
  const sortSpecs = sortable.flatMap((key) => [key, `-${key}`]);

  return z
    .object({
      sort: (sortSpecs.length > 0 ? commaList(z.enum(sortSpecs)) : z.never()).optional(),
      // The repository applies the default and the `maxLimit` cap, so code callers get them too.
      limit: z.coerce.number().int().min(1).optional(),
      offset: z.coerce.number().int().min(0).default(0),
      fields: commaList(z.enum(visibleKeys)).optional(),
      total: z.stringbool().optional(),
    })
    .strict()
    .transform(({ sort, limit, offset, fields, total }) => ({
      sort,
      limit,
      offset,
      columns: fields,
      withTotal: total,
    }));
}

/** Derives every Zod schema for an entity from its table and config. */
export function buildSchemas<E extends AnyEntity>(
  table: PgTable,
  config: EntityConfig<PgTable>,
  visibleKeys: [string, ...string[]],
): EntitySchemas<E> {
  const hidden = config.hidden ?? [];
  // Clients can't write hidden or soft-delete columns; service hooks still can.
  const serverOnly = config.softDelete ? [...hidden, config.softDelete] : hidden;
  const writes = refinements(table, writeSchema);
  const reads = refinements(table, (column) => (writeSchema(column) === writeSchemas.int64 ? readInt64 : undefined));
  const read = objectWithout(bodyFactory.createSelectSchema(table, reads).shape, hidden);
  const create = objectWithout(bodyFactory.createInsertSchema(table, writes).shape, [...(config.create?.omit ?? []), ...serverOnly]);
  const update = objectWithout(bodyFactory.createUpdateSchema(table, writes).shape, [
    ...(config.update?.omit ?? []),
    ...serverOnly,
    config.primaryKey,
  ]).refine((patch) => Object.keys(patch).length > 0, { message: 'At least one field is required' });

  const queryShape: Shape = queryFactory.createSelectSchema(table).shape;
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
    listQuery: typed(buildListQuery(config, visibleKeys)),
    getQuery: typed(getQuery),
    listResult: typed(
      z.object({
        items: z.array(read.partial()),
        limit: z.number().nullable(),
        offset: z.number(),
        total: z.number().optional(),
      }),
    ),
  };
}
