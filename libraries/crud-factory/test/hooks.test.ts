import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { crudRoutes, type CrudHooksConfig } from '../src/fastify/index.ts';
import { createRepository, createService, requireAuth } from '../src/index.ts';
import { userEntity } from './fixtures/entities.ts';
import { useTestDb } from './helpers/db.ts';
import { as, buildServer, type TestUser } from './helpers/server.ts';

const { db } = useTestDb();

// Clients can't send hidden columns, so the service sets the one the table requires.
const userService = createService(createRepository(db, userEntity), {
  hooks: { create: ({ input, run }) => run({ ...input, passwordHash: 'secret-hash' }) },
});

const alice: TestUser = { id: 1, orgId: 10, roles: ['admin'] };
let emailCount = 0;
const newUser = () => ({ email: `user${++emailCount}@example.com`, name: 'Ann', orgId: 10 });

const openApps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

/** An app with the user routes under `/users` and the given hooks. Closed after each test. */
async function appWithHooks(hooks: CrudHooksConfig, options: { signInRequired?: boolean } = {}) {
  const app = await buildServer({
    register: (app) =>
      app.register(
        crudRoutes({
          service: userService,
          hooks,
          ...(options.signInRequired && {
            context: (request) => request.user ?? undefined,
            authorize: { '*': requireAuth },
          }),
        }),
        { prefix: '/users' },
      ),
  });
  openApps.push(app);
  return app;
}

/**
 * A real server, for the two hooks test requests can't trigger: it times out connections after 100ms
 * and has a `GET /users/slow` route that takes 500ms.
 */
async function listeningAppWithHooks(hooks: CrudHooksConfig) {
  const app = Fastify({ connectionTimeout: 100 });
  await app.register(
    crudRoutes({
      service: userService,
      hooks,
      extend: (scope) => {
        scope.get('/slow', { config: { crudOperation: 'list' } }, async () => {
          await sleep(500);
          return {};
        });
      },
    }),
    { prefix: '/users' },
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  openApps.push(app);
  const { port } = app.server.address() as AddressInfo;
  return { app, port };
}

describe('each Fastify request hook', () => {
  test('onRequest runs first and can answer the request itself', async () => {
    const reachedHandler = vi.fn<() => void>();
    const app = await appWithHooks({
      onRequest: async (_request, reply) => reply.code(429).send({ code: 'TOO_MANY_REQUESTS', message: 'Slow down' }),
      preHandler: async () => reachedHandler(),
    });

    const response = await app.inject({ method: 'POST', url: '/users', payload: newUser() });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ code: 'TOO_MANY_REQUESTS', message: 'Slow down' });
    expect(reachedHandler).not.toHaveBeenCalled();
  });

  test('preParsing gets the raw body stream before it is parsed', async () => {
    const seen: { bodyParsed: boolean; isStream: boolean }[] = [];
    const app = await appWithHooks({
      preParsing: async (request, _reply, payload) => {
        seen.push({ bodyParsed: request.body !== undefined, isStream: typeof payload.pipe === 'function' });
        return payload;
      },
    });

    const response = await app.inject({ method: 'POST', url: '/users', payload: newUser() });

    expect(response.statusCode).toBe(201);
    expect(seen).toEqual([{ bodyParsed: false, isStream: true }]);
  });

  test('preValidation sees the parsed body before it is validated', async () => {
    const bodies: unknown[] = [];
    const app = await appWithHooks({
      preValidation: async (request) => {
        bodies.push(request.body);
      },
    });

    // No `name`, so validation rejects the body after the hook has seen it.
    const response = await app.inject({ method: 'POST', url: '/users', payload: { email: 'no-name@example.com', orgId: 10 } });

    expect(response.statusCode).toBe(400);
    expect(bodies).toEqual([{ email: 'no-name@example.com', orgId: 10 }]);
  });

  test('preHandler runs after the authorize check, only for allowed requests', async () => {
    const callers: unknown[] = [];
    const app = await appWithHooks(
      {
        preHandler: async (request) => {
          callers.push(request.user);
        },
      },
      { signInRequired: true },
    );

    const anonymous = await app.inject({ method: 'GET', url: '/users' });
    const signedIn = await app.inject({ method: 'GET', url: '/users', headers: as(alice) });

    expect(anonymous.statusCode).toBe(401);
    expect(signedIn.statusCode).toBe(200);
    expect(callers).toEqual([alice]);
  });

  test('preSerialization gets the object the handler returned', async () => {
    const payloads: unknown[] = [];
    const app = await appWithHooks({
      preSerialization: async (_request, _reply, payload) => {
        payloads.push(payload);
        return payload;
      },
    });

    const created = await app.inject({ method: 'POST', url: '/users', payload: newUser() });

    expect(created.statusCode).toBe(201);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ id: created.json().id, name: 'Ann' });
  });

  test('onSend can change the response body and headers', async () => {
    const app = await appWithHooks({
      onSend: async (_request, reply) => {
        reply.header('x-replaced', 'yes');
        return JSON.stringify({ replaced: true });
      },
    });

    const response = await app.inject({ method: 'GET', url: '/users' });

    expect(response.headers['x-replaced']).toBe('yes');
    expect(response.json()).toEqual({ replaced: true });
  });

  test('onResponse runs after the response is sent, with its final status', async () => {
    const statuses: number[] = [];
    const app = await appWithHooks({
      onResponse: async (_request, reply) => {
        statuses.push(reply.statusCode);
      },
    });

    await app.inject({ method: 'POST', url: '/users', payload: newUser() });
    await app.inject({ method: 'GET', url: '/users/999999' });

    await vi.waitFor(() => expect(statuses).toEqual([201, 404]));
  });

  test('onError gets the error, and the response is still the library error body', async () => {
    const messages: string[] = [];
    const app = await appWithHooks({
      onError: async (_request, _reply, error) => {
        messages.push(error.message);
      },
    });

    const response = await app.inject({ method: 'GET', url: '/users/999999' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'NOT_FOUND' });
    expect(messages).toEqual(['users not found']);
  });

  test('onTimeout runs when the connection times out during a slow request', async () => {
    const timedOut: string[] = [];
    const { port } = await listeningAppWithHooks({
      onTimeout: async (request) => {
        timedOut.push(request.url);
      },
    });

    await fetch(`http://127.0.0.1:${port}/users/slow`).catch(() => undefined);

    await vi.waitFor(() => expect(timedOut).toEqual(['/users/slow']));
  });

  test('onRequestAbort runs when the client hangs up mid-request', async () => {
    const aborted: string[] = [];
    const { port } = await listeningAppWithHooks({
      onRequestAbort: async (request) => {
        aborted.push(request.url);
      },
    });

    const socket = net.connect(port, '127.0.0.1');
    socket.write('GET /users/slow HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await sleep(50);
    socket.destroy();

    await vi.waitFor(() => expect(aborted).toEqual(['/users/slow']));
  });
});

