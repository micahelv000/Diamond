// Run with: npx tsx examples/flights.ts
// Flight scheduling on an in-memory Postgres: generated CRUD, custom queries and business rules in hooks.
import { PGlite } from '@electric-sql/pglite';
import { and, count, eq, gt, gte, lt, ne, sql } from 'drizzle-orm';
import { alias, index, integer, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import Fastify, { type FastifyBaseLogger, type LightMyRequestResponse } from 'fastify';
import pretty from 'pino-pretty';
import { z } from 'zod';
import {
  BadRequestError, ConflictError, createRepository, createService, defineEntity, NotFoundError,
  requireAuth, requireRole, type CreateInput, type QueryOptions, type Row, type ServiceContext, type SortSpec,
} from '@diamond/crud-factory';
import { crudRoutes } from '@diamond/crud-factory/fastify';

// 1. Tables
// Column names are explicit so the raw SQL below can match them.
const flightStatus = pgEnum('flight_status', ['scheduled', 'boarding', 'departed', 'landed', 'cancelled']);
const airports = pgTable('airports', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  city: text('city').notNull(),
});
const aircraft = pgTable('aircraft', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  model: text('model').notNull(),
  seats: integer('seats').notNull(),
});
const flights = pgTable('flights', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  flightNumber: text('flight_number').notNull().unique(),
  originCode: text('origin_code').notNull().references(() => airports.code),
  destinationCode: text('destination_code').notNull().references(() => airports.code),
  aircraftId: integer('aircraft_id').notNull().references(() => aircraft.id),
  scheduledDeparture: timestamp('scheduled_departure', { withTimezone: true }).notNull(),
  scheduledArrival: timestamp('scheduled_arrival', { withTimezone: true }).notNull(),
  actualDeparture: timestamp('actual_departure', { withTimezone: true }),
  actualArrival: timestamp('actual_arrival', { withTimezone: true }),
  status: flightStatus('status').notNull().default('scheduled'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => [
  // Serves the default sort and departure filters; partial because reads skip deleted rows.
  index('flights_departure_idx').on(t.scheduledDeparture).where(sql`deleted_at is null`),
  // Serves the double-booking check.
  index('flights_aircraft_departure_idx').on(t.aircraftId, t.scheduledDeparture),
]);

const client = new PGlite();
await client.exec(`
  create type flight_status as enum ('scheduled', 'boarding', 'departed', 'landed', 'cancelled');
  create table airports (code text primary key, name text not null, city text not null);
  create table aircraft (id integer primary key generated always as identity, model text not null, seats integer not null);
  create table flights (
    id integer primary key generated always as identity, flight_number text not null unique,
    origin_code text not null references airports(code), destination_code text not null references airports(code),
    aircraft_id integer not null references aircraft(id),
    scheduled_departure timestamptz not null, scheduled_arrival timestamptz not null,
    actual_departure timestamptz, actual_arrival timestamptz,
    status flight_status not null default 'scheduled', created_at timestamptz not null default now(), deleted_at timestamptz);
  create index flights_departure_idx on flights (scheduled_departure) where deleted_at is null;
  create index flights_aircraft_departure_idx on flights (aircraft_id, scheduled_departure);
`);
const db = drizzle({ client });
// Reference data needs no API, so it is seeded directly and has no entity.
await db.insert(airports).values([{ code: 'TLV', name: 'Ben Gurion', city: 'Tel Aviv' }, { code: 'LHR', name: 'Heathrow', city: 'London' },
  { code: 'JFK', name: 'John F. Kennedy', city: 'New York' }, { code: 'CDG', name: 'Charles de Gaulle', city: 'Paris' }]);
await db.insert(aircraft).values([{ model: 'Boeing 787', seats: 282 }, { model: 'Boeing 737', seats: 160 }, { model: 'Airbus A320', seats: 174 }]);

// 2. Entity
const flightEntity = defineEntity(flights, {
  primaryKey: 'id',
  // The server sets these on create.
  create: { omit: ['id', 'createdAt', 'actualDeparture', 'actualArrival', 'status'] },
  // `omit` is per operation, so `createdAt` is listed again.
  update: { omit: ['flightNumber', 'createdAt'] },
  // Each operator generates a typed finder and a `?column__operator=` list filter; `gte` plus `lte` also gets a `Between` finder.
  filterable: {
    scheduledDeparture: ['gte', 'lte'], status: ['eq', 'in'],
    originCode: ['eq'], destinationCode: ['eq'], aircraftId: ['eq'],
  },
  // Columns clients may use in `?sort=`; code can sort by any visible column.
  sortable: ['scheduledDeparture', 'flightNumber'],
  defaultSort: 'scheduledDeparture',
  softDelete: 'deletedAt',
});
type Flight = Row<typeof flightEntity>;
type FlightSort = readonly SortSpec<typeof flightEntity>[];

// 3. Custom queries
// `scoped(options)` gives the database for this call: `db` joins the caller's transaction, `where`
// adds soft delete and the caller's scope, and `run` maps database errors.
// `orderBy(sort)` uses the given sort or `defaultSort`.
const origin = alias(airports, 'origin');
const destination = alias(airports, 'destination');
const flightRepo = createRepository(db, flightEntity).extend(({ scoped, table, project, orderBy }) => ({
  findDetails: async (id: number, options: QueryOptions = {}) => {
    const query = scoped(options);
    const [row] = await query.run(query.db
      .select({ ...project(), originName: origin.name, destinationName: destination.name, aircraftModel: aircraft.model })
      .from(table)
      .innerJoin(origin, eq(origin.code, table.originCode))
      .innerJoin(destination, eq(destination.code, table.destinationCode))
      .innerJoin(aircraft, eq(aircraft.id, table.aircraftId))
      .where(query.where(eq(table.id, id))));
    return row ?? null;
  },
  findDelayed: async (minMinutes: number, { sort, ...options }: QueryOptions & { sort?: FlightSort } = {}) => {
    const query = scoped(options);
    return query.run(query.db
      .select({ ...project(), delayMinutes: sql<number>`extract(epoch from ${table.actualDeparture} - ${table.scheduledDeparture}) / 60`.mapWith(Number) })
      .from(table)
      .where(query.where(sql`${table.actualDeparture} - ${table.scheduledDeparture} > make_interval(mins => ${minMinutes})`))
      .orderBy(...orderBy(sort)));
  },
  statsByOrigin: (from: Date, to: Date, options: QueryOptions = {}) => {
    const query = scoped(options);
    return query.run(query.db
      .select({ originCode: table.originCode, originName: airports.name, flights: count() })
      .from(table)
      .innerJoin(airports, eq(airports.code, table.originCode))
      .where(query.where(and(gte(table.scheduledDeparture, from), lt(table.scheduledDeparture, to))))
      .groupBy(table.originCode, airports.name)
      .orderBy(table.originCode));
  },
  // Finds another live flight on the same aircraft whose times overlap.
  findOverlapping: async (aircraftId: number, departure: Date, arrival: Date, excludeId?: number, options: QueryOptions = {}) => {
    // Drops the caller's scope on purpose: a clash with a flight the caller can't see is still a clash.
    const query = scoped({ ...options, scope: undefined });
    const [row] = await query.run(query.db
      .select(project(['id', 'flightNumber']))
      .from(table)
      .where(query.where(and(
        eq(table.aircraftId, aircraftId), ne(table.status, 'cancelled'),
        lt(table.scheduledDeparture, arrival), gt(table.scheduledArrival, departure),
        excludeId === undefined ? undefined : ne(table.id, excludeId),
      )))
      .limit(1));
    return row ?? null;
  },
}));

// 4. Service
// Business rules live in hooks so every caller gets them, not just routes.
// The library never logs. To log from hooks, the route puts `request.log` on the caller itself (see `context` below).
interface Caller { id: number; roles: string[]; log: FastifyBaseLogger }
type Schedule = Pick<Flight, 'aircraftId' | 'originCode' | 'destinationCode' | 'scheduledDeparture' | 'scheduledArrival'>;
const scheduleKeys = ['aircraftId', 'originCode', 'destinationCode', 'scheduledDeparture', 'scheduledArrival'] as const;

async function assertSchedulable(plan: Schedule, context: ServiceContext<Caller>, excludeId?: number): Promise<void> {
  if (plan.scheduledArrival <= plan.scheduledDeparture) throw new BadRequestError('Arrival must be after departure');
  if (plan.originCode === plan.destinationCode) throw new BadRequestError('Origin and destination must differ');
  const clash = await flightRepo.findOverlapping(plan.aircraftId, plan.scheduledDeparture, plan.scheduledArrival, excludeId, context);
  if (clash) throw new ConflictError(`Aircraft is already flying ${clash.flightNumber} then`);
}

// The third type argument keeps the custom queries typed on `service.repository`.
const baseFlightService = createService<typeof flightEntity, Caller, typeof flightRepo>(flightRepo, {
  hooks: {
    beforeCreate: async ({ input, context }) => {
      await assertSchedulable(input, context);
      return input;
    },
    beforeUpdate: async ({ id, patch, context }) => {
      // Re-check only when the schedule changes, merging the patch with the stored row.
      if (scheduleKeys.some((key) => patch[key] !== undefined)) {
        const current = await flightRepo.findById(id, { columns: scheduleKeys, scope: context.scope, transaction: context.transaction });
        if (!current) throw new NotFoundError('flights not found');
        await assertSchedulable({ ...current, ...patch }, context, id);
      }
      // Status changes set the actual times unless the client sent them.
      const now = new Date();
      return {
        ...patch,
        ...(patch.status === 'departed' && !patch.actualDeparture && { actualDeparture: now }),
        ...(patch.status === 'landed' && !patch.actualArrival && { actualArrival: now }),
      };
    },
    afterCreate: ({ row, context }) => context.auth?.log.info({ id: row.id }, 'flight scheduled'),
    afterUpdate: ({ row, context }) => context.auth?.log.info({ id: row.id, status: row.status }, 'flight updated'),
    // A flight that has flown stays on record.
    beforeDelete: async ({ id, context }) => {
      const current = await flightRepo.findById(id, { columns: ['status'], scope: context.scope, transaction: context.transaction });
      if (current?.status === 'departed' || current?.status === 'landed') throw new ConflictError(`Can't delete a ${current.status} flight`);
    },
  },
});

// Custom service methods. Calling `base` methods with `context` runs the hooks, scope and transaction.
const flightService = baseFlightService.extend((base) => ({
  // The route passes its logger in as a plain argument.
  delayFlight: async (id: number, minutes: number, context: ServiceContext<Caller>, log: FastifyBaseLogger): Promise<Flight> => {
    const flight = await base.findById(id, { columns: ['scheduledDeparture', 'scheduledArrival'] }, context);
    if (!flight) throw new NotFoundError('flights not found');
    const shift = (date: Date) => new Date(date.getTime() + minutes * 60_000);
    log.info({ id, minutes }, 'delaying flight');
    return base.update(id, { scheduledDeparture: shift(flight.scheduledDeparture), scheduledArrival: shift(flight.scheduledArrival) }, context);
  },
  // In a route, `context` carries the request transaction, so if the second create fails the first is rolled back.
  scheduleRotation: async (outbound: CreateInput<typeof flightEntity>, inbound: CreateInput<typeof flightEntity>, context: ServiceContext<Caller>) =>
    [await base.create(outbound, context), await base.create(inbound, context)],
  // Code can sort by columns outside `sortable`; an enum sorts in its declared order.
  departuresBoard: (originCode: string, context: ServiceContext<Caller>) =>
    base.findByOriginCode(originCode, context, {
      columns: ['id', 'flightNumber', 'destinationCode', 'scheduledDeparture', 'status'],
      sort: ['status', 'scheduledDeparture'],
    }),
}));

// 5. Routes
const isDev = process.env.NODE_ENV !== 'production';
// Pretty logs in development, JSON in production. `sync: true` keeps them in order with console output.
const prettyStream = pretty({ sync: true, singleLine: true, translateTime: 'HH:MM:ss', messageFormat: '{reqId} {msg}', ignore: 'pid,hostname,reqId' });
const app = Fastify({ logger: { level: isDev ? 'debug' : 'info', ...(isDev && { stream: prettyStream }) } });
// Fake auth: the caller comes from a header. `request.user` isn't declared here because the test
// helpers already declare it in the shared tsconfig.
const callers: Record<string, Omit<Caller, 'log'>> = { ops: { id: 1, roles: ['ops'] }, passenger: { id: 2, roles: [] } };
const callerOf = (header: string | string[] | undefined) => (typeof header === 'string' ? callers[header] : undefined);

const flightRead = flightEntity.schemas.read;
const flightRoutes = crudRoutes({
  service: flightService,
  // Passes `request.log` to the service explicitly, as part of the caller, so hooks can log with the request id.
  context: (request): Caller | undefined => {
    const caller = callerOf(request.headers['x-user']);
    return caller && { ...caller, log: request.log };
  },
  authorize: { '*': requireAuth, create: requireRole('ops'), update: requireRole('ops'), delete: requireRole('ops') },
  extend: (scope, { service, entity, serviceContext }) => {
    // `service.repository` holds the custom queries; `serviceContext` passes them the route's scope and transaction.
    const delayed = z.array(z.intersection(flightRead, z.object({ delayMinutes: z.number() })));
    scope.get('/delayed', {
      config: { crudOperation: 'list' },
      schema: { querystring: z.object({ minMinutes: z.coerce.number().int().min(0).default(15) }), response: { 200: delayed } },
    }, (request) => service.repository.findDelayed(request.query.minMinutes, serviceContext(request)));

    const details = z.intersection(flightRead, z.object({ originName: z.string(), destinationName: z.string(), aircraftModel: z.string() }));
    scope.get('/:id/details', { config: { crudOperation: 'get' }, schema: { params: entity.schemas.params, response: { 200: details } } },
      async (request) => {
        const row = await service.repository.findDetails(request.params.id, serviceContext(request));
        if (!row) throw new NotFoundError('flights not found');
        return row;
      });

    const stats = z.array(z.object({ originCode: z.string(), originName: z.string(), flights: z.number() }));
    scope.get('/stats', {
      config: { crudOperation: 'list' },
      schema: { querystring: z.object({ from: z.coerce.date(), to: z.coerce.date() }), response: { 200: stats } },
    }, (request) => service.repository.statsByOrigin(request.query.from, request.query.to, serviceContext(request)));

    // A route over a finder, for a query with its own parameters.
    scope.get('/departing', {
      config: { crudOperation: 'list' },
      schema: { querystring: z.object({ from: z.coerce.date(), to: z.coerce.date() }), response: { 200: entity.schemas.listResult } },
    }, (request) => service.findByScheduledDepartureBetween(request.query.from, request.query.to, serviceContext(request)));

    scope.get('/board', {
      config: { crudOperation: 'list' },
      schema: { querystring: z.object({ origin: z.string().length(3) }), response: { 200: entity.schemas.listResult } },
    }, (request) => service.departuresBoard(request.query.origin, serviceContext(request)));

    scope.post('/:id/delay', {
      config: { crudOperation: 'update' },
      schema: { params: entity.schemas.params, body: z.object({ minutes: z.number().int().min(1).max(1440) }), response: { 200: flightRead } },
    }, (request) => service.delayFlight(request.params.id, request.body.minutes, serviceContext(request), request.log));

    scope.post('/rotation', {
      config: { crudOperation: 'create' },
      schema: { body: z.object({ outbound: entity.schemas.create, inbound: entity.schemas.create }), response: { 201: z.array(flightRead) } },
    }, async (request, reply) => {
      const legs = await service.scheduleRotation(request.body.outbound, request.body.inbound, serviceContext(request));
      reply.status(201);
      return legs;
    });
  },
});
await app.register(flightRoutes, { prefix: '/flights' });

// 6. Requests. `flightRoutes.create`, `.update`, `.list`… call the generated routes with type-checked bodies;
// `call` sends the custom routes from `extend`.
const as = (who: string) => ({ headers: { 'x-user': who } });
function show(response: Pick<LightMyRequestResponse, 'statusCode' | 'body' | 'raw'>): void {
  const { method, url, headers } = response.raw.req;
  console.log(`${method} ${url} as ${headers['x-user'] ?? 'anonymous'} → ${response.statusCode} ${response.body}`);
}
const call = async (method: 'GET' | 'POST', url: string, who: string, payload?: object) =>
  show(await app.inject({ method, url, payload, ...as(who) }));
const at = (time: string) => `2026-10-12T${time}:00.000Z`;
const flight = (flightNumber: string, from: string, to: string, aircraftId: number, departs: string, arrives: string) => ({
  flightNumber, originCode: from, destinationCode: to, aircraftId,
  scheduledDeparture: new Date(at(departs)), scheduledArrival: new Date(at(arrives)),
});

show(await flightRoutes.create(flight('LY001', 'TLV', 'JFK', 1, '06:00', '17:00'), as('ops')));
show(await flightRoutes.create(flight('LY315', 'TLV', 'LHR', 2, '07:00', '12:00'), as('ops')));
show(await flightRoutes.create(flight('LY316', 'LHR', 'TLV', 2, '13:00', '18:00'), as('ops')));
show(await flightRoutes.create(flight('LY323', 'TLV', 'CDG', 3, '09:00', '13:30'), as('ops')));
// Rejected by the role rule, the hook rules and database constraints.
show(await flightRoutes.create(flight('LY999', 'TLV', 'CDG', 3, '15:00', '19:00'), as('passenger')));
show(await flightRoutes.create(flight('LY400', 'TLV', 'CDG', 3, '15:00', '14:00'), as('ops')));
show(await flightRoutes.create(flight('LY401', 'TLV', 'CDG', 99, '15:00', '19:00'), as('ops')));
show(await flightRoutes.create(flight('LY402', 'LHR', 'CDG', 2, '10:00', '14:00'), as('ops')));
show(await flightRoutes.create(flight('LY315', 'TLV', 'LHR', 3, '20:00', '23:00'), as('ops')));
// The generated list accepts the filters declared in `filterable`.
await call('GET', `/flights/departing?from=${at('06:30')}&to=${at('10:00')}`, 'passenger');
await call('GET', '/flights/board?origin=TLV', 'passenger');
show(await flightRoutes.list({ originCode__eq: 'TLV' }, as('passenger')));
show(await flightRoutes.list({ fields: ['id', 'flightNumber', 'scheduledDeparture'] }, as('passenger')));
// Cursor paging: the first page's `nextCursor` fetches the page right after it.
const firstPage = await flightRoutes.list({ limit: 2, fields: ['id', 'flightNumber'] }, as('passenger'));
show(firstPage);
const { nextCursor } = z.object({ nextCursor: z.string() }).parse(firstPage.json());
show(await flightRoutes.list({ limit: 2, fields: ['id', 'flightNumber'], cursor: nextCursor }, as('passenger')));
show(await flightRoutes.update(2, { status: 'departed' }, as('ops')));
show(await flightRoutes.update(1, { status: 'departed', actualDeparture: new Date(at('06:40')) }, as('ops')));
show(await flightRoutes.update(4, { status: 'boarding' }, as('ops')));
show(await flightRoutes.list({ status__in: ['boarding', 'departed'], fields: ['id', 'flightNumber', 'status'] }, as('passenger')));
await call('GET', '/flights/delayed?minMinutes=15', 'passenger');
await call('GET', '/flights/1/details', 'passenger');
await call('GET', `/flights/stats?from=${at('00:00')}&to=2026-10-13T00:00:00.000Z`, 'passenger');
await call('POST', '/flights/3/delay', 'ops', { minutes: 30 });
show(await flightRoutes.get(3, { fields: ['id', 'flightNumber', 'scheduledDeparture', 'scheduledArrival'] }, as('passenger')));
// A departed flight can't be deleted. Soft-deleted rows disappear from custom queries too.
show(await flightRoutes.delete(2, as('ops')));
show(await flightRoutes.delete(4, as('ops')));
show(await flightRoutes.list({ fields: ['id', 'flightNumber'] }, as('passenger')));
await call('GET', `/flights/stats?from=${at('00:00')}&to=2026-10-13T00:00:00.000Z`, 'passenger');
// The second leg clashes, so the first leg is rolled back too.
await call('POST', '/flights/rotation', 'ops', {
  outbound: flight('LY500', 'TLV', 'CDG', 3, '18:00', '22:00'),
  inbound: flight('LY501', 'CDG', 'TLV', 2, '14:00', '16:00'),
});
show(await flightRoutes.list({ fields: ['id', 'flightNumber'] }, as('passenger')));

await app.close();
await client.close();
