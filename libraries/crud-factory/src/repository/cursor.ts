/*
 * Cursor pagination.
 *
 * A cursor marks the last row of a page. It stores that row's values for every column in the
 * ORDER BY (the primary key is always the last one), plus the sort it was made for. To fetch the
 * next page, we ask the database for the rows that come after those values in the same order.
 *
 * The cursor is sent to clients as base64url-encoded JSON, so it is opaque but not secret.
 */
import { and, eq, gt, isNotNull, isNull, lt, or, sql, type Column, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { createSchemaFactory } from 'drizzle-orm/zod';
import { z } from 'zod';
import { isBigintColumn, isDateObjectColumn } from '../columns.ts';
import { BadRequestError } from '../errors.ts';
import { refinements, type Shape } from '../schemas.ts';
import type { SortKey } from './sort.ts';

/** What a cursor contains once decoded. */
const cursorContentsSchema = z
  .object({
    /** The sort the cursor was made for. A cursor only works with the same sort. */
    sort: z.array(z.string()),
    /** The last row's value for each sort column, in ORDER BY order. */
    values: z.array(z.unknown()),
  })
  .strict();
type CursorContents = z.infer<typeof cursorContentsSchema>;

// Dates are stored in the cursor as the database's own text, not as a JavaScript Date: a Date keeps
// only milliseconds while Postgres keeps microseconds, so rounding could repeat or skip rows.
const dateAsText = z.union([z.iso.datetime({ offset: true, local: true }), z.iso.date()]);

// JSON has no bigint type, so bigints are stored in the cursor as strings.
const bigintAsText = z.codec(z.string().regex(z.regexes.integer), z.int64(), {
  decode: (text) => BigInt(text),
  encode: (value) => value.toString(),
});

/** The schema for a column's value inside a cursor, when it differs from the column's normal schema. */
function cursorValueSchema(column: Column): z.ZodType | undefined {
  if (isDateObjectColumn(column)) return dateAsText;
  if (isBigintColumn(column)) return bigintAsText;
  return undefined;
}

function invalidCursor(cause?: unknown): BadRequestError {
  return new BadRequestError('Invalid cursor', { cause });
}

function readCursorContents(cursor: string): CursorContents {
  if (!z.base64url().safeParse(cursor).success) {
    throw invalidCursor();
  }

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch (error) {
    throw invalidCursor(error);
  }

  const parsed = cursorContentsSchema.safeParse(json);
  if (!parsed.success) {
    throw invalidCursor(parsed.error);
  }
  return parsed.data;
}

function isSameSort(first: readonly string[], second: readonly string[]): boolean {
  if (first.length !== second.length) {
    return false;
  }
  return first.every((spec, index) => spec === second[index]);
}

/**
 * The condition for "this column's value comes after `value`" in the sort order.
 *
 * Postgres puts NULLs last when sorting ascending and first when sorting descending, so:
 * - Ascending, after a value:  bigger values, then NULLs.
 * - Ascending, after a NULL:   nothing (NULLs are already last).
 * - Descending, after a value: smaller values (NULLs came first, so they are not after it).
 * - Descending, after a NULL:  every non-NULL value.
 *
 * Returns `undefined` when nothing can come after the value.
 */
function comesAfter(sortKey: SortKey, value: unknown): SQL | undefined {
  const { column, descending } = sortKey;

  if (value === null) {
    if (descending) {
      return isNotNull(column);
    }
    return undefined;
  }

  if (descending) {
    return lt(column, value);
  }
  if (column.notNull) {
    return gt(column, value);
  }
  return or(gt(column, value), isNull(column));
}

/** The condition for "this column's value equals `value`", where NULL equals NULL. */
function hasSameValue(column: PgColumn, value: unknown): SQL {
  if (value === null) {
    return isNull(column);
  }
  return eq(column, value);
}

/** Builds, reads and applies cursors for one table. */
export interface Keyset {
  /**
   * Extra fields to add to the SELECT, holding each sort column's value for the cursor.
   * They are read even when the caller asked for only some columns.
   */
  fields(keys: readonly SortKey[]): Record<string, PgColumn | SQL>;
  /** Builds the cursor for a row that was selected with `fields`. */
  encode(sort: readonly string[], keys: readonly SortKey[], row: Record<string, unknown>): string;
  /** Reads a cursor's values. Throws `BadRequestError` for a malformed cursor or one made for another sort. */
  decode(cursor: string, sort: readonly string[], keys: readonly SortKey[]): unknown[];
  /** The condition for the rows that come after the cursor's row in the sort order. */
  after(keys: readonly SortKey[], values: readonly unknown[]): SQL;
}

/** The name of the extra SELECT field that holds the cursor value of the sort column at `index`. */
function cursorFieldName(index: number): string {
  return `$cursor${index}`;
}

export function createKeyset(table: PgTable): Keyset {
  const valueSchemas: Shape = createSchemaFactory().createSelectSchema(table, refinements(table, cursorValueSchema)).shape;

  function valueSchemaFor(columnKey: string): z.ZodType {
    const schema = valueSchemas[columnKey];
    if (!schema) {
      throw new Error(`Column "${columnKey}" has no schema`);
    }
    return schema;
  }

  return {
    fields(keys) {
      const fields: Record<string, PgColumn | SQL> = {};
      for (const [index, { column }] of keys.entries()) {
        if (isDateObjectColumn(column)) {
          // `to_json` gives the date as ISO 8601 text with full precision.
          fields[cursorFieldName(index)] = sql`to_json(${column}) #>> '{}'`;
        } else {
          fields[cursorFieldName(index)] = column;
        }
      }
      return fields;
    },

    encode(sort, keys, row) {
      const values = keys.map(({ key }, index) => valueSchemaFor(key).encode(row[cursorFieldName(index)]));
      const contents: CursorContents = { sort: [...sort], values };
      return Buffer.from(JSON.stringify(contents), 'utf8').toString('base64url');
    },

    decode(cursor, sort, keys) {
      const contents = readCursorContents(cursor);
      if (!isSameSort(contents.sort, sort)) {
        throw new BadRequestError('The cursor was made for a different sort');
      }
      if (contents.values.length !== keys.length) {
        throw invalidCursor();
      }

      return keys.map(({ key }, index) => {
        const parsed = valueSchemaFor(key).safeDecode(contents.values[index]);
        if (!parsed.success) {
          throw invalidCursor(parsed.error);
        }
        return parsed.data;
      });
    },

    /*
     * A row comes after the cursor's row when, going through the sort columns in order, the first
     * column where they differ puts it later. So for each sort column we add one alternative:
     * "all earlier columns are equal, and this column comes after". The row matches if any
     * alternative matches. The primary key is the last sort column, so two rows can never be equal
     * on every column, and no row is repeated or skipped.
     */
    after(keys, values) {
      const alternatives: SQL[] = [];
      const earlierColumnsEqual: SQL[] = [];

      for (const [index, sortKey] of keys.entries()) {
        const value = values[index];

        const thisColumnComesAfter = comesAfter(sortKey, value);
        if (thisColumnComesAfter) {
          const alternative = and(...earlierColumnsEqual, thisColumnComesAfter);
          if (alternative) {
            alternatives.push(alternative);
          }
        }

        earlierColumnsEqual.push(hasSameValue(sortKey.column, value));
      }

      if (alternatives.length === 0) {
        // Every value is a NULL at the end of the order, so no row comes after.
        return sql`false`;
      }
      return or(...alternatives) ?? sql`false`;
    },
  };
}
