import { describe, expect, it, vi } from 'vitest';
import { ControllerStore } from '../src/store';
import { HTTPGateway, normalizeBaseURL } from '../src/api';
import { HostStorage, parsePairingFragment } from '../src/storage';
import { gestureFor, glassesFrame, GlassesController, GlassesRenderer, pageFor } from '../src/glasses';
import { replyPages, truncateUTF8 } from '../src/pagination';
import { ConnectionDiagnostics } from '../src/diagnostics';
import type { Gateway, Host, HostStatus, Reply } from '../src/types';

const host: Host = { id: 'h1', name: 'Mini 1', baseURL: 'https://mini1.example.test', token: 'test-token-not-real' };
const host2: Host = { id: 'h2', name: 'Mini 2', baseURL: 'https://mini2.example.test', token: 'test-token-2-not-real' };
const status: HostStatus = { host: { id: 'h1', name: 'Mini 1' }, version: 'test', providers: [{ id: 'codex', label: 'Codex', available: true, canReadReply: true }, { id: 'claude', label: 'Claude', available: true, canReadReply: true }] };
const reply = (id = 'one', text = 'Reply one'): Reply => ({ provider: 'codex', chatID: id, title: id, text, revision: text, updatedAt: null, status: 'unknown', truncated: false });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (value: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fake(): Gateway {
  return { status: vi.fn(async () => status), profile: vi.fn(async (_h, provider) => ({ provider, slots: [{ slot: 1, label: 'One', chatID: 'one', kind: 'chat' }, { slot: 2, label: 'Two', chatID: 'two', kind: 'chat' }] })), chats: vi.fn(async (_h, provider) => ({ provider, chats: [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }] })), open: vi.fn(async (_h, _p, chat) => ({ ok: true, chat, status: 'requested' })), reply: vi.fn(async (_h, provider, id) => ({ ...reply(id), provider })) };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function bridgeFixture() {
  let deviceListener: ((status: unknown) => void) | null = null;
  const connected = { connectType: 'connected', isConnected: () => true };
  const disconnected = { connectType: 'disconnected', isConnected: () => false };
  const bridge = { getDeviceInfo: vi.fn(async () => ({ status: connected })), onEvenHubEvent: vi.fn(() => () => {}), onDeviceStatusChanged: vi.fn((listener: (status: unknown) => void) => { deviceListener = listener; return () => {}; }), createStartUpPageContainer: vi.fn(async () => 0), rebuildPageContainer: vi.fn(async () => true), textContainerUpgrade: vi.fn(async () => true) };
  return { bridge, disconnected, disconnect: () => deviceListener?.(disconnected) };
}

describe('native connection diagnostics', () => {
  it('never treats the SDK JavaScript object in an ordinary browser as native connection', async () => {
    const fixture = bridgeFixture(); const resolver = vi.fn(async () => fixture.bridge as never); const statuses = vi.fn();
    const controller = new GlassesController(new ControllerStore(fake()), statuses, undefined, () => {}, resolver, () => false);
    await controller.connect();
    expect(resolver).not.toHaveBeenCalled(); expect(fixture.bridge.createStartUpPageContainer).not.toHaveBeenCalled();
    expect(statuses.mock.calls.at(-1)?.[0]).toContain('browser'); expect(statuses.mock.calls.some(call => call[1] === true)).toBe(false);
  });
  it('native transport plus missing metadata connects only after actual page acknowledgment', async () => {
    const fixture = bridgeFixture(); fixture.bridge.getDeviceInfo.mockResolvedValue(null as never);
    const ack = deferred<number>(); fixture.bridge.createStartUpPageContainer.mockImplementationOnce(() => ack.promise);
    const statuses = vi.fn(); const controller = new GlassesController(new ControllerStore(fake()), statuses, undefined, () => {}, async () => fixture.bridge as never, () => true);
    await controller.connect(); expect(statuses.mock.calls.some(call => call[1] === true)).toBe(false);
    ack.resolve(0); await tick(); expect(statuses.mock.calls.at(-1)).toEqual(['Glasses page connected', true]);
  });
  it('an explicit disconnect during metadata lookup cannot be overwritten by stale metadata', async () => {
    const fixture = bridgeFixture(); const metadata = deferred<unknown>(); fixture.bridge.getDeviceInfo.mockImplementationOnce(() => metadata.promise as never);
    const statuses = vi.fn(); const controller = new GlassesController(new ControllerStore(fake()), statuses, undefined, () => {}, async () => fixture.bridge as never, () => true);
    const connect = controller.connect(); await tick(); fixture.disconnect(); metadata.resolve(null); await connect;
    expect(fixture.bridge.createStartUpPageContainer).not.toHaveBeenCalled(); expect(statuses.mock.calls.some(call => call[1] === true)).toBe(false);
  });
  it('a delayed page acknowledgment after explicit disconnect cannot report connected', async () => {
    const fixture = bridgeFixture(); const ack = deferred<number>(); fixture.bridge.createStartUpPageContainer.mockImplementationOnce(() => ack.promise);
    const statuses = vi.fn(); const controller = new GlassesController(new ControllerStore(fake()), statuses, undefined, () => {}, async () => fixture.bridge as never, () => true);
    await controller.connect(); fixture.disconnect(); ack.resolve(0); await tick();
    expect(statuses.mock.calls.some(call => call[1] === true)).toBe(false); expect(statuses.mock.calls.at(-1)?.[0]).toContain('disconnected');
  });
  it('disconnected metadata invalidates an already mounted renderer on reconnect', async () => {
    const fixture = bridgeFixture(); const statuses = vi.fn(); const store = new ControllerStore(fake(), [host]);
    const controller = new GlassesController(store, statuses, undefined, () => {}, async () => fixture.bridge as never, () => true);
    store.subscribe(state => controller.render(state)); await controller.connect(); await tick(); statuses.mockClear();
    fixture.bridge.getDeviceInfo.mockResolvedValue({ status: fixture.disconnected } as never);
    await controller.connect(); await store.refresh(); await tick();
    expect(statuses.mock.calls.some(call => call[1] === true)).toBe(false); expect(fixture.bridge.rebuildPageContainer).not.toHaveBeenCalled();
  });
  it('create code1 gets one rebuild recovery and false recovery never reports connected', async () => {
    const fixture = bridgeFixture(); fixture.bridge.createStartUpPageContainer.mockResolvedValue(1); fixture.bridge.rebuildPageContainer.mockResolvedValue(false);
    const statuses = vi.fn(); const records = vi.fn(); const controller = new GlassesController(new ControllerStore(fake()), statuses, undefined, records, async () => fixture.bridge as never, () => true);
    await controller.connect(); await tick();
    expect(fixture.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1); expect(fixture.bridge.rebuildPageContainer).toHaveBeenCalledTimes(1);
    expect(records).toHaveBeenCalledWith('page_ack', expect.objectContaining({ phase: 1, ack: 1 }));
    expect(records).toHaveBeenCalledWith('page_ack', expect.objectContaining({ phase: 2, ack: 0 }));
    expect(statuses.mock.calls.some(call => call[1] === true)).toBe(false);
  });
  it('diagnostics retain a numeric-only bounded ring and upload at most32 rows per batch', async () => {
    const calls: string[] = []; const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => { calls.push(String(init.body)); return new Response('{"ok":true}'); });
    const diagnostics = new ConnectionDiagnostics(() => host, fetcher as typeof fetch, '00000000-0000-4000-8000-000000000001');
    for (let i = 0; i < 140; i++) diagnostics.record('input', { sequence: i, containerID: 4, token: host.token, message: 'private dictated sentence', status: 'connected' } as never);
    expect(diagnostics.snapshot().events).toHaveLength(128); await diagnostics.flush(); diagnostics.dispose();
    expect(calls).toHaveLength(4);
    for (const body of calls) { expect(JSON.parse(body).events.length).toBeLessThanOrEqual(32); expect(body).not.toContain(host.token); expect(body).not.toContain('private dictated'); expect(body).not.toContain('"status"'); }
  });
});

