import type { FastifyInstance, HTTPMethods, LightMyRequestResponse } from 'fastify';
import type { AnyEntity, ArrayItem, CreateInput, Filter, PrimaryKeyValue, UpdateInput, VisibleKey } from '../types.ts';

type Headers = { headers?: Record<string, string> };
type SortableKey<E extends AnyEntity> = ArrayItem<E['config']['sortable']>;

/**
 * Typed calls to the generated routes, sent through Fastify's `inject` to the prefix the plugin was
 * registered with. Bodies and queries are checked against the entity, so a missing required field is a
 * compile error. Custom `extend` routes are not included.
 */
export interface CrudCalls<E extends AnyEntity> {
  /** `POST /`: creates a row. */
  create(body: CreateInput<E>, options?: Headers): Promise<LightMyRequestResponse>;
  /** `PATCH /:id`: changes some fields of a row. */
  update(id: PrimaryKeyValue<E>, patch: UpdateInput<E>, options?: Headers): Promise<LightMyRequestResponse>;
  /** `GET /:id`: reads one row, optionally only some `fields`. */
  get(id: PrimaryKeyValue<E>, query?: { fields?: readonly VisibleKey<E>[] }, options?: Headers): Promise<LightMyRequestResponse>;
  /** `GET /`: lists rows with the `filterable` filters, sorting and paging. */
  list(
    query?: Filter<E> & {
      sort?: readonly (SortableKey<E> | `-${SortableKey<E>}`)[];
      limit?: number;
      offset?: number;
      cursor?: string;
      fields?: readonly VisibleKey<E>[];
      total?: boolean;
    },
    options?: Headers,
  ): Promise<LightMyRequestResponse>;
  /** `DELETE /:id`: deletes a row. */
  delete(id: PrimaryKeyValue<E>, options?: Headers): Promise<LightMyRequestResponse>;
}

function queryValue(value: unknown): string {
  if (value instanceof Date) return encodeURIComponent(value.toISOString());
  return encodeURIComponent(String(value));
}

/** Turns a query object into a querystring: arrays become comma lists and `undefined` values are left out. */
function toQueryString(query: object): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    const text = Array.isArray(value) ? value.map(queryValue).join(',') : queryValue(value);
    parts.push(`${encodeURIComponent(key)}=${text}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

// JSON has no bigint type, and the body schemas accept bigint columns as strings.
function bigintAsString(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

interface CallRequest {
  method: HTTPMethods;
  /** The row id for `/:id` routes; left out for the collection route `/`. */
  id?: unknown;
  query?: object;
  body?: unknown;
  options?: Headers;
}

/** Builds the typed route methods. `getScope` returns the scope the plugin was last registered in, if any. */
export function buildCalls<E extends AnyEntity>(name: string, getScope: () => FastifyInstance | undefined): CrudCalls<E> {
  async function send({ method, id, query = {}, body, options = {} }: CallRequest): Promise<LightMyRequestResponse> {
    const scope = getScope();
    if (!scope) throw new Error(`${name}: register the crudRoutes plugin before calling its routes`);

    // Without a prefix the collection route is `/`.
    const path = id === undefined ? scope.prefix || '/' : `${scope.prefix}/${encodeURIComponent(String(id))}`;
    const url = `${path}${toQueryString(query)}`;
    if (body === undefined) {
      return scope.inject({ method, url, headers: options.headers });
    }
    const headers = { 'content-type': 'application/json', ...options.headers };
    return scope.inject({ method, url, headers, payload: JSON.stringify(body, bigintAsString) });
  }

  return {
    create: (body, options) => send({ method: 'POST', body, options }),
    update: (id, patch, options) => send({ method: 'PATCH', id, body: patch, options }),
    get: (id, query, options) => send({ method: 'GET', id, query, options }),
    list: (query, options) => send({ method: 'GET', query, options }),
    delete: (id, options) => send({ method: 'DELETE', id, options }),
  };
}
