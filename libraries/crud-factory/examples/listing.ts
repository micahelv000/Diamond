// Run with: npx tsx examples/listing.ts
// The list route (`GET /`): URL filters, sorting, offset paging and cursor paging.
import { PGlite } from '@electric-sql/pglite';
import { boolean, integer, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import Fastify from 'fastify';
import { createRepository, createService, defineEntity } from '@diamond/crud-factory';
import { crudRoutes } from '@diamond/crud-factory/fastify';

// 1. A products table with a few rows that share a price, so sorting and paging have ties to handle.
const category = pgEnum('category', ['book', 'game', 'toy']);
const products = pgTable('products', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: text().notNull(),
  category: category().notNull(),
  price: integer().notNull(),
  inStock: boolean('in_stock').notNull(),
  releasedAt: timestamp('released_at', { withTimezone: true }).notNull(),
});

const client = new PGlite();
await client.exec(`
  create type category as enum ('book', 'game', 'toy');
  create table products (
    id integer primary key generated always as identity, name text not null, category category not null,
    price integer not null, in_stock boolean not null, released_at timestamptz not null
  );
  insert into products (name, category, price, in_stock, released_at) values
    ('Atlas', 'book', 30, true, '2026-01-10T00:00:00Z'),
    ('Blocks', 'toy', 15, true, '2026-02-01T00:00:00Z'),
    ('Chess', 'game', 25, false, '2026-02-15T00:00:00Z'),
    ('Dune', 'book', 20, true, '2026-03-01T00:00:00Z'),
    ('Express', 'game', 40, true, '2026-03-20T00:00:00Z'),
    ('Frisbee', 'toy', 15, false, '2026-04-05T00:00:00Z'),
    ('Go', 'game', 25, true, '2026-04-18T00:00:00Z'),
    ('Hamlet', 'book', 10, true, '2026-05-02T00:00:00Z'),
    ('Kite', 'toy', 15, true, '2026-05-30T00:00:00Z'),
    ('Ludo', 'game', 25, true, '2026-06-12T00:00:00Z'),
    ('Moby Dick', 'book', 20, false, '2026-07-01T00:00:00Z'),
    ('Nerf', 'toy', 35, true, '2026-07-21T00:00:00Z');
`);
const db = drizzle({ client });

// 2. What the list route accepts. Every operator in `filterable` becomes a `column__operator` query
// parameter, and only `sortable` columns can be used in `?sort=`. Small page sizes make paging visible.
const productEntity = defineEntity(products, {
  primaryKey: 'id',
  create: { omit: ['id'] },
  filterable: {
    category: ['eq', 'in'],
    name: ['ilike'],
    price: ['gte', 'lte'],
    inStock: ['eq'],
    releasedAt: ['gte', 'lte'],
  },
  sortable: ['name', 'price', 'releasedAt'],
  defaultSort: 'name',
  pagination: { defaultLimit: 4, maxLimit: 5 },
});

// 3. The app. No `authorize`, so the routes are open; this example is only about listing.
const app = Fastify();
await app.register(crudRoutes({ service: createService(createRepository(db, productEntity)) }), { prefix: '/products' });

// 4. Helpers that print one readable line per request.
interface ProductRow {
  name?: string;
  price?: number;
}
interface ListBody {
  items?: ProductRow[];
  limit?: number;
  offset?: number;
  total?: number;
  nextCursor?: string | null;
  code?: string;
  message?: string;
}

function describe(row: ProductRow): string {
  if (row.price === undefined) {
    return String(row.name);
  }
  return `${row.name} (${row.price})`;
}

function summarize(body: ListBody): string {
  if (!body.items) {
    return `${body.code}: ${body.message}`;
  }
  const names = body.items.map(describe).join(', ');
  const cursor = body.nextCursor ? `${body.nextCursor.slice(0, 10)}…` : 'null';
  const total = body.total === undefined ? '' : ` total=${body.total}`;
  return `[${names}] limit=${body.limit} offset=${body.offset}${total} nextCursor=${cursor}`;
}

async function list(query: string): Promise<ListBody> {
  const url = query ? `/products?${query}` : '/products';
  const response = await app.inject({ method: 'GET', url });
  const body: ListBody = response.json();
  console.log(`GET ${url} → ${response.statusCode}  ${summarize(body)}`);
  return body;
}

function section(title: string): void {
  console.log(`\n=== ${title}`);
}

// 5. URL filters.
section('URL filters');
await list('category__eq=book');
await list('category__in=game,toy');
await list('category__in=game&category__in=toy'); // a repeated parameter works like a comma list
await list('name__ilike=o');
await list('price__gte=20&price__lte=30');
await list('inStock__eq=false');
await list('releasedAt__gte=2026-03-01T00:00:00Z&releasedAt__lte=2026-05-31T23:59:59Z');
await list('category__eq=game&inStock__eq=true&price__lte=25'); // filters combine with AND
await list('category__eq='); // a blank value means "no filter"

section('Rejected filters (400)');
await list('color__eq=red'); // not a column in `filterable`
await list('price__eq=25'); // `price` doesn't allow `eq`
await list('category__eq=car'); // not a valid enum value
await list('releasedAt__gte=2026-02-30T00:00:00Z'); // not a real date
await list('price__gte=cheap'); // not a number

// 6. Sorting. `-` means descending; ties are broken by the primary key, so the order is always stable.
section('Sorting');
await list('sort=-price');
await list('sort=price,name');
await list('sort=category'); // 400: `category` isn't in `sortable`

// 7. Offset paging: `limit` rows after skipping `offset` rows.
section('Offset paging');
await list(''); // the default page size is 4
await list('limit=2&offset=2');
await list('limit=50'); // capped at maxLimit (5)
await list('limit=3&total=true'); // `total` counts every matching row, not just this page

// 8. Cursor paging: follow `nextCursor` until it is null. Each page starts right after the previous
// one, so rows are never repeated or skipped, even with ties or new rows added between requests.
section('Cursor paging: every page, sorted by price');
let query = 'sort=price&limit=4&fields=name,price';
let page = await list(query);
while (page.nextCursor) {
  page = await list(`${query}&cursor=${page.nextCursor}`);
}

section('Cursor paging with filters');
query = 'category__in=game,toy&sort=-price&limit=3&fields=name,price';
page = await list(query);
while (page.nextCursor) {
  page = await list(`${query}&cursor=${page.nextCursor}`);
}

section('Rejected cursors (400)');
const first = await list('sort=price&limit=2');
await list(`sort=-price&limit=2&cursor=${first.nextCursor}`); // made for a different sort
await list(`sort=price&limit=2&offset=2&cursor=${first.nextCursor}`); // cursor and offset together
await list('sort=price&limit=2&cursor=not-a-real-cursor');

await app.close();
await client.close();
