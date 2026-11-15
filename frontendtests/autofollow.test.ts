import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControllerStore } from '../src/store';
import { followPresentation } from '../src/follow';
import type { FollowSession, FollowSnapshot, Gateway, Host, HostStatus } from '../src/types';

const hosts: Host[] = [1, 2, 3].map(n => ({ id: `paired-${n}`, name: `Mini ${n}`, baseURL: `https://mini${n}.example.test`, token: `fixture-token-${n}` }));
const identity = (host: Host) => `00000000-0000-4000-8000-00000000000${hosts.findIndex(h => h.id === host.id) + 1}`;
const inactive = (host: Host): FollowSnapshot => ({ version: 1, hostID: identity(host), active: false, revision: 1, supported: true });
const active = (host: Host, patch: Partial<FollowSession> = {}): FollowSession => ({ version: 1, hostID: identity(host), active: true, revision: 2, sourceID: '00000000-0000-4000-8000-000000000009', sourceName: 'iPhone', expiresAt: new Date(Date.now() + 45000).toISOString(), chatTitle: `${host.name} selected chat`, state: { provider: 'claude', chatID: 'same-chat-id', slotIndex: 4, view: 'draft', page: 0, draft: `${host.name} private draft`, recording: false, sendState: 'none', refreshNonce: 0 }, ...patch });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const stores: ControllerStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.dispose()); vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture(paired = hosts) {
  const snapshots = new Map(paired.map(host => [host.id, inactive(host)]));
  const api: Gateway = {
    status: vi.fn(async (host): Promise<HostStatus> => ({ host: { id: identity(host), name: host.name }, version: 'fixture', providers: [{ id: 'codex', label: 'Codex', available: true, canReadReply: true }, { id: 'claude', label: 'Claude', available: true, canReadReply: false }] })),
    profile: vi.fn(async (_host, provider) => ({ provider, slots: [] })), chats: vi.fn(async (_host, provider) => ({ provider, chats: [] })),
    open: vi.fn(async (_host, _provider, chat) => ({ ok: true, chat, status: 'confirmed' })),
    reply: vi.fn(async (_host, provider, chatID) => ({ provider, chatID, title: 'Fixture reply', text: 'Fixture reply', revision: 'one', updatedAt: null, status: 'unknown', truncated: false })),
    follow: vi.fn(async host => snapshots.get(host.id)!), followFeedback: vi.fn(async host => snapshots.get(host.id)!),
  };
  const store = new ControllerStore(api, paired); stores.push(store);
  return { store, api, snapshots, set: (host: Host, value: FollowSnapshot) => snapshots.set(host.id, value) };
}

