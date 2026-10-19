import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { isEndpoint } from './validate.js';

// A custom OpenAI-compatible endpoint (Part A): https to a host on the public internet only. Its key must never reach this
// machine, your network or a cloud's metadata service, so loopback, private, link-local, shared (CGNAT, which tailnets
// use), multicast, documentation and reserved ranges are refused: in the address typed and in every address its name
// resolves to, checked again right before each connection (a name can change its answer between two lookups).
const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const) blocked.addSubnet(address, prefix, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  // An IPv4 address written inside IPv6 (::ffff:10.0.0.1, ::10.0.0.1) is refused whatever it carries: a public host's
  // name resolves to plain IPv4 or IPv6, and the mixed forms are how a private address gets past a check.
  // (BlockList itself matches every IPv4 address against an IPv4-mapped IPv6 rule, so ::ffff:0:0/96 can't be a rule.)
  if (family === 6 && (/\d+\.\d+\.\d+\.\d+$/.test(address) || /^::ffff:/i.test(address))) return false;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}
// The host of an endpoint as written: an address must be public; a name must not be one that always means this machine
// or a local network. What a name resolves to is checked by publicLookup at connection time.
const LOCAL_NAMES = /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa|in-addr\.arpa|ip6\.arpa)$/i;
export function isPublicEndpoint(v: unknown): v is string {
  if (!isEndpoint(v)) return false;
  const url = new URL(v), host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.port !== '' && url.port !== '443') return false;
  if (isIP(host)) return isPublicAddress(host);
  return host.includes('.') && !LOCAL_NAMES.test(host.replace(/\.$/, ''));
}
export class PrivateAddressError extends Error { readonly code = 'EPRIVATEADDRESS'; constructor() { super('The endpoint resolves to an address that is not on the public internet'); } }
type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
export type Resolver = (hostname: string, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;
const systemResolver: Resolver = (hostname, callback) => dnsLookup(hostname, { all: true, verbatim: true }, callback);
// A `lookup` for net/tls connections: every address the name resolves to must be public, or the connection is refused
// before it opens; the socket then connects to exactly the addresses that were checked.
export function publicLookup(resolve: Resolver = systemResolver) {
  return (hostname: string, options: { all?: boolean } | number, callback: LookupCallback): void => {
    resolve(hostname, (error, addresses) => {
      if (error) { callback(error, []); return; }
      if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) { callback(new PrivateAddressError(), []); return; }
      const all = typeof options === 'object' && options.all === true, first = addresses[0];
      if (all) callback(null, addresses);
      else if (first) callback(null, first.address, first.family);
    });
  };
}