describe('how hooks are registered', () => {
  test('all hooks run in Fastify order on a normal request', async () => {
    const order: string[] = [];
    const app = await appWithHooks({
      onRequest: async () => void order.push('onRequest'),
      preParsing: async (_request, _reply, payload) => {
        order.push('preParsing');
        return payload;
      },
      preValidation: async () => void order.push('preValidation'),
      preHandler: async () => void order.push('preHandler'),
      preSerialization: async (_request, _reply, payload) => {
        order.push('preSerialization');
        return payload;
      },
      onSend: async (_request, _reply, payload) => {
        order.push('onSend');
        return payload;
      },
      onResponse: async () => void order.push('onResponse'),
    });

    await app.inject({ method: 'POST', url: '/users', payload: newUser() });

    await vi.waitFor(() =>
      expect(order).toEqual(['onRequest', 'preParsing', 'preValidation', 'preHandler', 'preSerialization', 'onSend', 'onResponse']),
    );
  });

  test('an array of hooks runs in the order given', async () => {
    const order: number[] = [];
    const app = await appWithHooks({
      onRequest: [async () => void order.push(1), async () => void order.push(2), async () => void order.push(3)],
    });

    await app.inject({ method: 'GET', url: '/users' });

    expect(order).toEqual([1, 2, 3]);
  });

  test('a hook gets the plugin scope as `this`, like a hook added with addHook', async () => {
    const prefixes: string[] = [];
    const app = await appWithHooks({
      onRequest: async function () {
        prefixes.push(this.prefix);
      },
    });

    await app.inject({ method: 'GET', url: '/users' });

    expect(prefixes).toEqual(['/users']);
  });

  test('a hook that declares fewer arguments than Fastify passes still runs', async () => {
    // Fastify alone refuses `onRequestAbort: async () => {}` at startup, because it counts declared arguments.
    const ran = vi.fn<() => void>();
    const app = await appWithHooks({ onRequestAbort: async () => {}, onRequest: async () => ran() });

    await app.inject({ method: 'GET', url: '/users' });

    expect(ran).toHaveBeenCalledOnce();
  });

  test('hooks only apply to the crud routes, not to other routes on the app', async () => {
    const urls: string[] = [];
    const app = await buildServer({
      register: async (app) => {
        app.get('/health', async () => ({ ok: true }));
        await app.register(
          crudRoutes({ service: userService, hooks: { onRequest: async (request) => void urls.push(request.url) } }),
          { prefix: '/users' },
        );
      },
    });
    openApps.push(app);

    await app.inject({ method: 'GET', url: '/health' });
    await app.inject({ method: 'GET', url: '/users' });

    expect(urls).toEqual(['/users']);
  });
});