describe('automatic follow among explicitly paired computers', () => {
  it('routes to the only active paired Mac using its own identity and credentials without actions', async () => {
    const f = fixture(); await f.store.refresh(); f.set(hosts[1], active(hosts[1]));
    await f.store.pollFollow();
    expect(f.store.state.hostID).toBe(hosts[1].id); expect(f.store.state.status?.host.id).toBe(identity(hosts[1]));
    expect(f.store.state.follow?.hostID).toBe(identity(hosts[1])); expect(f.store.state.provider).toBe('claude'); expect(f.store.state.selectedSlot).toBe(5);
    expect(followPresentation(f.store.state)?.composer).toContain('Mini 2 private draft');
    expect(f.api.open).not.toHaveBeenCalled(); expect(f.api.reply).not.toHaveBeenCalled(); expect(f.api.followFeedback).not.toHaveBeenCalled();
    for (const [host] of vi.mocked(f.api.follow!).mock.calls) expect(host.token).toBe(hosts.find(h => h.id === host.id)?.token);
    expect(new Set(vi.mocked(f.api.follow!).mock.calls.map(([host]) => host.id))).toEqual(new Set(hosts.map(host => host.id)));
  });
  it('keeps an active current host without probing or using another lease timestamp', async () => {
    const f = fixture(); await f.store.refresh(); f.set(hosts[0], active(hosts[0])); f.set(hosts[1], active(hosts[1], { expiresAt: new Date(Date.now() + 90000).toISOString() }));
    await f.store.pollFollow(); await f.store.pollFollow();
    expect(f.store.state.hostID).toBe(hosts[0].id); expect(vi.mocked(f.api.follow!).mock.calls.every(([host]) => host.id === hosts[0].id)).toBe(true);
  });
  it('does not choose between two active alternatives and never displays their drafts', async () => {
    const f = fixture(); await f.store.refresh(); f.set(hosts[1], active(hosts[1])); f.set(hosts[2], active(hosts[2]));
    await f.store.pollFollow();
    expect(f.store.state.hostID).toBe(hosts[0].id); expect(f.store.state.follow).toBeNull(); expect(f.store.state.followNotice).toContain('More than one paired Mac');
    expect(JSON.stringify(f.store.state)).not.toContain('private draft'); expect(f.api.open).not.toHaveBeenCalled();
  });
  it('validates each candidate against its own status instead of the current Mac or URL', async () => {
    const f = fixture(); await f.store.refresh(); f.set(hosts[1], active(hosts[1], { hostID: identity(hosts[0]) })); f.set(hosts[2], active(hosts[2], { expiresAt: new Date(Date.now() - 1).toISOString() }));
    await f.store.pollFollow(); expect(f.store.state.hostID).toBe(hosts[0].id); expect(f.store.state.follow).toBeNull();
    const uninitialized = fixture([hosts[0]]); uninitialized.set(hosts[0], active(hosts[0], { hostID: 'wrong-host' }));
    await uninitialized.store.pollFollow(); expect(uninitialized.api.status).toHaveBeenCalledTimes(1); expect(uninitialized.store.state.follow).toBeNull();
  });
  it('clears an ended host draft before discovery and never reuses a same-ID chat across hosts', async () => {
    const f = fixture(); await f.store.refresh(); f.set(hosts[0], active(hosts[0])); await f.store.pollFollow();
    f.set(hosts[0], inactive(hosts[0])); f.set(hosts[1], active(hosts[1]));
    const pending = deferred<FollowSnapshot>(); vi.mocked(f.api.follow!).mockImplementationOnce(async () => inactive(hosts[0])).mockImplementationOnce(() => pending.promise);
    const observed: { hostID: string | null; draft?: string; replyHost?: string }[] = [];
    const unsubscribe = f.store.subscribe(state => observed.push({ hostID: state.hostID, draft: state.follow?.state.draft, replyHost: state.reply?.chatID }));
    const poll = f.store.pollFollow(); await tick(); expect(f.store.state.follow).toBeNull(); expect(f.store.state.selected).toBeNull();
    pending.resolve(active(hosts[1])); await poll; unsubscribe();
    expect(f.store.state.hostID).toBe(hosts[1].id); expect(f.store.state.reply).toBeNull();
    expect(observed.filter(row => row.hostID === hosts[1].id).every(row => row.draft !== 'Mini 1 private draft' && row.replyHost === undefined)).toBe(true);
  });
  it('keeps the current host if its native owner resumes while other hosts are slow', async () => {
    const f = fixture([hosts[0], hosts[1]]); await f.store.refresh();
    const pending = deferred<FollowSnapshot>(); vi.mocked(f.api.follow!).mockImplementationOnce(async () => inactive(hosts[0])).mockImplementationOnce(() => pending.promise);
    const poll = f.store.pollFollow(); await tick(); f.set(hosts[0], active(hosts[0])); pending.resolve(active(hosts[1])); await poll;
    expect(f.store.state.hostID).toBe(hosts[0].id); expect(f.store.state.follow?.hostID).toBe(identity(hosts[0]));
  });
  it('rechecks the chosen candidate and does not adopt a released session', async () => {
    const f = fixture([hosts[0], hosts[1]]); await f.store.refresh();
    vi.mocked(f.api.follow!).mockResolvedValueOnce(inactive(hosts[0])).mockResolvedValueOnce(active(hosts[1])).mockResolvedValueOnce(inactive(hosts[0])).mockResolvedValueOnce(inactive(hosts[1]));
    await f.store.pollFollow(); expect(f.store.state.hostID).toBe(hosts[0].id); expect(f.store.state.follow).toBeNull();
  });
  it('keeps the current host if it resumes during the final candidate refresh', async () => {
    const f = fixture([hosts[0], hosts[1]]); await f.store.refresh();
    const pending = deferred<FollowSnapshot>();
    vi.mocked(f.api.follow!).mockResolvedValueOnce(inactive(hosts[0])).mockResolvedValueOnce(active(hosts[1]))
      .mockResolvedValueOnce(inactive(hosts[0])).mockImplementationOnce(() => pending.promise);
    const poll = f.store.pollFollow(); await tick();
    expect(f.api.follow).toHaveBeenCalledTimes(4);
    f.set(hosts[0], active(hosts[0])); pending.resolve(active(hosts[1])); await poll;
    expect(f.store.state.hostID).toBe(hosts[0].id); expect(f.store.state.follow?.hostID).toBe(identity(hosts[0]));
    expect(f.api.open).not.toHaveBeenCalled();
  });
  it('bounds a slow probe, skips offline alternatives, and never stacks discovery polls', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.store.refresh(); f.set(hosts[1], active(hosts[1]));
    const pending = deferred<FollowSnapshot>(); vi.mocked(f.api.follow!).mockImplementation(async host => host.id === hosts[2].id ? pending.promise : f.snapshots.get(host.id)!);
    const poll = f.store.pollFollow(); await vi.advanceTimersByTimeAsync(0);
    await f.store.pollFollow(); await f.store.pollFollow(); expect(f.api.follow).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(3000); await poll;
    expect(f.store.state.hostID).toBe(hosts[1].id); expect(vi.mocked(f.api.follow!).mock.calls.find(([host]) => host.id === hosts[2].id)?.[1].aborted).toBe(true);
    pending.resolve(active(hosts[2])); await vi.advanceTimersByTimeAsync(0); expect(f.store.state.hostID).toBe(hosts[1].id);
    await f.store.pollFollow(); expect(f.store.state.hostID).toBe(hosts[1].id);
  });
  it('does not discover on a current-host error or query computers that are not paired', async () => {
    const f = fixture([hosts[0]]); await f.store.refresh(); vi.mocked(f.api.follow!).mockRejectedValueOnce(new Error('offline'));
    await f.store.pollFollow(); expect(f.api.follow).toHaveBeenCalledTimes(1); expect(f.store.state.hostID).toBe(hosts[0].id);
    await f.store.pollFollow(); expect(f.api.follow).toHaveBeenCalledTimes(2);
  });
  it('paces repeated inactive discovery without delaying normal active polling', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.store.refresh(); await f.store.pollFollow(); expect(f.api.follow).toHaveBeenCalledTimes(3);
    await f.store.pollFollow(); expect(f.api.follow).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(3000); await f.store.pollFollow(); expect(f.api.follow).toHaveBeenCalledTimes(7);
  });
});

