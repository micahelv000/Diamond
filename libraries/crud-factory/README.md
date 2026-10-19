# @diamond/crud-factory

Turn a Drizzle `pgTable` and one config object into three layers you would otherwise hand-write for
every entity:

1. a strictly typed **repository** (DAL),
2. a **service** that runs your hooks around every write,
3. a **Fastify plugin** with validated, permission-aware CRUD routes.

Each layer works on its own (a worker can use only the repository), and each can be extended
without touching the base CRUD methods.

## Quick start

```ts
import { createRepository, createService, defineEntity, requireAuth } from '@diamond/crud-factory';
import { crudRoutes } from '@diamond/crud-factory/fastify';
import { users } from './db/schema.ts';

// 1. Define: what is hidden, writable, which finders and URL filters to generate and what `?sort=` allows.
const userEntity = defineEntity(users, {
  primaryKey: 'id',
  hidden: ['passwordHash'],
  create: { omit: ['id', 'createdAt'] },
  update: { omit: ['email', 'createdAt'] },
  filterable: { status: ['eq', 'in'], name: ['ilike'] },
  sortable: ['createdAt', 'name'],
  defaultSort: '-createdAt',
});

// 2. Repository → 3. Service → 4. Routes. Clients can't write hidden columns, so a hook sets them
// (here an unusable hash until the user sets a password).
const userService = createService(createRepository(db, userEntity), {
  hooks: { beforeCreate: ({ input }) => ({ ...input, passwordHash: '!' }) },
});
app.register(
  crudRoutes({ service: userService, context: (req) => req.user ?? undefined, authorize: { '*': requireAuth } }),
  { prefix: '/users' },
);
```

That registers `GET /users`, `GET /users/:id`, `POST /users` (201), `PATCH /users/:id` and
`DELETE /users/:id` (204), all with Zod validation for params, querystring, body and response.
The plugin sets the Zod compilers and its error handler in its own scope, so the host app needs no
global setup. `examples/users.ts` is a runnable version (`npx tsx examples/users.ts`).

## Config reference

