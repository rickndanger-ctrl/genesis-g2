import { afterEach, describe, expect, it, vi } from 'vitest';
import { HTTPGateway } from '../src/api';
import { canonicalEvenOrigin, OriginRecovery, ORIGIN_RECOVERY_KEY } from '../src/origin-recovery';
import type { Host } from '../src/types';

const host: Host = { id: 'one', name: 'One', baseURL: 'https://one.example.test', token: 'first-fixture-token' };
const second: Host = { id: 'two', name: 'Two', baseURL: 'https://two.example.test', token: 'second-fixture-token' };
const signal = () => new AbortController().signal;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const until = async (condition: () => boolean) => { for (let index = 0; index < 100 && !condition(); index++) await tick(); expect(condition()).toBe(true); };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };
afterEach(() => vi.restoreAllMocks());
function setup() {
  let origin = 'http://127.0.0.1:51001'; let native = true; let hosts = [host, second]; let now = Date.now();
  const data = new Map<string, string>();
  const bridge = { getLocalStorage: vi.fn(async (key: string) => data.get(key) ?? ''), setLocalStorage: vi.fn(async (key: string, value: string) => { data.set(key, value); return true; }) };
  const calls: { host: string; path: string; method: string; auth: string; body: Record<string, string> | null }[] = [];
  const allowed = new Set([`${host.baseURL}|${origin}`, `${second.baseURL}|${origin}`]); const credentials = new Map<string, string>(); let lostOpen = false;
  const fetcher = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input)); const method = options?.method ?? 'GET'; const auth = new Headers(options?.headers).get('authorization') ?? ''; const body = options?.body ? JSON.parse(String(options.body)) : null;
    calls.push({ host: url.origin, path: url.pathname, method, auth, body });
    expect(url.search).not.toContain('secret'); expect(url.hash).toBe(''); expect(options?.redirect).toBe('error'); expect(options?.credentials).toBe('omit');
    const key = `${url.origin}|${auth}|${body?.installationID}`;
    if (url.pathname.endsWith('/enroll')) {
      if (!allowed.has(`${url.origin}|${origin}`)) throw new TypeError('CORS');
      const stored = JSON.parse(data.get(ORIGIN_RECOVERY_KEY) ?? '{}');
      expect(Object.values(stored.hosts ?? {})).toContainEqual(expect.objectContaining(body));
      credentials.set(key, body.secret);
      return Response.json({ ok: true, version: 1, expiresAt: new Date(now + 90 * 86400000).toISOString() });
    }
    if (url.pathname.endsWith('/renew')) {
      if (credentials.get(key) !== body.secret) return Response.json({ error: { code: 'recovery_not_paired' } }, { status: 401 });
      allowed.add(`${url.origin}|${origin}`); return Response.json({ ok: true, version: 1, expiresAt: new Date(now + 90 * 86400000).toISOString() });
    }
    if (!allowed.has(`${url.origin}|${origin}`)) throw new TypeError('CORS');
    if (url.pathname === '/api/open') {
      if (lostOpen) throw new TypeError('response lost after action');
      return Response.json({ ok: true, status: 'confirmed', chat: { id: body.chatID, title: 'Fixture' } });
    }
    return Response.json({ host: { id: url.origin, name: 'Fixture' }, version: 'fixture', providers: [{ id: 'codex', label: 'Codex', available: true, canReadReply: true }] });
  });
  const make = () => new OriginRecovery({ nativeAvailable: () => native, origin: () => origin, hosts: () => hosts, fetcher, now: () => now, timeoutMs: 25 });
  return { bridge, data, calls, allowed, credentials, fetcher, make, setOrigin: (value: string) => { origin = value; }, setNative: (value: boolean) => { native = value; }, setHosts: (value: Host[]) => { hosts = value; }, advance: (value: number) => { now += value; }, setLostOpen: () => { lostOpen = true; } };
}
async function enrolled(f: ReturnType<typeof setup>, paired = host) {
  const recovery = f.make(); expect(await recovery.bindBridge(f.bridge)).toBe(true);
  const api = new HTTPGateway(f.fetcher, recovery); await api.status(paired, signal()); await recovery.afterStatus(paired, signal());
  return { recovery, api };
}

