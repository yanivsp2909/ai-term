import { describe, expect, it } from 'vitest';
import { createServer } from 'node:https';
import type { LookupAddress } from 'node:dns';
import { isPublicAddress, isPublicEndpoint, publicLookup, PrivateAddressError, type Resolver } from '../src/shared/public-host.js';
import { publicFetch } from '../src/agent/providers/public-fetch.js';

// Part A: a custom OpenAI-compatible endpoint is https to the public internet only, in the address typed and in every
// address its name resolves to at connection time.
const resolver = (addresses: string[]): Resolver => (_hostname, callback) => callback(null, addresses.map((address): LookupAddress => ({ address, family: address.includes(':') ? 6 : 4 })));

describe('public addresses', () => {
  it('refuses loopback, private, link-local, shared, multicast, documentation and mixed IPv6 forms; keeps public ones', () => {
    for (const address of ['127.0.0.1', '127.255.0.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.100.100.100', '0.0.0.0', '224.0.0.1', '255.255.255.255',
      '192.0.2.10', '198.51.100.7', '203.0.113.5', '198.18.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '::ffff:7f00:1',
      '::127.0.0.1', '64:ff9b::a00:1', '2001:db8::1', '2002:7f00:1::1', 'not-an-ip'])
      expect(isPublicAddress(address), address).toBe(false);
    for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e']) expect(isPublicAddress(address), address).toBe(true);
  });

  it('an endpoint must be https on its default port, with a public address or a name that is not a local one', () => {
    for (const endpoint of ['https://api.example.com/v1', 'https://llm.example.org', 'https://8.8.8.8/v1', 'https://[2606:4700:4700::1111]/v1', 'https://api.example.com:443/v1'])
      expect(isPublicEndpoint(endpoint), endpoint).toBe(true);
    for (const endpoint of ['http://api.example.com/v1', 'https://localhost/v1', 'https://api.localhost/v1', 'https://printer.local/v1', 'https://box.internal', 'https://router.lan', 'https://nas.home.arpa',
      'https://127.0.0.1/v1', 'https://0x7f000001/v1', 'https://2130706433/v1', 'https://10.0.0.5/v1', 'https://169.254.169.254/latest', 'https://[::1]/v1', 'https://[fe80::1]/v1', 'https://intranet',
      'https://api.example.com:8443/v1', 'https://user:pass@api.example.com/v1', 'https://api.example.com/v1?x=1', 'https://api.example.com/v1#f', 'ftp://api.example.com', 'api.example.com', 42])
      expect(isPublicEndpoint(endpoint), String(endpoint)).toBe(false);
  });

  it('a name that resolves to any address that is not public is refused before a connection opens', async () => {
    const ask = (addresses: string[]) => new Promise<{ error: unknown; address: unknown }>(done => publicLookup(resolver(addresses))('api.example.com', { all: true }, (error, address) => done({ error, address })));
    expect((await ask(['8.8.8.8'])).error).toBeNull();
    expect((await ask(['8.8.8.8', '2606:4700:4700::1111'])).address).toHaveLength(2);
    for (const addresses of [['127.0.0.1'], ['8.8.8.8', '10.0.0.1'], ['169.254.169.254'], ['::1'], []]) expect((await ask(addresses)).error, addresses.join(',')).toBeInstanceOf(PrivateAddressError);
  });

  it('the custom endpoint fetch never connects to a private address, whatever the name says', async () => {
    // A real https server on 127.0.0.1: the name points there, and the request must fail before reaching it.
    let reached = false;
    const server = createServer((_req, res) => { reached = true; res.end('{}'); });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(), port = typeof address === 'object' && address ? address.port : 0;
    try {
      const fetch = publicFetch(resolver(['127.0.0.1']));
      await expect(fetch(`https://api.example.com:${port}/v1/chat/completions`, { method: 'POST', body: '{}' })).rejects.toThrow(/public internet/);
      await expect(fetch('http://api.example.com/v1', {})).rejects.toThrow('https only');
      expect(reached).toBe(false);
    } finally { await new Promise(done => server.close(done)); }
  });
});

describe('Part A review findings', () => {
  it('security LOW: an IPv4-compatible IPv6 address (::a.b.c.d, written ::7f00:1) is not public; nor is an endpoint ending in ? or #', () => {
    for (const address of ['::7f00:1', '::102:304', '::a00:1']) expect(isPublicAddress(address), address).toBe(false);
    for (const endpoint of ['https://[::127.0.0.1]/v1', 'https://[::7f00:1]/v1', 'https://[::1.2.3.4]/v1', 'https://llm.example.com/v1?', 'https://llm.example.com/v1#'])
      expect(isPublicEndpoint(endpoint), endpoint).toBe(false);
  });

  it('code LOW: an empty-body answer (204, 205, 304, HEAD) is a Response with no body, and its socket is drained', async () => {
    const { Readable } = await import('node:stream');
    const { toResponse } = await import('../src/agent/providers/public-fetch.js');
    for (const [status, method] of [[204, 'POST'], [205, 'POST'], [304, 'GET'], [200, 'HEAD']] as const) {
      const res = Object.assign(Readable.from(['left over']), { statusCode: status, statusMessage: '', headers: { 'set-cookie': ['a=1', 'b=2'] } });
      const response = toResponse(res as never, method);
      expect(response.status).toBe(status); expect(response.body).toBeNull(); expect(response.headers.get('set-cookie')).toBe('a=1, b=2');
      // Drained: the stream flows to its end instead of holding the keep-alive socket.
      await new Promise(done => res.once('end', done));
    }
    const ok = Object.assign(Readable.from(['{"x":1}']), { statusCode: 200, statusMessage: 'OK', headers: {} });
    expect(await toResponse(ok as never, 'POST').json()).toEqual({ x: 1 });
  });
});
