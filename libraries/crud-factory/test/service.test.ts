import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { ConflictError, createRepository, createService, NotFoundError, type Logger, type ServiceContext } from '../src/index.ts';
import { postEntity, userEntity } from './fixtures/entities.ts';
import { posts, users } from './fixtures/schema.ts';
import { useTestDb } from './helpers/db.ts';

const { db } = useTestDb();

interface Auth {
  userId: number;
  orgId: number;
}

function fakeLogger() {
  const entries: { level: 'debug' | 'warn'; details: object; message: string | undefined }[] = [];
  const log: Logger = {
    debug: (details, message) => entries.push({ level: 'debug', details, message }),
    warn: (details, message) => entries.push({ level: 'warn', details, message }),
  };
  return { log, entries };
}

const service = createService<typeof userEntity, Auth>(createRepository(db, userEntity), {
  hooks: {
    beforeCreate: ({ input, context }) => ({ ...input, passwordHash: 'hashed', orgId: context.auth?.orgId ?? 0 }),
    beforeUpdate: ({ patch }) => ({ ...patch, name: patch.name?.trim() }),
  },
});

beforeEach(async () => {
  await db.execute(sql`truncate posts, users restart identity cascade`);
});

describe('createService', () => {
  test('hooks transform input before the repository call', async () => {
    const { log } = fakeLogger();
    const context = { log, auth: { userId: 1, orgId: 7 } };
    const created = await service.create({ email: 'a@b.c', name: 'A', orgId: 1 }, context);
    expect(created.orgId).toBe(7);
    const [stored] = await db.select({ passwordHash: users.passwordHash }).from(users);
    expect(stored?.passwordHash).toBe('hashed');

    const updated = await service.update(created.id, { name: '  Trimmed  ' }, context);
    expect(updated.name).toBe('Trimmed');
  });

  test('logs entity, op, id and duration at debug, never values', async () => {
    const { log, entries } = fakeLogger();
    const created = await service.create({ email: 'secret@b.c', name: 'A', orgId: 1 }, { log });
    await service.findById(created.id, {}, { log });
    const serviceLines = entries.filter((entry) => entry.message === 'repository call');
    expect(serviceLines.map((entry) => entry.details)).toEqual([
      { entity: 'users', op: 'create', id: undefined, durationMs: expect.any(Number) },
      { entity: 'users', op: 'findById', id: created.id, durationMs: expect.any(Number) },
    ]);
    // The hook's `passwordHash: 'hashed'` and the email reach the database but never the log.
    expect(JSON.stringify(entries)).not.toContain('secret@b.c');
    expect(JSON.stringify(entries)).not.toContain('hashed');
  });

  test('passes context.log down so the repository logs each SQL statement without its values', async () => {
    const { log, entries } = fakeLogger();
    await service.create({ email: 'sql@b.c', name: 'A', orgId: 1 }, { log });
    const sqlLines = entries.filter((entry) => entry.message === 'sql');
    expect(sqlLines).toEqual([
      { level: 'debug', message: 'sql', details: { entity: 'users', sql: expect.stringContaining('insert into "users"'), durationMs: expect.any(Number) } },
    ]);
    // Values are sent as parameters ($1, $2 …), so the statement text never contains them.
    expect(JSON.stringify(sqlLines)).not.toContain('sql@b.c');
    // The SQL line is written before the service's own line for the same call.
    expect(entries.map((entry) => entry.message)).toEqual(['sql', 'repository call']);
  });

  test('exposes the repository, with its extend methods, as service.repository', async () => {
    const repository = createRepository(db, userEntity).extend(({ scoped, table }) => ({
      emails: () => {
        const query = scoped();
        return query.run(query.db.select({ email: table.email }).from(table));
      },
    }));
    const extended = createService(repository);
    expect(extended.repository).toBe(repository);
    await extended.repository.create({ email: 'repo@b.c', name: 'A', orgId: 1, passwordHash: 'x' });
    expect(await extended.repository.emails()).toEqual([{ email: 'repo@b.c' }]);
  });

  test('logs client errors (4xx) at debug with their code and passes context.scope through', async () => {
    const { log, entries } = fakeLogger();
    const created = await service.create({ email: 'a@b.c', name: 'A', orgId: 1 }, { log });
    const scope = eq(users.orgId, 99);
    await expect(service.delete(created.id, { log, scope })).rejects.toBeInstanceOf(NotFoundError);
    expect(entries.at(-1)).toMatchObject({ level: 'debug', details: { entity: 'users', op: 'delete', id: created.id, code: 'NOT_FOUND' } });
  });
});