describe('chat route isolation', () => {
  it('discards an old computer response that arrives after switching computers', async () => {
    const api = fake(); const old = deferred<HostStatus>();
    vi.mocked(api.status).mockImplementationOnce(() => old.promise);
    const store = new ControllerStore(api, [host, host2]);
    const first = store.refresh(); await store.setHost('h2');
    old.resolve({ ...status, host: { id: 'stale', name: 'Wrong computer' } }); await first;
    expect(store.host?.id).toBe('h2'); expect(store.state.status?.host.id).toBe('h1');
    expect(api.profile).toHaveBeenCalledTimes(1);
  });
  it('serializes opens and never paints an earlier reply on a later chat', async () => {
    const api = fake(); const opening = deferred<Awaited<ReturnType<Gateway['open']>>>();
    vi.mocked(api.open).mockImplementationOnce(() => opening.promise);
    const store = new ControllerStore(api, [host]); await store.refresh();
    const first = store.openSlot(1); await tick();
    const second = store.openSlot(2); await tick();
    expect(api.open).toHaveBeenCalledTimes(1);
    opening.resolve({ ok: true, chat: { id: 'one', title: 'One' }, status: 'confirmed' });
    await Promise.all([first, second]);
    expect(api.open).toHaveBeenCalledTimes(2); expect(api.reply).toHaveBeenCalledTimes(1);
    expect(store.state.selected?.id).toBe('two'); expect(store.state.reply?.chatID).toBe('two');
    expect(store.state.openStatus).toBe('requested');
  });
  it('ignores an old in-flight reply after switching agents, even if fetch ignores abort', async () => {
    const api = fake(); const old = deferred<Reply>(); vi.mocked(api.reply).mockImplementationOnce(() => old.promise);
    const store = new ControllerStore(api, [host]); await store.refresh();
    const open = store.openSlot(1); await tick();
    await store.setProvider('claude'); old.resolve(reply()); await open;
    expect(store.state.provider).toBe('claude'); expect(store.state.reply).toBeNull(); expect(store.state.selected).toBeNull(); expect(store.state.busy).toBe(false);
  });
  it('a slow earlier reply does not block a new open, and cannot replace the newer reply', async () => {
    const api = fake(); const old = deferred<Reply>(); vi.mocked(api.reply).mockImplementationOnce(() => old.promise);
    const store = new ControllerStore(api, [host]); await store.refresh();
    const first = store.openSlot(1); await tick();
    await store.openSlot(2);
    expect(store.state.reply?.chatID).toBe('two'); expect(api.open).toHaveBeenCalledTimes(2);
    old.resolve(reply('one', 'Late reply')); await first;
    expect(store.state.reply?.chatID).toBe('two'); expect(store.state.reply?.text).not.toBe('Late reply');
  });
  it('rejects a reply with a different chat identity', async () => {
    const api = fake(); vi.mocked(api.reply).mockResolvedValue(reply('wrong'));
    const store = new ControllerStore(api, [host]); await store.refresh(); await store.openSlot(1);
    expect(store.state.reply).toBeNull(); expect(store.state.error).toMatch(/different chat/);
  });
  it('does not issue duplicate polls while one is unresolved', async () => {
    const api = fake(); const pending = deferred<Reply>();
    const store = new ControllerStore(api, [host]); await store.refresh(); await store.openSlot(1);
    vi.mocked(api.reply).mockImplementationOnce(() => pending.promise);
    const polling = store.refreshReply(); await store.refreshReply(); await store.refreshReply();
    expect(api.reply).toHaveBeenCalledTimes(2); pending.resolve(reply()); await polling;
  });
  it('does not execute mapped shortcuts or unassigned slots', async () => {
    const api = fake(); const store = new ControllerStore(api, [host]); await store.refresh();
    store.state.slots[0] = { slot: 1, label: 'Delete chat', kind: 'shortcut', chatID: null, action: 'delete' };
    await store.openSlot(1); expect(store.state.error).toMatch(/shortcut/); await store.openSlot(6);
    expect(api.open).not.toHaveBeenCalled(); expect(api.reply).not.toHaveBeenCalled();
  });
  it('honestly marks unavailable Claude reply reading while preserving successful switching', async () => {
    const api = fake(); vi.mocked(api.status).mockResolvedValue({ ...status, providers: [{ id: 'claude', label: 'Claude', available: true, canReadReply: false, reason: '' }] });
    const store = new ControllerStore(api, [host]); await store.setProvider('claude'); await store.openSlot(1);
    expect(api.open).toHaveBeenCalledTimes(1); expect(api.reply).not.toHaveBeenCalled();
    expect(store.state.error).toContain('not connected'); expect(store.state.selected?.id).toBe('one'); expect(store.state.busy).toBe(false);
  });
  it('keeps the demo network-free and marks phone/glasses output as sample content', async () => {
    const api = fake(); const store = new ControllerStore(api, [host]); await store.setDemo(true); await store.openSlot(1);
    expect(api.status).not.toHaveBeenCalled(); expect(api.open).not.toHaveBeenCalled(); expect(api.reply).not.toHaveBeenCalled();
    expect(store.state.reply?.text).toContain('sample reply'); expect(glassesFrame(store.state, 'Studio preview').title).toContain('DEMO');
  });
});