describe('automatic follow intent and late-response isolation', () => {
  it('honors Leave globally through refresh, same-host selection, storage migration and preview', async () => {
    const f = fixture(); await f.store.refresh(); await f.store.leaveFollow(); f.set(hosts[1], active(hosts[1]));
    await f.store.pollFollow(); await f.store.setHost(hosts[0].id); await f.store.pollFollow();
    await f.store.setHosts([...hosts]); await f.store.pollFollow(); await f.store.setDemo(true); await f.store.setDemo(false); await f.store.pollFollow();
    expect(f.api.follow).not.toHaveBeenCalled(); expect(f.store.state.followEnabled).toBe(false);
    await f.store.setHost(hosts[1].id); await f.store.pollFollow(); expect(f.store.state.follow?.hostID).toBe(identity(hosts[1]));
  });
  it('explicit Resume restores discovery after Leave', async () => {
    const f = fixture(); await f.store.refresh(); await f.store.leaveFollow(); f.set(hosts[1], active(hosts[1]));
    await f.store.resumeFollow(); expect(f.store.state.hostID).toBe(hosts[1].id); expect(f.store.state.followEnabled).toBe(true);
  });
  it.each(['leave', 'host', 'credentials', 'dispose'])('discards a late candidate after %s', async action => {
    const f = fixture([hosts[0], hosts[1]]); await f.store.refresh();
    const pending = deferred<FollowSnapshot>(); vi.mocked(f.api.follow!).mockResolvedValueOnce(inactive(hosts[0])).mockImplementationOnce(() => pending.promise);
    const poll = f.store.pollFollow(); await tick();
    if (action === 'leave') await f.store.leaveFollow();
    if (action === 'host') await f.store.setHost(hosts[1].id);
    if (action === 'credentials') await f.store.setHosts([{ ...hosts[0] }, { ...hosts[1], token: 'replacement-fixture-token' }]);
    if (action === 'dispose') f.store.dispose();
    pending.resolve(active(hosts[1])); await poll;
    expect(f.store.state.follow).toBeNull(); expect(JSON.stringify(f.store.state)).not.toContain('private draft');
    expect(f.api.open).not.toHaveBeenCalled();
  });
});