describe('service.extend', () => {
  const extended = service.extend((base) => ({
    rename: (id: number, name: string, context: ServiceContext<Auth>) => base.update(id, { name }, context),
  }));

  test('adds methods that run through the real service and repository, hooks included', async () => {
    const { log } = fakeLogger();
    const created = await extended.create({ email: 'x@b.c', name: 'A', orgId: 1 }, { log });
    // `beforeUpdate` trims the name, so the custom method went through `base.update`.
    expect(await extended.rename(created.id, '  Renamed  ', { log })).toMatchObject({ id: created.id, name: 'Renamed' });
  });

  test('keeps the built-ins, entity and repository, and leaves the original service unchanged', async () => {
    const { log } = fakeLogger();
    expect(extended.entity).toBe(service.entity);
    expect(extended.repository).toBe(service.repository);
    expect(extended.findMany).toBe(service.findMany);
    expect('rename' in service).toBe(false);
    const created = await extended.create({ email: 'y@b.c', name: 'B', orgId: 1 }, { log, auth: { userId: 1, orgId: 7 } });
    expect(created.orgId).toBe(7);
    expect((await extended.findMany({}, { log })).items).toHaveLength(1);
  });

  test('chained extends both work, and the second sees the first through base', async () => {
    const { log } = fakeLogger();
    const chained = extended.extend((base) => ({
      renameTwice: async (id: number, context: ServiceContext<Auth>) => {
        await base.rename(id, 'First', context);
        return base.rename(id, 'Second', context);
      },
    }));
    const created = await chained.create({ email: 'z@b.c', name: 'C', orgId: 1 }, { log });
    expect((await chained.rename(created.id, 'Once', { log })).name).toBe('Once');
    expect((await chained.renameTwice(created.id, { log })).name).toBe('Second');
  });

  test('a unique violation in a custom method is a ConflictError', async () => {
    const raw = service.extend(() => ({
      insertRaw: async () => {
        await db.insert(users).values({ email: 'dup@b.c', name: 'A', orgId: 1, passwordHash: 'x' });
      },
    }));
    await raw.insertRaw();
    await expect(raw.insertRaw()).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('write hooks', () => {
  /** A service whose hooks record their calls in `events`; its logger records each SQL statement there too. */
  function recordingService() {
    const events: string[] = [];
    const calls: Record<string, unknown> = {};
    const log: Logger = { debug: (_details, message) => message === 'sql' && events.push('sql'), warn: () => undefined };
    const recorded = createService<typeof userEntity, Auth>(createRepository(db, userEntity), {
      hooks: {
        beforeCreate: ({ input }) => {
          events.push('beforeCreate');
          return { ...input, passwordHash: 'h' };
        },
        afterCreate: (args) => {
          events.push('afterCreate');
          calls.afterCreate = args;
        },
        beforeUpdate: ({ patch }) => {
          events.push('beforeUpdate');
          return patch;
        },
        afterUpdate: (args) => {
          events.push('afterUpdate');
          calls.afterUpdate = args;
        },
        beforeDelete: async ({ id, context }) => {
          events.push('beforeDelete');
          const row = await createRepository(db, userEntity).findById(id, { columns: ['status'], tx: context.tx });
          if (row?.status === 'active') throw new ConflictError('Active users stay');
        },
        afterDelete: (args) => {
          events.push('afterDelete');
          calls.afterDelete = args;
        },
      },
    });
    return { events, calls, recorded, context: { log, auth: { userId: 1, orgId: 7 } } };
  }

  test('afterCreate runs after the insert with the saved row and the client input', async () => {
    const { events, calls, recorded, context } = recordingService();
    const input = { email: 'a@b.c', name: 'A', orgId: 1 };
    const row = await recorded.create(input, context);
    expect(events).toEqual(['beforeCreate', 'sql', 'afterCreate']);
    expect(row.id).toEqual(expect.any(Number));
    expect(calls.afterCreate).toEqual({ row, input, context });
  });

  test('afterUpdate runs after the update with the saved row and the client patch', async () => {
    const { events, calls, recorded, context } = recordingService();
    const created = await recorded.create({ email: 'a@b.c', name: 'A', orgId: 1 }, context);
    events.length = 0;
    const row = await recorded.update(created.id, { name: 'B' }, context);
    expect(events).toEqual(['beforeUpdate', 'sql', 'afterUpdate']);
    expect(row.name).toBe('B');
    expect(calls.afterUpdate).toEqual({ id: created.id, row, patch: { name: 'B' }, context });
  });

  test('beforeDelete runs first, and afterDelete gets the soft-deleted row', async () => {
    const { events, calls, recorded, context } = recordingService();
    const created = await recorded.create({ email: 'a@b.c', name: 'A', orgId: 1 }, context);
    events.length = 0;
    const row = await recorded.delete(created.id, context);
    // The hook's own read is not logged because it gets no `log`.
    expect(events).toEqual(['beforeDelete', 'sql', 'afterDelete']);
    expect(row).toMatchObject({ id: created.id, email: 'a@b.c', deletedAt: expect.any(Date) });
    expect(calls.afterDelete).toEqual({ id: created.id, row, context });
  });

  test('beforeDelete that throws blocks the delete', async () => {
    const { events, recorded, context } = recordingService();
    const created = await recorded.create({ email: 'a@b.c', name: 'A', orgId: 1, status: 'active' }, context);
    events.length = 0;
    await expect(recorded.delete(created.id, context)).rejects.toBeInstanceOf(ConflictError);
    expect(events).toEqual(['beforeDelete']);
    expect(await recorded.findById(created.id, {}, context)).toMatchObject({ id: created.id });
  });

  test('afterDelete gets the hard-deleted row', async () => {
    const deleted: unknown[] = [];
    const postService = createService(createRepository(db, postEntity), {
      hooks: { beforeCreate: ({ input }) => ({ ...input, orgId: 1 }), afterDelete: ({ row }) => void deleted.push(row) },
    });
    const { log } = fakeLogger();
    const author = await service.create({ email: 'a@b.c', name: 'A', orgId: 1 }, { log });
    const post = await postService.create({ authorId: author.id, title: 'Hello' }, { log });
    expect(await postService.delete(post.id, { log })).toEqual(post);
    expect(deleted).toEqual([post]);
    expect(await db.select().from(posts)).toEqual([]);
  });

  test('a custom method that calls base.update runs afterUpdate', async () => {
    const { events, recorded, context } = recordingService();
    const extended = recorded.extend((base) => ({
      rename: (id: number, name: string, context: ServiceContext<Auth>) => base.update(id, { name }, context),
    }));
    const created = await extended.create({ email: 'a@b.c', name: 'A', orgId: 1 }, context);
    events.length = 0;
    await extended.rename(created.id, 'Renamed', context);
    expect(events).toEqual(['beforeUpdate', 'sql', 'afterUpdate']);
  });
});