describe('pairing and transport', () => {
  it('calls the native fetch with its global receiver for both API and diagnostic requests', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const nativeLikeFetch = function(this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      expect(typeof input).toBe('string');
      calls.push({ url: String(input), init: init ?? {} });
      return Promise.resolve(new Response(JSON.stringify(String(input).endsWith('/api/status') ? status : { ok: true })));
    };
    vi.stubGlobal('fetch', nativeLikeFetch);
    const diagnostics = new ConnectionDiagnostics(() => host, undefined, '00000000-0000-4000-8000-000000000001');
    try {
      expect((await new HTTPGateway().status(host, new AbortController().signal)).host.id).toBe('h1');
      diagnostics.record('boot', { native: 1 }); await diagnostics.flush();
      expect(calls.map(call => new URL(call.url).pathname)).toEqual(['/api/status', '/api/diagnostics']);
      for (const call of calls) expect(call.init.headers).toMatchObject({ Authorization: `Bearer ${host.token}` });
    } finally { diagnostics.dispose(); vi.unstubAllGlobals(); }
  });
  it('accepts HTTPS origins, rejects credential/query/path and remote HTTP inputs', () => {
    expect(normalizeBaseURL('https://mini.example.test:8453/')).toBe('https://mini.example.test:8453');
    expect(normalizeBaseURL('http://127.0.0.1:18767')).toBe('http://127.0.0.1:18767');
    for (const value of ['http://mini.example.test', 'https://user:pass@mini.example.test', 'https://mini.example.test/?token=secret', 'https://mini.example.test/api', 'javascript:alert(1)', 'file:///etc/passwd']) expect(() => normalizeBaseURL(value)).toThrow();
  });
  it('imports versioned fragment pairing without exposing tokens in errors', () => {
    const hash = '#pair=' + btoa(JSON.stringify({ ...host, v: 1 })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(parsePairingFragment(hash)?.token).toBe(host.token);
    expect(parsePairingFragment('')).toBeNull(); expect(() => parsePairingFragment('#pair=not-a-token')).toThrow(/invalid/);
  });
  it('persists separate per-computer tokens under its own app key and skips corrupted hosts', async () => {
    const memory = new Map<string, string>();
    const local = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); } };
    const storage = new HostStorage(local); await storage.save([host, host2]); const restored = await storage.load();
    expect(restored.map(h => h.token)).toEqual([host.token, host2.token]); expect([...memory.keys()]).toEqual(['genesis-g2.hosts.v1']);
  });
  it('uses bearer authentication, fixed API paths, no cookies or redirects', async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => { calls.push({ url: new URL(url), init }); return new Response(JSON.stringify(reply('a/b?x=1')), { status: 200 }); });
    const api = new HTTPGateway(fetcher as typeof fetch); await api.reply(host, 'codex', 'a/b?x=1', new AbortController().signal);
    expect(calls[0].url.pathname).toBe('/api/reply'); expect(calls[0].url.searchParams.get('chatID')).toBe('a/b?x=1'); expect(calls[0].url.toString()).not.toContain(host.token);
    expect(calls[0].init.headers).toMatchObject({ Authorization: `Bearer ${host.token}` }); expect(calls[0].init.credentials).toBe('omit'); expect(calls[0].init.redirect).toBe('error');
  });
});