describe('native package origin recovery', () => {
  it('stores a UUID and 256-bit secret durably before enrollment, without duplicating bearer tokens', async () => {
    const f = setup(); await enrolled(f);
    const stored = f.data.get(ORIGIN_RECOVERY_KEY)!; const entries = Object.values(JSON.parse(stored).hosts) as { binding: string; installationID: string; secret: string }[];
    expect(entries).toHaveLength(1); expect(entries[0].binding).toMatch(/^[0-9a-f]{64}$/); expect(entries[0].installationID).toMatch(/^[0-9a-f-]{36}$/); expect(entries[0].secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stored).not.toContain(host.token); expect(stored).not.toContain(host.baseURL);
    expect(f.bridge.getLocalStorage).toHaveBeenCalledWith(ORIGIN_RECOVERY_KEY); expect(f.bridge.setLocalStorage).toHaveBeenCalledTimes(1);
    expect(f.calls.filter(call => call.path.endsWith('/enroll'))).toHaveLength(1);
  });
  it('recovers a changed Even port across a fresh client using the same native credential', async () => {
    const f = setup(); await enrolled(f); const first = f.calls.find(call => call.path.endsWith('/enroll'))!;
    f.setOrigin('http://127.0.0.1:51002'); const recovery = f.make(); await recovery.bindBridge(f.bridge);
    const api = new HTTPGateway(f.fetcher, recovery); await expect(api.status(host, signal())).resolves.toMatchObject({ host: { id: host.baseURL } }); await recovery.afterStatus(host, signal());
    const renew = f.calls.find(call => call.path.endsWith('/renew'))!; expect(renew.body).toEqual(first.body); expect(f.bridge.setLocalStorage).toHaveBeenCalledTimes(1);
    expect(f.calls.filter(call => call.path.endsWith('/enroll'))).toHaveLength(1);
  });
  it('uses independent host secrets and bearer credentials, and renews stable origins periodically', async () => {
    const f = setup(); const { recovery, api } = await enrolled(f); await api.status(second, signal()); await recovery.afterStatus(second, signal());
    const enrollment = f.calls.filter(call => call.path.endsWith('/enroll')); expect(enrollment).toHaveLength(2); expect(enrollment[0].body?.secret).not.toBe(enrollment[1].body?.secret);
    expect(enrollment.map(call => call.auth)).toEqual([`Bearer ${host.token}`, `Bearer ${second.token}`]);
    for (let index = 0; index < 5; index++) await api.status(host, signal()); await tick(); expect(f.calls.filter(call => call.path.endsWith('/renew'))).toHaveLength(0);
    f.advance(86400001); await api.status(host, signal()); expect(f.calls.filter(call => call.path.endsWith('/renew'))).toHaveLength(1); expect(f.bridge.setLocalStorage).toHaveBeenCalledTimes(2);
  });
  it('does not recover or enroll before native binding, or from ordinary browser storage', async () => {
    const f = setup(); const recovery = f.make(); const api = new HTTPGateway(f.fetcher, recovery);
    await api.status(host, signal()); await recovery.afterStatus(host, signal()); expect(f.calls.some(call => call.path.includes('origin-recovery'))).toBe(false);
    f.setNative(false); expect(await recovery.bindBridge(f.bridge)).toBe(false); expect(f.bridge.getLocalStorage).not.toHaveBeenCalled();
    f.setOrigin('http://127.0.0.1:51002'); await expect(api.status(host, signal())).rejects.toMatchObject({ code: 'unreachable' });
    expect(f.calls.some(call => call.path.includes('origin-recovery'))).toBe(false);
  });
  it.each(['false-write', 'missing-readback', 'failed-readback'])('does not enroll without native persistence proof: %s', async kind => {
    const f = setup(); const recovery = f.make(); await recovery.bindBridge(f.bridge);
    if (kind === 'false-write') f.bridge.setLocalStorage.mockResolvedValue(false);
    if (kind === 'missing-readback') f.bridge.getLocalStorage.mockResolvedValue('');
    if (kind === 'failed-readback') f.bridge.getLocalStorage.mockResolvedValueOnce('').mockRejectedValue(new Error('unavailable'));
    const api = new HTTPGateway(f.fetcher, recovery); await api.status(host, signal()); await recovery.afterStatus(host, signal());
    for (let index = 0; index < 5; index++) { await api.status(host, signal()); await recovery.afterStatus(host, signal()); }
    expect(f.calls.some(call => call.path.includes('origin-recovery'))).toBe(false); expect(f.bridge.setLocalStorage).toHaveBeenCalledTimes(1);
  });
  it('quarantines a timed-out native write until its raw result settles, then preserves both hosts', async () => {
    const f = setup(); const recovery = f.make(); await recovery.bindBridge(f.bridge);
    const held = deferred<boolean>(); let pendingValue = '';
    f.bridge.setLocalStorage.mockImplementationOnce(async (key, value) => { pendingValue = value; await held.promise; f.data.set(key, value); return true; });
    await recovery.afterStatus(host, signal()); expect(pendingValue).not.toBe('');
    await recovery.afterStatus(second, signal()); expect(f.bridge.setLocalStorage).toHaveBeenCalledTimes(1);
    expect(f.calls).toHaveLength(0);
    // The manual connection remains usable while durable storage is unknown.
    const api = new HTTPGateway(f.fetcher, recovery); await expect(api.status(host, signal())).resolves.toBeTruthy();
    held.resolve(true); await until(() => f.data.has(ORIGIN_RECOVERY_KEY)); await tick();
    f.advance(31000); await recovery.afterStatus(second, signal()); await recovery.afterStatus(host, signal());
    const persisted = Object.values(JSON.parse(f.data.get(ORIGIN_RECOVERY_KEY)!).hosts);
    expect(persisted).toHaveLength(2); expect(f.bridge.setLocalStorage).toHaveBeenCalledTimes(2);
    expect(persisted).toContainEqual(Object.values(JSON.parse(pendingValue).hosts)[0]);
    expect(f.calls.filter(call => call.path.endsWith('/enroll'))).toHaveLength(2);
  });
  it('adopts the durable readback when the SDK loses its write acknowledgment', async () => {
    const f = setup(); f.bridge.setLocalStorage.mockImplementationOnce(async (key, value) => { f.data.set(key, value); throw new Error('acknowledgment lost'); });
    await enrolled(f); expect(f.bridge.setLocalStorage).toHaveBeenCalledTimes(1); expect(f.calls.filter(call => call.path.endsWith('/enroll'))).toHaveLength(1);
  });
  it('finishes status enrollment after its caller completes and aborts the probe signal', async () => {
    const f = setup(); const recovery = f.make(); await recovery.bindBridge(f.bridge);
    const held = deferred<boolean>(); const original = f.bridge.setLocalStorage.getMockImplementation()!;
    f.bridge.setLocalStorage.mockImplementationOnce(async (key, value) => { await held.promise; return original(key, value); });
    const controller = new AbortController(); const api = new HTTPGateway(f.fetcher, recovery);
    await api.status(host, controller.signal); controller.abort();
    await until(() => f.bridge.setLocalStorage.mock.calls.length === 1); held.resolve(true);
    await until(() => f.calls.some(call => call.path.endsWith('/enroll')));
    expect(f.calls.map(call => call.path)).toEqual(['/api/status', '/api/origin-recovery/enroll']);
  });
  it('does not enroll detached maintenance after its pairing is removed', async () => {
    const f = setup(); const recovery = f.make(); await recovery.bindBridge(f.bridge);
    const held = deferred<boolean>(); const original = f.bridge.setLocalStorage.getMockImplementation()!;
    f.bridge.setLocalStorage.mockImplementationOnce(async (key, value) => { await held.promise; return original(key, value); });
    const api = new HTTPGateway(f.fetcher, recovery); await api.status(host, signal());
    await until(() => f.bridge.setLocalStorage.mock.calls.length === 1); f.setHosts([second]); held.resolve(true); await tick(); await tick();
    expect(f.calls.some(call => call.path.includes('origin-recovery'))).toBe(false);
  });
  it('warms every paired Mac without switching UI routes or issuing commands', async () => {
    const f = setup(); const recovery = f.make(); await recovery.bindBridge(f.bridge); const api = new HTTPGateway(f.fetcher, recovery);
    await recovery.warmPairedHosts(api);
    expect(f.calls.filter(call => call.path.endsWith('/enroll')).map(call => call.host).sort()).toEqual([host.baseURL, second.baseURL]);
    expect(f.calls.every(call => ['/api/status', '/api/origin-recovery/enroll'].includes(call.path))).toBe(true);
    expect(Object.keys(JSON.parse(f.data.get(ORIGIN_RECOVERY_KEY)!).hosts)).toHaveLength(2);
  });
  it('bounds an offline warmup while enrolling the other paired Mac', async () => {
    const f = setup(); const recovery = f.make(); await recovery.bindBridge(f.bridge); const api = new HTTPGateway(f.fetcher, recovery);
    const status = { status: vi.fn((paired: Host, requestSignal: AbortSignal) => paired.id === host.id ? new Promise<never>(() => {}) : api.status(paired, requestSignal)) };
    await recovery.warmPairedHosts(status);
    expect(f.calls.filter(call => call.path.endsWith('/enroll')).map(call => call.host)).toEqual([second.baseURL]);
  });
  it('enrolls a saved but never-enrolled credential after a trusted status response', async () => {
    const f = setup(); await enrolled(f); f.credentials.clear(); const saved = f.data.get(ORIGIN_RECOVERY_KEY);
    const recovery = f.make(); await recovery.bindBridge(f.bridge); const api = new HTTPGateway(f.fetcher, recovery);
    await api.status(host, signal()); await recovery.afterStatus(host, signal());
    expect(f.calls.slice(-3).map(call => call.path)).toEqual(['/api/origin-recovery/renew', '/api/status', '/api/origin-recovery/enroll']);
    expect(f.data.get(ORIGIN_RECOVERY_KEY)).toBe(saved); expect(f.bridge.setLocalStorage).toHaveBeenCalledTimes(1);
  });
  it('coalesces concurrent reads into one renewal per host', async () => {
    const f = setup(); await enrolled(f); f.setOrigin('http://127.0.0.1:51002'); const recovery = f.make(); await recovery.bindBridge(f.bridge);
    const api = new HTTPGateway(f.fetcher, recovery); await Promise.all(Array.from({ length: 12 }, () => api.status(host, signal())));
    expect(f.calls.filter(call => call.path.endsWith('/renew'))).toHaveLength(1);
  });
  it('retries a denied GET at most once and never replays a POST with a lost response', async () => {
    const f = setup(); const { recovery, api } = await enrolled(f); f.advance(31000); f.allowed.clear();
    const before = f.calls.length; await api.status(host, signal()); expect(f.calls.slice(before).map(call => call.path)).toEqual(['/api/status', '/api/origin-recovery/renew', '/api/status']);
    f.setLostOpen(); await expect(api.open(host, 'codex', { id: 'fixture-chat', title: 'Fixture' }, 1, signal())).rejects.toMatchObject({ code: 'unreachable' });
    expect(f.calls.filter(call => call.path === '/api/open')).toHaveLength(1); await recovery.afterStatus(host, signal());
  });
  it('binds a credential to the pairing token and never uses the old secret after rotation', async () => {
    const f = setup(); await enrolled(f); const old = f.calls.find(call => call.path.endsWith('/enroll'))!.body;
    const rotated = { ...host, token: 'rotated-fixture-token' }; f.setHosts([rotated]); const recovery = f.make(); await recovery.bindBridge(f.bridge);
    const api = new HTTPGateway(f.fetcher, recovery); await api.status(rotated, signal()); await recovery.afterStatus(rotated, signal());
    const newCall = f.calls.filter(call => call.path.endsWith('/enroll')).at(-1)!; expect(newCall.body).not.toEqual(old); expect(newCall.auth).toBe(`Bearer ${rotated.token}`);
    expect(f.calls.filter(call => call.path.endsWith('/renew'))).toHaveLength(0); expect(Object.keys(JSON.parse(f.data.get(ORIGIN_RECOVERY_KEY)!).hosts)).toHaveLength(1);
  });
  it('handles old servers gracefully and backs off repeated offline renewals', async () => {
    const f = setup(); await enrolled(f); const recovery = f.make(); await recovery.bindBridge(f.bridge);
    const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (input, init) => String(input).includes('/origin-recovery/') ? new Response('Not found', { status: 404 }) : original(input, init));
    const api = new HTTPGateway(f.fetcher, recovery); await api.status(host, signal()); await recovery.afterStatus(host, signal());
    const recoveryCalls = () => f.fetcher.mock.calls.filter(call => String(call[0]).includes('/origin-recovery/')).length;
    expect(recoveryCalls()).toBe(2); // The original enrollment plus one unavailable renewal.
    for (let index = 0; index < 8; index++) { await api.status(host, signal()); await recovery.afterStatus(host, signal()); }
    expect(recoveryCalls()).toBe(2);
    f.advance(300001); f.fetcher.mockImplementation(async () => { throw new TypeError('offline'); });
    await expect(api.status(host, signal())).rejects.toMatchObject({ code: 'unreachable' }); const failedCalls = recoveryCalls();
    await expect(api.status(host, signal())).rejects.toMatchObject({ code: 'unreachable' }); expect(recoveryCalls()).toBe(failedCalls);
  });
  it('honors abort without issuing the old GET, while another recovery waiter can continue', async () => {
    const f = setup(); await enrolled(f); f.setOrigin('http://127.0.0.1:51002'); const recovery = f.make(); await recovery.bindBridge(f.bridge);
    const original = f.fetcher.getMockImplementation()!; const held = deferred<Response>(); let started = false;
    f.fetcher.mockImplementation(async (input, init) => { if (String(input).endsWith('/renew')) { started = true; await held.promise; } return original(input, init); });
    const api = new HTTPGateway(f.fetcher, recovery); const cancel = new AbortController(); const first = api.status(host, cancel.signal); const firstResult = first.catch(error => error); const secondRead = api.status(host, signal());
    for (let index = 0; index < 30 && !started; index++) await tick(); expect(started).toBe(true); cancel.abort(); expect((await firstResult).name).toBe('AbortError');
    const before = f.calls.filter(call => call.path === '/api/status').length; held.resolve(Response.json({})); await secondRead;
    expect(f.calls.filter(call => call.path === '/api/status')).toHaveLength(before + 1);
  });
  it('bounds native/network waits even when an implementation ignores abort', async () => {
    const f = setup(); const never = new Promise<string>(() => {}); f.bridge.getLocalStorage.mockReturnValueOnce(never);
    expect(await f.make().bindBridge(f.bridge)).toBe(false);
    const { recovery } = await enrolled(f); f.advance(86400001); f.fetcher.mockImplementation(() => new Promise<Response>(() => {}));
    await expect(recovery.beforeRequest(host, signal())).resolves.toBe(false);
    const cancel = new AbortController(); cancel.abort(); await expect(recovery.beforeRequest(host, cancel.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('does not dispatch renewal when aborted during its final identity hash', async () => {
    const f = setup(); await enrolled(f); const recovery = f.make(); await recovery.bindBridge(f.bridge); f.setOrigin('http://127.0.0.1:51002');
    const original = crypto.subtle.digest.bind(crypto.subtle); const held = deferred<ArrayBuffer>(); let count = 0;
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => { count++; if (count === 5) return held.promise; return original(...args); });
    const controller = new AbortController(); const pending = recovery.beforeRequest(host, controller.signal).catch(error => error);
    await until(() => count === 5); controller.abort(); held.resolve(new ArrayBuffer(32));
    expect((await pending).name).toBe('AbortError'); await tick();
    expect(f.calls.filter(call => call.path.endsWith('/renew'))).toHaveLength(0);
  });
  it.each(['https://example.test', 'http://localhost:51001', 'http://127.0.0.1:80', 'http://127.0.0.1:05100', 'http://127.0.0.1:65536', 'http://127.0.0.1:51001/path'])('never attempts automatic recovery for a noncanonical origin: %s', async origin => {
    const f = setup(); f.setOrigin(origin); const recovery = f.make(); await recovery.bindBridge(f.bridge); await recovery.afterStatus(host, signal()); expect(f.calls).toHaveLength(0); expect(f.bridge.setLocalStorage).not.toHaveBeenCalled(); expect(canonicalEvenOrigin(origin)).toBe(false);
  });
});
