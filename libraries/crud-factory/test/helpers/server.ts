import { Writable } from 'node:stream';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll } from 'vitest';
import { z } from 'zod';

/** The caller the fake auth hook puts on `request.user`. */
export interface TestUser {
  id: number;
  orgId: number;
  roles: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    user: TestUser | null;
  }
}

const testUserSchema = z.object({ id: z.number(), orgId: z.number(), roles: z.array(z.string()) });

/** Header value that signs a request in as `user` with the fake auth hook. */
export const as = (user: TestUser) => ({ 'x-user': JSON.stringify(user) });

/** Collects every JSON log line the server writes. */
export function captureLogs() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(z.record(z.string(), z.unknown()).parse(JSON.parse(chunk.toString())));
      done();
    },
  });
  return { lines, logger: pino({ level: 'debug' }, stream) };
}

/**
 * A Fastify app with a stand-in for the host's auth plugin: `x-user: <json>` sets `request.user`.
 * `register` adds the routes under test.
 */
export async function buildServer(options: {
  register: (app: FastifyInstance) => PromiseLike<unknown> | void;
  logger?: FastifyBaseLogger;
}): Promise<FastifyInstance> {
  const logger: FastifyBaseLogger = options.logger ?? pino({ level: 'silent' });
  const app = Fastify({ loggerInstance: logger });
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    const header = request.headers['x-user'];
    request.user = typeof header === 'string' ? testUserSchema.parse(JSON.parse(header)) : null;
  });
  await options.register(app);
  await app.ready();
  return app;
}

/** Builds the server in `beforeAll` and closes it in `afterAll`; call the result inside a test. */
export function useServer(options: Parameters<typeof buildServer>[0]): () => FastifyInstance {
  let app: FastifyInstance | undefined;
  beforeAll(async () => {
    app = await buildServer(options);
  });
  afterAll(() => app?.close());
  return () => {
    if (!app) throw new Error('the server is built in beforeAll');
    return app;
  };
}
