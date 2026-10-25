import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { ConflictError, createRepository, createService, NotFoundError, type QueryOptions, type ServiceContext } from '../src/index.ts';
import { postEntity, userEntity } from './fixtures/entities.ts';
import { posts, users } from './fixtures/schema.ts';
import { useTestDb } from './helpers/db.ts';

const { db } = useTestDb();

interface Auth {
  userId: number;
  orgId: number;
}

const service = createService<typeof userEntity, Auth>(createRepository(db, userEntity), {
  hooks: {
    create: ({ input, context, run }) => run({ ...input, passwordHash: 'hashed', orgId: context.auth?.orgId ?? 0 }),
    update: ({ patch, run }) => run({ ...patch, name: patch.name?.trim() }),
  },
});

beforeEach(async () => {
  await db.execute(sql`truncate posts, users restart identity cascade`);
});

describe('createService', () => {
  test('hooks transform input before the repository call', async () => {
    const context = { auth: { userId: 1, orgId: 7 } };
    const created = await service.create({ email: 'a@b.c', name: 'A', orgId: 1 }, context);
    expect(created.orgId).toBe(7);
    const [stored] = await db.select({ passwordHash: users.passwordHash }).from(users);
    expect(stored?.passwordHash).toBe('hashed');

    const updated = await service.update(created.id, { name: '  Trimmed  ' }, context);
    expect(updated.name).toBe('Trimmed');
  });

  test('exposes the repository, with its extend methods, as service.repository', async () => {
    const repository = createRepository(db, userEntity).extend(({ scoped, table }) => ({
      emails: () => scoped({}, ({ database, visible }) => database.select({ email: table.email }).from(table).where(visible())),
    }));
    const extended = createService(repository);
    expect(extended.repository).toBe(repository);
    await extended.repository.create({ email: 'repo@b.c', name: 'A', orgId: 1, passwordHash: 'x' });
    expect(await extended.repository.emails()).toEqual([{ email: 'repo@b.c' }]);
  });

  test('passes context.scope through, so a row outside it is not found', async () => {
    const created = await service.create({ email: 'a@b.c', name: 'A', orgId: 1 }, {});
    const scope = eq(users.orgId, 99);
    await expect(service.delete(created.id, { scope })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('service.extend', () => {
  const extended = service.extend((base) => ({
    rename: (id: number, name: string, context: ServiceContext<Auth>) => base.update(id, { name }, context),
  }));

  test('adds methods that run through the real service and repository, hooks included', async () => {
    const created = await extended.create({ email: 'x@b.c', name: 'A', orgId: 1 }, {});
    // The `update` hook trims the name, so the custom method went through `base.update`.
    expect(await extended.rename(created.id, '  Renamed  ', {})).toMatchObject({ id: created.id, name: 'Renamed' });
  });

  test('keeps the built-ins, entity and repository, and leaves the original service unchanged', async () => {
    expect(extended.entity).toBe(service.entity);
    expect(extended.repository).toBe(service.repository);
    expect(extended.findMany).toBe(service.findMany);
    expect('rename' in service).toBe(false);
    const created = await extended.create({ email: 'y@b.c', name: 'B', orgId: 1 }, { auth: { userId: 1, orgId: 7 } });
    expect(created.orgId).toBe(7);
    expect((await extended.findMany({}, {})).items).toHaveLength(1);
  });

  test('chained extends both work, and the second sees the first through base', async () => {
    const chained = extended.extend((base) => ({
      renameTwice: async (id: number, context: ServiceContext<Auth>) => {
        await base.rename(id, 'First', context);
        return base.rename(id, 'Second', context);
      },
    }));
    const created = await chained.create({ email: 'z@b.c', name: 'C', orgId: 1 }, {});
    expect((await chained.rename(created.id, 'Once', {})).name).toBe('Once');
    expect((await chained.renameTwice(created.id, {})).name).toBe('Second');
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
  /** A service whose hooks record what happens before and after each write in `events`. */
  function recordingService() {
    const events: string[] = [];
    const calls: Record<string, unknown> = {};
    const recorded = createService<typeof userEntity, Auth>(createRepository(db, userEntity), {
      hooks: {
        create: async ({ input, context, run }) => {
          events.push('before create');
          const row = await run({ ...input, passwordHash: 'h' });
          events.push('after create');
          calls.create = { row, input, context };
          return row;
        },
        update: async ({ id, patch, context, run }) => {
          events.push('before update');
          const row = await run();
          events.push('after update');
          calls.update = { id, row, patch, context };
          return row;
        },
        delete: async ({ id, context, run }) => {
          events.push('before delete');
          const current = await createRepository(db, userEntity).findById(id, { columns: ['status'], transaction: context.transaction });
          if (current?.status === 'active') throw new ConflictError('Active users stay');
          const row = await run();
          events.push('after delete');
          calls.delete = { id, row, context };
          return row;
        },
      },
    });
    return { events, calls, recorded, context: { auth: { userId: 1, orgId: 7 } } };
  }

  test('create: code after run() gets the saved row, and the client input is still in scope', async () => {
    const { events, calls, recorded, context } = recordingService();
    const input = { email: 'a@b.c', name: 'A', orgId: 1 };
    const row = await recorded.create(input, context);
    expect(events).toEqual(['before create', 'after create']);
    expect(row.id).toEqual(expect.any(Number));
    expect(calls.create).toEqual({ row, input, context });
  });

  test('update: run() with no argument saves the client patch as-is', async () => {
    const { events, calls, recorded, context } = recordingService();
    const created = await recorded.create({ email: 'a@b.c', name: 'A', orgId: 1 }, context);
    events.length = 0;
    const row = await recorded.update(created.id, { name: 'B' }, context);
    expect(events).toEqual(['before update', 'after update']);
    expect(row.name).toBe('B');
    expect(calls.update).toEqual({ id: created.id, row, patch: { name: 'B' }, context });
  });

  test('delete: run() returns the soft-deleted row without its deletedAt', async () => {
    const { events, calls, recorded, context } = recordingService();
    const created = await recorded.create({ email: 'a@b.c', name: 'A', orgId: 1 }, context);
    events.length = 0;
    const row = await recorded.delete(created.id, context);
    expect(events).toEqual(['before delete', 'after delete']);
    expect(row).toMatchObject({ id: created.id, email: 'a@b.c' });
    expect(row).not.toHaveProperty('deletedAt');
    expect(calls.delete).toEqual({ id: created.id, row, context });
    const [stored] = await db.select({ deletedAt: users.deletedAt }).from(users).where(eq(users.id, created.id));
    expect(stored?.deletedAt).toBeInstanceOf(Date);
  });

  test('a hook that throws before run() blocks the write', async () => {
    const { events, recorded, context } = recordingService();
    const created = await recorded.create({ email: 'a@b.c', name: 'A', orgId: 1, status: 'active' }, context);
    events.length = 0;
    await expect(recorded.delete(created.id, context)).rejects.toBeInstanceOf(ConflictError);
    expect(events).toEqual(['before delete']);
    expect(await recorded.findById(created.id, {}, context)).toMatchObject({ id: created.id });
  });

  test('delete: run() returns the hard-deleted row', async () => {
    const deleted: unknown[] = [];
    const postService = createService(createRepository(db, postEntity), {
      hooks: {
        create: ({ input, run }) => run({ ...input, orgId: 1 }),
        delete: async ({ run }) => {
          const row = await run();
          deleted.push(row);
          return row;
        },
      },
    });
    const author = await service.create({ email: 'a@b.c', name: 'A', orgId: 1 }, {});
    const post = await postService.create({ authorId: author.id, title: 'Hello' }, {});
    expect(await postService.delete(post.id, {})).toEqual(post);
    expect(deleted).toEqual([post]);
    expect(await db.select().from(posts)).toEqual([]);
  });

  test('hooks get the service repository, which joins the transaction when given context.transaction', async () => {
    const repository = createRepository(db, userEntity).extend(({ scoped, table }) => ({
      countByName: (name: string, options: QueryOptions) =>
        scoped(options, ({ database, visible }) => database.$count(table, and(visible(), eq(table.name, name)))),
    }));
    const guarded = createService(repository, {
      hooks: {
        delete: async ({ id, context, repository: hookRepository, run }) => {
          expect(hookRepository).toBe(repository);
          const current = await hookRepository.findById(id, { columns: ['name'], transaction: context.transaction });
          const namesakes = await hookRepository.countByName(current?.name ?? '', { transaction: context.transaction });
          if (namesakes > 1) throw new ConflictError('Ambiguous name');
          return run();
        },
      },
    });
    const first = await repository.create({ email: 'a@b.c', name: 'A', orgId: 1, passwordHash: 'h' });
    await repository.create({ email: 'b@b.c', name: 'A', orgId: 1, passwordHash: 'h' });
    await expect(db.transaction((transaction) => guarded.delete(first.id, { transaction }))).rejects.toBeInstanceOf(ConflictError);
  });

  test('the row the hook returns is what the caller gets', async () => {
    const renamed = createService(createRepository(db, userEntity), {
      hooks: {
        create: async ({ input, run }) => {
          const row = await run({ ...input, passwordHash: 'h' });
          return { ...row, name: 'Shown to the caller' };
        },
      },
    });
    expect(await renamed.create({ email: 'a@b.c', name: 'A', orgId: 1 }, {})).toMatchObject({ name: 'Shown to the caller' });
    expect(await db.select({ name: users.name }).from(users)).toEqual([{ name: 'A' }]);
  });

  test('a custom method that calls base.update runs the update hook', async () => {
    const { events, recorded, context } = recordingService();
    const extended = recorded.extend((base) => ({
      rename: (id: number, name: string, context: ServiceContext<Auth>) => base.update(id, { name }, context),
    }));
    const created = await extended.create({ email: 'a@b.c', name: 'A', orgId: 1 }, context);
    events.length = 0;
    await extended.rename(created.id, 'Renamed', context);
    expect(events).toEqual(['before update', 'after update']);
  });
});

describe('run() guards', () => {
  const userRepo = createRepository(db, userEntity);
  const newUser = { email: 'a@b.c', name: 'A', orgId: 1 };

  test('calling run() twice throws, and only the first write happens', async () => {
    const twice = createService(userRepo, {
      hooks: {
        create: async ({ input, run }) => {
          await run({ ...input, passwordHash: 'h' });
          return run({ ...input, email: 'other@b.c', passwordHash: 'h' });
        },
      },
    });
    await expect(twice.create(newUser, {})).rejects.toThrow("The service's create hook called run() more than once");
    expect(await db.select({ email: users.email }).from(users)).toEqual([{ email: 'a@b.c' }]);
  });

  test('returning without calling run() throws, and nothing is written', async () => {
    const created = await userRepo.create({ ...newUser, passwordHash: 'h' });
    const skipping = createService(userRepo, {
      hooks: { update: async ({ id }) => ({ ...created, id, name: 'Never saved' }) },
    });
    await expect(skipping.update(created.id, { name: 'B' }, {})).rejects.toThrow("The service's update hook returned without calling run()");
    expect(await db.select({ name: users.name }).from(users)).toEqual([{ name: 'A' }]);
  });

  test('catching a database error from run() is allowed without a transaction', async () => {
    const existing = await userRepo.create({ ...newUser, passwordHash: 'h' });
    const findOrCreate = createService(userRepo, {
      hooks: {
        create: async ({ input, run }) => {
          try {
            return await run({ ...input, passwordHash: 'h' });
          } catch (error) {
            if (!(error instanceof ConflictError)) throw error;
            return existing;
          }
        },
      },
    });
    expect(await findOrCreate.create(newUser, {})).toEqual(existing);
  });

  test('catching a database error from run() inside a transaction throws, and nothing commits', async () => {
    const existing = await userRepo.create({ ...newUser, passwordHash: 'h' });
    const findOrCreate = createService(userRepo, {
      hooks: {
        create: async ({ input, run }) => {
          try {
            return await run({ ...input, passwordHash: 'h' });
          } catch (error) {
            if (!(error instanceof ConflictError)) throw error;
            return existing;
          }
        },
      },
    });
    const attempt = db.transaction(async (transaction) => {
      await userRepo.create({ email: 'kept@b.c', name: 'K', orgId: 1, passwordHash: 'h' }, { transaction });
      return findOrCreate.create(newUser, { transaction });
    });
    await expect(attempt).rejects.toThrow("The service's create hook caught a database error from run()");
    await expect(attempt).rejects.toHaveProperty('cause', expect.any(ConflictError));
    expect(await db.select({ email: users.email }).from(users)).toEqual([{ email: 'a@b.c' }]);
  });

  test('catching a NotFoundError from run() inside a transaction is allowed: it aborts nothing', async () => {
    const createIfMissing = createService(userRepo, {
      hooks: {
        update: async ({ patch, context, run }) => {
          try {
            return await run();
          } catch (error) {
            if (!(error instanceof NotFoundError)) throw error;
            // The transaction is still usable, so the fallback write commits with it.
            return userRepo.create({ ...newUser, ...patch, passwordHash: 'h' }, { transaction: context.transaction });
          }
        },
      },
    });
    const row = await db.transaction((transaction) => createIfMissing.update(999, { name: 'B' }, { transaction }));
    expect(row).toMatchObject({ name: 'B' });
    expect(await db.select({ name: users.name }).from(users)).toEqual([{ name: 'B' }]);
  });
});