`defineEntity(table, config)`: every key is checked against the table at compile time and at load time.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `primaryKey` | column key | required | Used by `/:id` routes and `findById`/`update`/`delete`. |
| `hidden` | column keys | `[]` | Never selected, returned (nor requestable via `?fields=`), written from a request body, filtered or sorted on (in the types and at runtime). |
| `create.omit` | column keys | `[]` | Removed from the create body (e.g. `id`, `createdAt`). Hidden and `softDelete` columns are always removed. |
| `update.omit` | column keys | `[]` | Removed from the patch body. The primary key, hidden and `softDelete` columns are always removed. |
| `filterable` | `{ column: ('eq'\|'in'\|'ilike'\|'gte'\|'lte')[] }` | `{}` | Each declared operator is both a typed [finder method](#finder-methods) on the repository and service and a [list querystring filter](#url-filters) `?column__operator=`; also the keys allowed in a code-level `where` object. `ilike` needs a text column. |
| `sortable` | column keys | `[]` | Allowed `?sort=` keys on the list route. Code can sort by any visible column. |
| `defaultSort` | `'col'` or `'-col'` | primary key asc | The order when a query passes no `sort`. Any visible column. |
| `pagination` | `{ defaultLimit?, maxLimit? }` | `{ defaultLimit: 25, maxLimit: 100 }` | `defaultLimit` applies when no limit is given; `maxLimit` caps every list, from the URL or from code. Set either one to override just that default; lists are never unlimited. |
| `softDelete` | nullable timestamp column, or `false` | `'deletedAt'` | On by default: `delete` stamps the column instead of removing the row, and every read (get, list, finders) skips stamped rows. The column is never sent to or accepted from clients. A table without a `deletedAt` column must name another column or set `false` (a compile error and a startup error otherwise). `false` makes deletes real. |

`crudRoutes(options)`:

| Option | Meaning |
|---|---|
| `service` | The `createService` result. Its entity drives the routes and schemas. |
| `context?` | `(request) => TContext \| undefined` (may be async). Maps your auth (e.g. `request.user`) to what rules see. |
| `authorize?` | Rules per operation (`list`, `get`, `create`, `update`, `delete`) and `'*'`. Without it, routes are open; with it but no `context`, every request is anonymous (401). |
| `operations?` | `{ only?: Operation[] }` or `{ except?: Operation[] }` to register a subset. |
| `hooks?` | Any Fastify request hook (`onRequest`, `preValidation`, `preHandler`, `onSend`, `onResponse`, `onError`…), an async function or an array of them (no `done` callbacks). Added to the plugin scope, so they run on generated and `extend` routes (rate limits, metrics…). `preHandler` hooks run after `authorize`. |
| `extend?` | `(scope, { service, entity, serviceContext }) => void` to add custom routes in the same scope. Each needs `config.crudOperation` or `config.crudPublic: true`, or startup fails. See [Extension points](#extension-points). |
| `transaction?` | Default `true`: each request runs in one database transaction, rolled back if the handler throws. Handlers return their result; `reply.send()` throws. `false` lets each statement commit on its own. See [Transactions](#transactions). |

The prefix is the normal `register` option: `app.register(crudRoutes({...}), { prefix: '/users' })`.
No type arguments are needed: how `crudRoutes` infers them from the options is explained in
[docs/type-inference.md](docs/type-inference.md).

### Calling the routes with types

The plugin also has `create`, `update`, `get`, `list` and `delete` methods that send requests to its
generated routes, with the body and query types taken from the entity. Useful in tests, scripts and examples:

```ts
const userRoutes = crudRoutes({ service: userService, context, authorize: { '*': requireAuth } });
await app.register(userRoutes, { prefix: '/users' });

const headers = { authorization: 'Bearer …' };
const created = await userRoutes.create({ email: 'ann@x.io', name: 'Ann' }, { headers }); // POST /users
await userRoutes.update(1, { name: 'Anne' }, { headers });                              // PATCH /users/1
await userRoutes.get(1, { fields: ['id', 'name'] }, { headers });                       // GET /users/1?fields=id,name
await userRoutes.list({ status__in: ['active'], sort: ['-createdAt'], limit: 10 }, { headers });
await userRoutes.delete(1, { headers });                                                // DELETE /users/1
created.statusCode; // Fastify's normal inject response: statusCode, json(), body
```

- A missing required field, an unknown field, an omitted or hidden field, an undeclared filter or an
  unsortable `sort` key is a compile error.
- The list query is sent as a querystring: arrays as comma lists, dates as ISO strings.
- Calling before the plugin is registered throws. If the same plugin is registered twice, the requests
  go to the last registration. Only the generated routes are covered, not `extend` routes; a route turned
  off with `operations` answers 404.

## Field selection

`?fields=id,name` returns only those columns (`SELECT id, name`, not `SELECT *`) on list and get.
Hidden columns can't be requested (400). In code, `columns` narrows the return type too:

```ts
const { items } = await userRepo.findMany({ columns: ['id', 'email'] }); // { id: number; email: string }[]
```

Tip: name the entity's types instead of repeating them: `type User = Row<typeof userEntity>`
(also `CreateInput`, `UpdateInput`, `Filter`). Hovers show the resulting fields.

## Finder methods

Each operator in `filterable` generates one typed method on the repository and on the service. The
service ones take a `context` after the value(s) and run through the service's `findMany`, so they get
the caller's scope, soft delete and the request transaction.

| Config | Repository | Service |
|---|---|---|
| `status: ['eq']` | `findByStatus(value, options?)` | `findByStatus(value, context, options?)` |
| `status: ['in']` | `findByStatusIn(values, options?)` | `findByStatusIn(values, context, options?)` |
| `name: ['ilike']` | `findByNameContaining(text, options?)`: case-insensitive, `%` and `_` literal | same, plus `context` |
| `createdAt: ['gte']` | `findByCreatedAtFrom(date, options?)` | same, plus `context` |
| `createdAt: ['lte']` | `findByCreatedAtUntil(date, options?)` | same, plus `context` |
| both `gte` and `lte` | also `findByCreatedAtBetween(from, to, options?)`, both ends included | same, plus `context` |

The primary key gets no `eq` finder: that is `findById`. Values are typed from the column (enum
values, `Date` for timestamps, an array for `In`). A finder returns the same page as `findMany`, and
`options` takes everything `findMany` does: `columns` (narrows the return type), `sort`, `limit`,
`offset`, `withTotal`, and an extra `where` (filter object or `SQL`) that is ANDed with the finder's
condition. Generated names count as built-ins, so reusing one in `.extend()` is a compile error.

```ts
const { items } = await flightService.findByStatusIn(['boarding', 'departed'], context, { columns: ['id', 'flightNumber'] });
await flightRepo.findByScheduledDepartureBetween(from, to, { sort: ['flightNumber'], limit: 20 });
```

How TypeScript builds these method names and types from the config is explained step by step in
[docs/finder-types.md](docs/finder-types.md).

### Dates and times from clients

JSON has no date type, so request bodies and URL filters take every date and time as an ISO 8601 string,
checked with Zod's built-in validators. Anything else, including an impossible date like Feb 30, is a 400.

| Column | Format | Example |
|---|---|---|
| `timestamp` (with or without time zone) | date-time with a timezone | `2026-03-01T10:00:00Z`, `2026-03-01T10:00:00+02:00` |
| `date` | date | `2026-03-01` |
| `time` | time | `10:00:00` |
| `interval` | ISO duration | `PT1H30M` |

Columns that drizzle reads as a `Date` get one; string-mode columns keep the string. The offset is never lost:
a `timestamp without time zone` can't store one, so the moment is converted to UTC first (`10:00+02:00` is stored
as `08:00`). Server code that calls the
service or repository directly passes `Date` objects as usual.

### URL filters

The same operators are list querystring filters as `?column__operator=`, ANDed together:

| Query | Value |
|---|---|
| `?status__eq=active` | the column's type: numbers, `true`/`false`, enum values, uuids, and dates in the same strict ISO format as request bodies |
| `?status__in=active,banned` | a comma-separated list, or a repeated param, of that type |
| `?name__ilike=al` | text to search for, case-insensitive, up to 100 characters |
| `?createdAt__gte=2026-01-01T00:00:00Z` | the column's type, inclusive (`lte` likewise) |

A blank value (`?status__eq=`) is ignored. An invalid value, or a column/operator pair not declared
in `filterable`, is a 400. For a query that needs its own parameters, add a route over a finder in
`extend`:

```ts
extend: (scope, { service, entity, serviceContext }) => {
  scope.get('/departing', {
    config: { crudOperation: 'list' },
    schema: { querystring: z.object({ from: z.coerce.date(), to: z.coerce.date() }), response: { 200: entity.schemas.listResult } },
  }, (request) => service.findByScheduledDepartureBetween(request.query.from, request.query.to, serviceContext(request)));
},
```

In code, `findMany`'s `where` takes the same `field__op` keys or a raw drizzle `SQL` chunk:
`findMany({ where: and(eq(users.orgId, 1), ilike(users.name, 'a%')) })`.

## Sorting and pagination

Every list query (`findMany`, the finders, and custom queries that use `orderBy`) sorts by the
caller's `sort`, else `defaultSort`, else the primary key, and always adds the primary key last as a
tie-breaker so pages are stable. In code, `sort` takes any visible column, with `-` for descending
(`sort: ['status', '-createdAt']`); hidden columns are a compile error and a 400. Choose the order in
the service method for each use case; `defaultSort` is only the fallback:

```ts
departuresBoard: (originCode: string, context: ServiceContext<Caller>) =>
  base.findByOriginCode(originCode, context, { sort: ['status', 'scheduledDeparture'] }),
```

The list route's querystring:

| Query | Meaning |
|---|---|
| `?sort=-createdAt,name` | `-` for descending; only `sortable` keys |
| `?limit=20&offset=40` | offset pagination; without `?limit=` the page holds `defaultLimit` rows (25 by default), and any limit is capped at `maxLimit` (100 by default) |
| `?cursor=…` | [cursor pagination](#cursor-pagination): the page after the one that returned this `nextCursor` |
| `?fields=id,name` | only these columns |
| `?total=true` | also return `total` (one extra `count(*)`, run in parallel with the page) |
| `?status__in=active,banned` | [filters](#url-filters) declared in `filterable` |

Unknown query keys, including undeclared filters, are a 400, not silently ignored. The list response
is `{ items, limit, offset, nextCursor, total? }`, where `limit` is the page size actually used.

### Cursor pagination

Every list result, from `findMany`, the finders, the service and the list route, has a `nextCursor`:
an opaque string, or `null` on the last page. Pass it back to get the next page, keeping the same
`sort`, filters and scope:

```ts
const first = await userRepo.findMany({ sort: ['-createdAt'], limit: 20 });
const second = await userRepo.findMany({ sort: ['-createdAt'], limit: 20, cursor: first.nextCursor ?? undefined });
```

Over HTTP: `GET /users?sort=-createdAt&limit=20`, then `GET /users?sort=-createdAt&limit=20&cursor=<nextCursor>`.

- The next page is a `where` on the sort columns that starts right after the previous page's last row,
  so with a matching index it costs the same at any depth, and rows inserted or deleted meanwhile don't shift it. Offset paging
  costs O(offset) and can repeat or skip rows when data changes, but it can jump to any page.
- A cursor works with any sort, including mixed directions and nullable columns, and with `?fields=`.
- A malformed cursor, one made for another `sort`, or a cursor with a non-zero `offset` is a 400.
- Offset pages return a `nextCursor` too, so a client can switch to cursors at any point.
- `total` (`withTotal`) still counts every match, ignoring the cursor.

### Indexes

The library adds no indexes; give each list query one that matches it:

```ts
export const users = pgTable('users', { /* … */ }, (t) => [
  // defaultSort '-createdAt' (the primary key is the tie-breaker), tenant column first,
  // partial when soft delete is on: (org_id, created_at desc, id) where deleted_at is null
  index('users_org_created_idx').on(t.orgId, t.createdAt.desc(), t.id).where(sql`deleted_at is null`),
  // ilike needs pg_trgm (`create extension pg_trgm`) and a GIN index
  index('users_name_trgm_idx').using('gin', t.name.op('gin_trgm_ops')),
]);
```

- `eq`/`in`/`gte`/`lte` use btree indexes; in a composite one, put equality columns before the range column.
- `?total=true` (or `withTotal`) is a `count(*)` over every match: use it sparingly on large tables. `withTotal`
  runs the page and the count in parallel, so it may hold 2 pool connections.
- `offset` costs O(offset). For deep paging, use [cursors](#cursor-pagination).

## Permissions

The library never parses tokens. Your auth plugin (e.g. `@fastify/jwt`) sets `request.user`, and
you tell `crudRoutes` how to turn a request into a context:

```ts
crudRoutes({
  service: postService,
  context: (req) => req.user ?? undefined,          // TContext is inferred from this
  authorize: {
    '*': ({ context }) => (context ? eq(posts.orgId, context.orgId) : false), // no context → 401; SQL → row-level scope
    delete: requireRole('admin'),                    // also needs admin; false → 403
  },
});
```

`'*'` always applies; an operation rule adds to it. Both must pass, and their SQL scopes are ANDed,
so above, an admin of another org deleting a post gets a 404.

A rule gets `{ context, op, id?, input? }` and returns:

| Result | Effect |
|---|---|
| `true` | allowed |
| `false` | 401 if there is no context, otherwise 403 |
| `SQL` | allowed, but every statement is ANDed with it, including update/delete by id, so another tenant's row is a 404 |

A scope filters list, get, update and delete only: an insert has no rows to filter, so a `'*'` scope
doesn't apply to create, and a `create` rule must return a boolean (it can inspect `input`). Keep a
tenant column out of the body and stamp it from the caller:

```ts
const postEntity = defineEntity(posts, {
  primaryKey: 'id',
  create: { omit: ['id', 'orgId'] },               // clients can't pick the tenant…
  update: { omit: ['orgId'] },                     // …or move a row to another one
});
const postService = createService<typeof postEntity, Caller>(createRepository(db, postEntity), {
  hooks: {
    beforeCreate: ({ input, context }) => {
      if (!context.auth) throw new UnauthorizedError();
      return { ...input, orgId: context.auth.orgId };
    },
  },
});
```

`input` is the validated body (omitted, hidden and soft-delete columns already stripped), as the
client sent it: rules run before service hooks.

Helpers: `requireAuth` (any context) and `requireRole(...roles)` (needs `roles: string[]` on the
context). Rules run in a `preHandler`, after validation and before the handler. The result is
stored on `request.crudContext` (`{ auth, scope }`).

## Extension points

| Layer | How | Use it for |
|---|---|---|
| Repository | `createRepository(db, entity).extend(({ scoped, table, project, orderBy }) => ({ … }))` | joins, window functions, reports. Base methods, finders included, can't be overridden (compile error). |
| Service | `createService(repo, { hooks: { beforeCreate, afterCreate, … } })` | stamping `createdBy`/`orgId` from `context.auth`, hashing, normalising input, blocking a delete, follow-up writes. See [Service hooks](#service-hooks). |
| Service | `createService(repo).extend((base) => ({ … }))` | business operations built from the CRUD methods (`delayFlight`, a two-leg booking). Built-in names can't be reused (compile error). |
| Routes | `crudRoutes({ …, extend: (scope, { service, entity, serviceContext }) => { … } })` | custom endpoints that share the validation, error handler and authorization. |

A custom query takes the caller's `QueryOptions` and reaches the database only through
`scoped(options)`, which returns:

- `db`: the database to build the query on. It is the caller's `tx` when given, so the query joins
  the request's [transaction](#transactions).
- `where(condition?)`: the full WHERE: soft delete and the caller's permission scope, ANDed with your
  condition.
- `run(query)`: runs the query and maps database errors, like the built-in methods.

Order a list with `orderBy(sort)`: the caller's sort, else `defaultSort`, ending with the primary key,
like `findMany`:

```ts
const userRepo = createRepository(db, userEntity).extend(({ scoped, table, project, orderBy }) => ({
  withPostCounts: (options: QueryOptions = {}) => {
    const query = scoped(options);
    return query.run(
      query.db
        .select({ ...project(['id', 'name']), postCount: count(posts.id) })
        .from(table)
        .leftJoin(posts, eq(posts.authorId, table.id))
        .where(query.where())
        .groupBy(table.id),
    );
  },
  findActive: async ({ sort, ...options }: QueryOptions & { sort?: readonly SortSpec<typeof userEntity>[] } = {}) => {
    const query = scoped(options);
    return query.run(query.db.select(project()).from(table).where(query.where(eq(table.status, 'active'))).orderBy(...orderBy(sort)));
  },
}));
```

A query that must deliberately see past the caller's scope, like a check for clashes with rows the
caller can't see, passes `scoped({ ...options, scope: undefined })`. Soft delete still applies. Code
outside `extend` can still use the public `repository.db`.

- **Error mapping is automatic.** When a method you add returns a promise (any `async` method, or one
  that returns `query.run(…)`) and it rejects, the error goes through the same mapping as the base methods.
  A unique violation becomes a `ConflictError` (409), a missing foreign key a `BadRequestError` (400),
  not a 500. A method that returns a query builder without running it is passed through unchanged.

For `updatedAt`, use drizzle's `$onUpdate(() => new Date())` on the column: the repository's
`update` then sets it.

Both `.extend()`s return a new object and leave the original unchanged. Chained calls keep every
earlier method in the type: after `.extend(a).extend(b)` both `a`'s and `b`'s methods are typed, and
inside `b`'s factory the first argument already has `a`'s.

### Service hooks

Hooks run on every create, update and delete made through the service: the built-in methods, and custom
service methods that call `base.create`, `base.update` or `base.delete`. Finders and calls on
`service.repository` skip them. Each hook gets the caller's `context` and may be async.

| Hook | Runs | Receives | Returns |
|---|---|---|---|
| `beforeCreate` | before the insert | `{ input, context }` | the full row to insert |
| `afterCreate` | after the insert | `{ row, input, context }`: the saved row and the client's input | nothing (ignored) |
| `beforeUpdate` | before the update | `{ id, patch, context }` | the changes to save |
| `afterUpdate` | after the update | `{ id, row, patch, context }`: the saved row and the client's changes | nothing (ignored) |
| `beforeDelete` | before the delete | `{ id, context }`; read the row yourself if you need it | nothing; throw to block |
| `afterDelete` | after the delete, soft or hard | `{ id, row, context }`: the deleted row | nothing (ignored) |

Throw from any hook to fail the call. Inside a
[transaction](#transactions) (every route, by default) a throwing hook rolls back the write as well.
Work done outside the database, such as sending emails or events, can't be rolled back.

### Service methods

`service.extend((base) => ({ … }))` adds your own operations to the service. `base` is the service so
far (the five CRUD methods, the finders, `entity`, `repository` and earlier extensions). The methods are plain
functions: nothing is wrapped for you. Take a `context` and pass it to the `base` built-ins, and hooks,
the caller's scope and the request's transaction all apply:

```ts
const flightService = createService<typeof flightEntity, Caller, typeof flightRepo>(flightRepo, { hooks }).extend((base) => ({
  delayFlight: async (id: number, minutes: number, context: ServiceContext<Caller>) => {
    const flight = await base.findById(id, { columns: ['scheduledDeparture', 'scheduledArrival'] }, context);
    if (!flight) throw new NotFoundError('flights not found');
    const shift = (date: Date) => new Date(date.getTime() + minutes * 60_000);
    return base.update(id, { scheduledDeparture: shift(flight.scheduledDeparture), scheduledArrival: shift(flight.scheduledArrival) }, context);
  },
}));
// in crudRoutes({ service: flightService, …, extend: (scope, { service, serviceContext }) => { … } })
scope.post('/:id/delay', { config: { crudOperation: 'update' }, … }, (request) =>
  service.delayFlight(request.params.id, request.body.minutes, serviceContext(request)));
```

A plain function that takes the service and a `context` works just as well, e.g.
`delayFlight(flightService, id, 30, context)`. Use `.extend()` when you want the operation to travel with
the service, so `crudRoutes`' `extend` and other callers reach it as `service.delayFlight`.

The service keeps the repository's full type as `service.repository`, so custom routes reach your
`extend` methods through the `service` that `extend` receives; there is no separate `repository`
option. Calls on `service.repository` skip the service's hooks. If
you pass `createService`'s type arguments yourself (e.g. to type `context.auth`), add the repository's type
third, or `service.repository` only knows the base methods:

```ts
const flightService = createService<typeof flightEntity, Caller, typeof flightRepo>(flightRepo, { hooks });
// in crudRoutes({ service: flightService, …, extend: (scope, { service, serviceContext }) => { … } })
scope.get('/delayed', { config: { crudOperation: 'list' } }, (request) =>
  service.repository.findDelayed(15, serviceContext(request)));
```

Every custom route must say how it is authorized. `config: { crudOperation }` names the operation it
acts as, and that operation's `authorize` rule runs before the handler. `config: { crudPublic: true }`
marks a route as intentionally public: no rule runs, and `serviceContext(request)` has no `auth` and no
`scope` but still carries the transaction. A route with neither, or with both, fails at
startup (`app.ready()` rejects) with a message naming the route, so a forgotten tag can't leave a
route that reads `service.repository` or the database unauthenticated. The check covers every route in
the plugin's scope, including routes added by plugins you register inside `extend`. A write route
should also validate its own payload with a `body` schema: rules see the body before service hooks run.

```ts
extend: (scope, { service, entity, serviceContext }) => {
  scope.post(
    '/:id/activate',
    { config: { crudOperation: 'update' }, schema: { params: entity.schemas.params, response: { 200: entity.schemas.read } } },
    (request) => service.update(request.params.id, { status: 'active' }, serviceContext(request)),
  );
  scope.get('/health', { config: { crudPublic: true } }, () => ({ ok: true }));
},
```

## Transactions

`crudRoutes` runs every request in one database transaction, on all its routes: the five generated
ones and every `extend` route. If the handler throws, everything the request wrote is rolled back and
the error response is sent as usual; if it succeeds, the transaction commits. This is what makes a
custom route with several writes all-or-nothing.

`serviceContext(request)` carries the transaction (`context.tx`), so pass it to every call in the route:
other entities' services, `service.repository` methods, and your own helpers. Service hooks get the
same `context`, so a write in `beforeCreate` joins it too, and a throwing `afterCreate` rolls back the insert. Custom repository methods join it too when
they take the `context` and build on `scoped(context)` (see [Extension points](#extension-points)).

```ts
scope.post('/rotation', { config: { crudOperation: 'create' }, schema: { body } }, async (request, reply) => {
  const context = serviceContext(request);
  const outbound = await service.create(request.body.outbound, context);
  const inbound = await service.create(request.body.inbound, context); // throws 409 → outbound is rolled back too
  reply.status(201);
  return [outbound, inbound];
});
```

- `authorize` and your hooks up to `preHandler` run before the transaction opens, so a 401 or 403 never
  starts one. Hooks from `preSerialization` on run after it has committed or rolled back.
- Return the result; set the status and headers with `reply.status()` and `reply.header()`. Calling
  `reply.send()` inside the handler throws, so the request fails with a 500 and rolls back: a response
  sent before the commit would report success even if the commit then failed.
- GET routes run in a transaction too; for reads it is cheap (a `BEGIN` and a `COMMIT`).
- The transaction holds one pooled connection for the whole handler, so keep slow work (HTTP calls to
  other services) out of handlers. A query on the root `db` inside a handler runs outside the
  transaction; with a single-connection driver such as PGlite it waits for it forever.
- To open your own nested scope, call `context.tx.transaction(…)`: drizzle makes it a savepoint.
- Let database errors propagate. A failed statement aborts the transaction, so a handler that catches one
  and still returns gets a success response for writes Postgres rolled back. To recover from a failure,
  run that statement in a savepoint (`context.tx.transaction(…)`).

Turn it off with `crudRoutes({ service, transaction: false })`: each statement then commits on its own,
as before, and `reply.send()` is allowed.

## Errors

Every error the plugin raises, and every unknown path under its prefix (404), is
`{ code, message, data? }`. Match on `code`, never on `message`. Fastify's own 4xx errors (e.g.
malformed JSON) use the same shape but keep Fastify's code, such as `FST_ERR_CTP_INVALID_JSON_BODY`.

| Status | `code` | When |
|---|---|---|
| 400 | `BAD_REQUEST` | Validation failed (`data.issues: [{ path, message }]`), or a FK/check/format/range violation |
| 401 | `UNAUTHORIZED` | A rule returned `false` and there is no context |
| 403 | `FORBIDDEN` | A rule returned `false` for a known caller |
| 404 | `NOT_FOUND` | No row for the id (or it is outside the caller's scope) |
| 409 | `CONFLICT` | Unique violation, or a hard delete of a row that is still referenced (`data.constraint` names the constraint), or a `ConflictError` your code threw (no `data`) |
| 500 | `INTERNAL_SERVER_ERROR` | Anything else. Details are never sent; add an `onError` hook to log them (see [Logging](#logging)). |

The same error classes (`NotFoundError`, `ConflictError`, …) are thrown by the repository and
service, so non-HTTP callers get the same codes. Throw them from hooks and custom routes too; each
takes the client-facing message first:

```ts
throw new ConflictError(`Aircraft is already flying ${clash.flightNumber} then`);
// → 409 { "code": "CONFLICT", "message": "Aircraft is already flying LY315 then" }
```

**Breaking change:** `ConflictError` is now `new ConflictError(message?, { constraint?, cause? })`,
with `message` defaulting to `'Resource already exists'`. It used to be
`new ConflictError(constraint, { message?, cause? })`; replace
`new ConflictError(undefined, { message: 'x' })` with `new ConflictError('x')`, and
`new ConflictError(name, { cause })` with `new ConflictError(undefined, { constraint: name, cause })`.

## Why Zod and not TypeBox

- **One schema, three jobs.** The same Zod schema validates the request, serializes the response
  (stripping anything not in it, such as hidden columns, a second time), and gives the TypeScript type.
- **Derived from the table.** `drizzle-orm/zod` builds the schemas from the `pgTable`, so the API
  can't drift from the database, and the same schemas work outside HTTP (queues, scripts).
- **Scoped.** The Zod compilers are set inside the plugin's encapsulated scope, so an app that uses
  TypeBox or plain JSON Schema elsewhere is unaffected.

## Logging

The library never logs, at any layer. Fastify still writes its own `incoming request` and `request completed`
lines. Add any logging yourself, where you want it:

- **Errors:** an `onError` hook in `hooks` gets every error a route throws, 500s included:
  `hooks: { onError: async (request, _reply, error) => request.log.error({ err: error }, 'route failed') }`.
- **In the service:** pass `request.log` from the route explicitly. For hooks, put it on what `context`
  returns, and read it as `context.auth.log`. For your own service methods, pass it as an argument:

```ts
crudRoutes({
  service: flightService,
  context: (request) => request.user && { ...request.user, log: request.log },
  extend: (scope, { service, serviceContext }) => {
    scope.post('/:id/delay', { config: { crudOperation: 'update' } }, (request) =>
      service.delayFlight(request.params.id, 30, serviceContext(request), request.log));
  },
});
// in createService(…, { hooks: { afterCreate: ({ row, context }) => context.auth?.log.info({ id: row.id }, 'flight scheduled') } })
```

`examples/flights.ts` does both.