describe('glasses navigation and bounded rendering', () => {
  it('recognizes zero and omitted click enum without treating arbitrary system events as clicks', () => {
    expect(gestureFor({ listEvent: { eventType: 0, currentSelectItemIndex: 0 } } as never)).toEqual({ action: 'select', index: 0 });
    expect(gestureFor({ listEvent: { containerID: 4 } } as never)).toEqual({ action: 'select', index: 0 });
    expect(gestureFor({ textEvent: { containerID: 2 } } as never)).toEqual({ action: 'select' });
    expect(gestureFor({ sysEvent: {} } as never)).toBeNull(); expect(gestureFor({ sysEvent: { eventType: 9 } } as never)).toBeNull();
    expect(gestureFor({ sysEvent: { eventType: 3 } } as never)).toEqual({ action: 'back' });
  });
  it('uses native list item indices, opens the correct slot, and backs to chats', async () => {
    const api = fake(); const store = new ControllerStore(api, [host]); await store.refresh();
    const controller = new GlassesController(store, () => {});
    controller.handle({ listEvent: { eventType: 2, currentSelectItemIndex: 1 } } as never, true);
    expect(store.state.focus).toBe(1);
    controller.handle({ listEvent: { eventType: 0, currentSelectItemIndex: 1 } } as never, true); await tick();
    expect(store.state.selected?.id).toBe('two'); expect(store.state.view).toBe('reader');
    controller.handle({ textEvent: { eventType: 3 } } as never, true); expect(store.state.view).toBe('slots');
  });
  it('ignores gestures while the glasses app is backgrounded', async () => {
    const api = fake(); const store = new ControllerStore(api, [host]); await store.refresh();
    const controller = new GlassesController(store, () => {});
    controller.handle({ sysEvent: { eventType: 7 } } as never);
    controller.handle({ listEvent: { eventType: 0, currentSelectItemIndex: 0 } } as never); await tick();
    expect(api.open).not.toHaveBeenCalled();
  });
  it('rejects old physical list taps before and after a different provider frame is acknowledged', async () => {
    const api = fake(); const store = new ControllerStore(api, [host]); await store.refresh();
    const delayed = deferred<boolean>();
    const port = { createStartUpPageContainer: vi.fn(async () => 0), rebuildPageContainer: vi.fn(async () => true), textContainerUpgrade: vi.fn(async () => true) };
    const controller = new GlassesController(store, () => {}, port);
    store.subscribe(state => controller.render(state)); await tick();
    const oldID = port.createStartUpPageContainer.mock.calls[0][0].listObject[0].containerID;
    vi.mocked(port.rebuildPageContainer).mockImplementationOnce(() => delayed.promise);
    await store.setProvider('claude');
    controller.handle({ listEvent: { eventType: 0, currentSelectItemIndex: 0, containerID: oldID } } as never);
    expect(api.open).not.toHaveBeenCalled();
    delayed.resolve(true); await tick();
    const latest = port.rebuildPageContainer.mock.calls.at(-1)![0];
    const newID = latest.listObject[0].containerID;
    expect(newID).not.toBe(oldID);
    controller.handle({ listEvent: { eventType: 0, currentSelectItemIndex: 0, containerID: oldID } } as never);
    controller.handle({ listEvent: { eventType: 0, currentSelectItemIndex: 0 } } as never);
    expect(api.open).not.toHaveBeenCalled();
    controller.handle({ listEvent: { eventType: 0, currentSelectItemIndex: 0, containerID: newID } } as never); await tick();
    expect(api.open).toHaveBeenCalledTimes(1); expect(vi.mocked(api.open).mock.calls[0][1]).toBe('claude');
  });
  it('changes physical context when slot mappings or host ordering change', async () => {
    const store = new ControllerStore(fake(), [host, host2]); await store.refresh();
    const before = glassesFrame(store.state, host.name).context;
    store.state.slots[0] = { ...store.state.slots[0], chatID: 'different' };
    expect(glassesFrame(store.state, host.name).context).not.toBe(before);
    store.navigate('hosts'); const hostsBefore = glassesFrame(store.state, host.name).context;
    store.state.hosts.reverse(); expect(glassesFrame(store.state, host.name).context).not.toBe(hostsBefore);
  });
  it('an omitted native index selects row zero instead of stale phone focus', async () => {
    const api = fake(); const store = new ControllerStore(api, [host]); await store.refresh();
    const port = { createStartUpPageContainer: vi.fn(async () => 0), rebuildPageContainer: vi.fn(async () => true), textContainerUpgrade: vi.fn(async () => true) };
    const controller = new GlassesController(store, () => {}, port);
    store.subscribe(state => controller.render(state)); await tick(); store.focus(1, 6);
    const id = port.createStartUpPageContainer.mock.calls[0][0].listObject[0].containerID;
    controller.handle({ listEvent: { containerID: id } } as never); await tick();
    expect(store.state.selected?.id).toBe('one');
  });
  it('contextual menu ENTER → item → EXIT leaves the page active without another startup', async () => {
    const api = fake(); const store = new ControllerStore(api, [host]); await store.refresh();
    const port = { createStartUpPageContainer: vi.fn(async () => 0), rebuildPageContainer: vi.fn(async () => true), textContainerUpgrade: vi.fn(async () => true) };
    const controller = new GlassesController(store, () => {}, port);
    store.subscribe(state => controller.render(state)); await tick();
    controller.handle({ sysEvent: { eventType: 4 } } as never);
    controller.handle({ menuItemClickEvent: { itemID: 3 } } as never);
    controller.handle({ sysEvent: { eventType: 5 } } as never); await tick();
    expect(store.state.view).toBe('providers');
    const inputID = port.rebuildPageContainer.mock.calls.at(-1)![0].listObject[0].containerID;
    controller.handle({ listEvent: { eventType: 0, currentSelectItemIndex: 1, containerID: inputID } } as never); await tick();
    expect(store.state.provider).toBe('claude'); expect(port.createStartUpPageContainer).toHaveBeenCalledTimes(1);
  });
  it('preserves long replies across bounded pages and never splits UTF8 code points', () => {
    const input = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    const pages = replyPages(input); expect(pages.length).toBeGreaterThan(5);
    expect(pages.join(' ').replace(/\s+/g, ' ')).toBe(input);
    for (const page of pages) { expect(page.split('\n').length).toBeLessThanOrEqual(7); expect(new TextEncoder().encode(page).length).toBeLessThan(999); }
    expect(truncateUTF8('🙂🙂A', 7)).toBe('🙂');
    const unicode = '界🙂'.repeat(1000);
    const unicodePages = replyPages(unicode);
    expect(unicodePages.join('').replace(/\n/g, '')).toBe(unicode);
    expect(unicodePages.every(page => new TextEncoder().encode(page).length < 999)).toBe(true);
  });
  it('provides exactly one input target and explicit contextual controls', async () => {
    const store = new ControllerStore(fake(), [host]); await store.refresh();
    const page = pageFor(glassesFrame(store.state, host.name));
    const captures = [...page.textObject!, ...page.listObject!].filter(c => c.isEventCapture === 1);
    expect(captures).toHaveLength(1); expect(page.menuObject?.menuItems?.map(i => i.itemName)).toEqual(['Chats', 'Computers', 'Agents', 'Refresh']);
    expect(page.listObject?.[0].itemContainer?.itemName).toHaveLength(6);
  });
  it('coalesces slow Bluetooth frames and upgrades text without resetting the page', async () => {
    const first = deferred<number>(); const port = { createStartUpPageContainer: vi.fn(() => first.promise), rebuildPageContainer: vi.fn(async () => true), textContainerUpgrade: vi.fn(async () => true) };
    const errors = vi.fn(); const renderer = new GlassesRenderer(port, errors);
    const base = { kind: 'text' as const, title: 'C1', content: 'First', footer: '1/1', items: [], context: 'same-chat' };
    renderer.render(base); renderer.render({ ...base, content: 'Intermediate' }); renderer.render({ ...base, content: 'Newest' });
    first.resolve(0); await tick();
    expect(port.createStartUpPageContainer).toHaveBeenCalledTimes(1); expect(port.rebuildPageContainer).not.toHaveBeenCalled();
    expect(port.textContainerUpgrade).toHaveBeenCalledTimes(1); expect(port.textContainerUpgrade.mock.calls[0][0].content).toBe('Newest'); expect(errors).not.toHaveBeenCalled();
  });
  it('reconnect reuses the serialized renderer and changes IDs without a duplicate startup', async () => {
    const first = deferred<number>(); const port = { createStartUpPageContainer: vi.fn(() => first.promise), rebuildPageContainer: vi.fn(async () => true), textContainerUpgrade: vi.fn(async () => true) };
    const renderer = new GlassesRenderer(port, () => {});
    const frame = { kind: 'text' as const, title: 'One', content: 'Reply', footer: '1/1', items: [], context: 'chat-one' };
    renderer.render(frame); renderer.reconnect(frame);
    expect(renderer.inputTarget).toBeNull(); expect(port.rebuildPageContainer).not.toHaveBeenCalled();
    first.resolve(0); await tick();
    expect(port.createStartUpPageContainer).toHaveBeenCalledTimes(1); expect(port.rebuildPageContainer).toHaveBeenCalledTimes(1);
    expect(port.rebuildPageContainer.mock.calls[0][0].textObject.find(x => x.containerName === 'body').containerID).not.toBe(port.createStartUpPageContainer.mock.calls[0][0].textObject.find(x => x.containerName === 'body').containerID);
  });
  it('suspend then reconnect resumes its pending frame after the old ACK arrives', async () => {
    const first = deferred<number>(); const port = { createStartUpPageContainer: vi.fn(async () => 0).mockImplementationOnce(() => first.promise), rebuildPageContainer: vi.fn(async () => true), textContainerUpgrade: vi.fn(async () => true) };
    const acknowledged = vi.fn(); const renderer = new GlassesRenderer(port, () => {}, () => {}, acknowledged);
    const frame = { kind: 'text' as const, title: 'One', content: 'Reply', footer: '1/1', items: [], context: 'chat-one' };
    renderer.render(frame); renderer.suspend(); renderer.reconnect(frame);
    first.resolve(0); await tick();
    expect(acknowledged).toHaveBeenCalledTimes(1); expect(renderer.inputTarget?.context).toBe('chat-one');
    expect(port.createStartUpPageContainer).toHaveBeenCalledTimes(2);
  });
});
