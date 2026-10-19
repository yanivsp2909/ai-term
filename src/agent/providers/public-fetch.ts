import type { IncomingMessage } from 'node:http';
import { Agent, request } from 'node:https';
import { Readable } from 'node:stream';
import { publicLookup, type Resolver } from '../../shared/public-host.js';
import type { Fetch } from './guard.js';

// A custom endpoint's requests (Part A) go through node's own https client instead of fetch: fetch can't be told which
// addresses a name may resolve to, and this one connects only to addresses publicLookup checked (never this machine, a
// private network or link-local). It never follows a redirect; guardedFetch in front of it keeps the URL to the endpoint.
export function publicFetch(resolve?: Resolver): Fetch {
  const agent = new Agent({ keepAlive: true, lookup: publicLookup(resolve) });
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== 'https:') throw new TypeError('https only');
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== 'string' && !(body instanceof Uint8Array)) throw new TypeError('Unsupported request body');
    const signal = init?.signal ?? undefined;
    return new Promise<Response>((resolveResponse, reject) => {
      const req = request(url, { method: init?.method ?? 'GET', headers, agent, ...(signal ? { signal } : {}) }, res => resolveResponse(toResponse(res, init?.method ?? 'GET')));
      req.on('error', reject);
      req.end(body ?? undefined);
    });
  };
}
// A node response as a fetch Response. A status that has no body (204, 205, 304, or any answer to HEAD) gets none, and its
// stream is drained so the keep-alive socket is free again (Part A review).
export function toResponse(res: IncomingMessage, method: string): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) if (value !== undefined) for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
  const status = res.statusCode ?? 502, empty = [204, 205, 304].includes(status) || method === 'HEAD';
  if (empty) res.resume();
  return new Response(empty ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, statusText: res.statusMessage ?? '', headers });
}
