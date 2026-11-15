import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createBridge } from '../bridge/server.mjs';
import { HTTPGateway } from '../src/api';
import { OriginRecovery } from '../src/origin-recovery';
import type { Host } from '../src/types';

const actualFetch = globalThis.fetch.bind(globalThis);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const firstOrigin = 'http://127.0.0.1:51001';
const chatID = '11111111-1111-4111-8111-111111111111';

async function fixture(label: string) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'genesis-origin-integration-')));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const token = 'fixture-only-paired-token-' + label.padEnd(40, 'x');
  let commands = 0;
  const config = { token, name: label, allowedOrigins: [firstOrigin], originRecoveryPath: join(directory, 'origin-recovery.json') };
  const deps = { upstreamToken: 'fixture-upstream', fetch: async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/v1/status') return Response.json({ hostID: '33333333-3333-4333-8333-333333333333', hostName: label,
      providers: [{ id: 'codex', name: 'Codex', readiness: 'ready', capabilities: ['openChat'] }] });
    if (path === '/v1/chats') return Response.json({ chats: [{ id: chatID, title: 'Fixture chat' }] });
    if (path === '/v1/commands') { commands++; return Response.json({ status: 'confirmed' }); }
    throw Error('Unexpected fixture endpoint');
  } };
  let server: Server;
  const listen = async (port = 0) => {
    server = createBridge(config, deps);
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    return (server.address() as { port: number }).port;
  };
  const stop = async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); };
  const port = await listen();
  cleanups.push(stop);
  const baseURL = `http://127.0.0.1:${port}`;
  const host: Host = { id: baseURL, name: label, baseURL, token };
  return { host, commandCount: () => commands, restart: async () => { await stop(); await listen(port); } };
}

// A browser blocks the actual request when its CORS preflight fails. Enforce
// that boundary against the real HTTP bridge, not a mocked success response.
function browserFetch(origin: () => string, lostOpen?: { once: boolean }): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const method = init.method ?? 'GET';
    const preflight = await actualFetch(input, { method: 'OPTIONS', signal: init.signal,
      headers: { Origin: origin(), 'Access-Control-Request-Method': method,
        'Access-Control-Request-Headers': [...headers.keys()].filter(k => k !== 'accept').join(', ') } });
    if (!preflight.ok || preflight.headers.get('access-control-allow-origin') !== origin()) throw new TypeError('Blocked by fixture browser CORS');
    headers.set('Origin', origin());
    const response = await actualFetch(input, { ...init, headers });
    if (response.headers.get('access-control-allow-origin') !== origin()) throw new TypeError('Blocked response');
    if (new URL(String(input)).pathname === '/api/open' && lostOpen?.once) { lostOpen.once = false; throw new TypeError('Fixture dropped response after execution'); }
    return response;
  }) as typeof fetch;
}
function nativeStorage() {
  const values = new Map<string, string>();
  return { getLocalStorage: async (key: string) => values.get(key) ?? '',
    setLocalStorage: async (key: string, value: string) => { values.set(key, value); return true; } };
}
async function client(hosts: Host[], origin: () => string, storage: ReturnType<typeof nativeStorage>, lostOpen?: { once: boolean }) {
  const fetcher = browserFetch(origin, lostOpen);
  const recovery = new OriginRecovery({ nativeAvailable: () => true, origin, hosts: () => hosts, fetcher });
  await recovery.bindBridge(storage);
  return { gateway: new HTTPGateway(fetcher, recovery), recovery };
}

describe('real bridge and native-backed origin recovery', () => {
  it('recovers both Macs after an Even origin change and after both bridge restarts', async () => {
    const mini1 = await fixture('Mini 1'), mini2 = await fixture('Mini 2');
    const hosts = [mini1.host, mini2.host], storage = nativeStorage();
    let origin = firstOrigin;
    let { gateway, recovery } = await client(hosts, () => origin, storage);
    for (const host of hosts) { expect((await gateway.status(host, new AbortController().signal)).host.name).toBe(host.name); await recovery.afterStatus(host, new AbortController().signal); }
    origin = 'http://127.0.0.1:51002';
    ({ gateway, recovery } = await client(hosts, () => origin, storage));
    for (const host of hosts) expect((await gateway.status(host, new AbortController().signal)).host.name).toBe(host.name);
    await mini1.restart(); await mini2.restart();
    origin = 'http://127.0.0.1:51003';
    ({ gateway, recovery } = await client(hosts, () => origin, storage));
    for (const host of hosts) expect((await gateway.status(host, new AbortController().signal)).host.name).toBe(host.name);
    expect(mini1.commandCount() + mini2.commandCount()).toBe(0);
  });

  it('does not replay a chat-open command when its successful response is lost', async () => {
    const mac = await fixture('No duplicate opens'), storage = nativeStorage();
    const lost = { once: true };
    const { gateway, recovery } = await client([mac.host], () => firstOrigin, storage, lost);
    await gateway.status(mac.host, new AbortController().signal);
    await recovery.afterStatus(mac.host, new AbortController().signal);
    await expect(gateway.open(mac.host, 'codex', { id: chatID, title: 'Fixture chat' }, undefined, new AbortController().signal)).rejects.toBeDefined();
    expect(mac.commandCount()).toBe(1);
  });
});
