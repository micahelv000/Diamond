/*
 * Column-kind checks, read from drizzle's column data type (such as "object date" or "bigint int64").
 * JSON has no Date or bigint, so the schemas and the cursor both treat these columns specially.
 */
import { extractExtendedColumnType, type Column } from 'drizzle-orm';

/** A date or timestamp column that drizzle reads as a JavaScript `Date`. */
export function isDateObjectColumn(column: Column): boolean {
  const { type, constraint } = extractExtendedColumnType(column);
  return type === 'object' && constraint === 'date';
}

/** A timestamp column that drizzle reads as a JavaScript `Date`. */
export function isTimestampColumn(column: Column): boolean {
  return isDateObjectColumn(column) && column.getSQLType() !== 'date';
}

/** A `date` column (no time of day) that drizzle reads as a JavaScript `Date`. */
export function isDateOnlyColumn(column: Column): boolean {
  return isDateObjectColumn(column) && column.getSQLType() === 'date';
}

/** A `date` column in drizzle's string mode, read as `YYYY-MM-DD` text. */
export function isStringDateColumn(column: Column): boolean {
  const { type, constraint } = extractExtendedColumnType(column);
  return type === 'string' && constraint === 'date';
}

/** A column that drizzle reads as a JavaScript `bigint`. In Postgres that is always a 64-bit integer. */
export function isBigintColumn(column: Column): boolean {
  return extractExtendedColumnType(column).type === 'bigint';
}

/** A `real` or `double precision` column. */
export function isFloatColumn(column: Column): boolean {
  const { constraint } = extractExtendedColumnType(column);
  return constraint === 'float' || constraint === 'double';
}

export function isBooleanColumn(column: Column): boolean {
  return extractExtendedColumnType(column).type === 'boolean';
}
