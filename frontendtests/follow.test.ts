import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControllerStore } from '../src/store';
import { followValue, HTTPGateway } from '../src/api';
import { followPresentation } from '../src/follow';
import { GlassesController, glassesFrame } from '../src/glasses';
import type { FollowFeedback, FollowSession, FollowSnapshot, Gateway, Host, HostStatus, Reply } from '../src/types';

const host: Host = { id: 'h1', name: 'Mini 1', baseURL: 'https://mini1.example.test', token: 'private-test-token' };
const host2: Host = { id: 'h2', name: 'Mini 2', baseURL: 'https://mini2.example.test', token: 'different-test-token' };
const reply = (id = 'one', text = 'Correct assistant reply'): Reply => ({ provider: 'codex', chatID: id, title: id, text, revision: 'r1', updatedAt: null, status: 'unknown', truncated: false });
const inactive = (hostID = 'h1'): FollowSnapshot => ({ version: 1, hostID, active: false, revision: 0, supported: false });
const session = (changes: Partial<FollowSession['state']> = {}, outer: Partial<FollowSession> = {}): FollowSession => ({ version: 1, hostID: 'h1', active: true, revision: 1, sourceID: 'ipad-installation', sourceName: 'iPad', expiresAt: new Date(Date.now() + 45000).toISOString(), chatTitle: 'Correct native title', state: { provider: 'codex', chatID: 'one', slotIndex: 0, view: 'reply', page: 0, draft: '', recording: false, sendState: 'none', refreshNonce: 0, ...changes }, ...outer });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const stores: ControllerStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.dispose()); vi.restoreAllMocks(); });
function fixture(initial: FollowSnapshot = session()) {
  let snapshot = initial;
  const api: Gateway = {
    status: vi.fn(async (h): Promise<HostStatus> => ({ host: { id: h.id, name: h.name }, version: 'test', providers: [{ id: 'codex', label: 'Codex', available: true, canReadReply: true }, { id: 'claude', label: 'Claude', available: true, canReadReply: true }] })),
    profile: vi.fn(async (_h, provider) => ({ provider, slots: [{ slot: 1, label: 'One', chatID: 'one', kind: 'chat' }, { slot: 2, label: 'Two', chatID: 'two', kind: 'chat' }] })),
    chats: vi.fn(async (_h, provider) => ({ provider, chats: [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }] })),
    open: vi.fn(async (_h, _provider, chat) => ({ ok: true, chat, status: 'confirmed' })),
    reply: vi.fn(async (_h, _provider, id) => reply(id)),
    follow: vi.fn(async () => snapshot), followFeedback: vi.fn(async () => snapshot),
  };
  const store = new ControllerStore(api, [host, host2]); stores.push(store);
  return { api, store, set: (value: FollowSnapshot) => { snapshot = value; } };
}
function portFixture() {
  return { createStartUpPageContainer: vi.fn(async () => 0), rebuildPageContainer: vi.fn(async () => true), textContainerUpgrade: vi.fn(async () => true) };
}

describe('keep-reading display boundary', () => {
  const parked = (state: Partial<FollowSession['state']> = {}, outer: Partial<FollowSession> = {}) => session(state, {
    supportsKeepReading: true, keepReading: true, readingOnly: true,
    expiresAt: new Date(Date.now() + 3600000).toISOString(), ...outer,
  });
  it('preserves optional capability/mode flags without changing older snapshots', () => {
    const old = session(); expect(followValue(old)).toEqual(old);
    expect(followValue(parked())).toMatchObject({ supportsKeepReading: true, keepReading: true, readingOnly: true });
    const inactiveValue = { ...inactive(), supportsKeepReading: true, keepReading: true, readingOnly: true, state: { draft: 'private' }, sourceID: 'private' };
    expect(followValue(inactiveValue)).toEqual({ ...inactive(), supportsKeepReading: true });
    expect(followValue(session({}, { supportsKeepReading: false, keepReading: false, readingOnly: false }))).toMatchObject({ supportsKeepReading: false, keepReading: false, readingOnly: false });
  });
  it('rejects malformed flags and any private or interactive state in reading-only mode', () => {
    for (const key of ['supportsKeepReading', 'keepReading', 'readingOnly']) {
      for (const value of ['true', 1, null, undefined]) {
        expect(() => followValue({ ...parked(), [key]: value })).toThrow();
        expect(() => followValue({ ...inactive(), [key]: value })).toThrow();
      }
    }
    for (const changes of [{ draft: 'private draft' }, { draft: ' ' }, { recording: true }, { sendState: 'queued' }, { view: 'draft' }, { view: 'home' }, { page: 1 }, { chatID: null }]) {
      expect(() => followValue(parked(changes as never))).toThrow();
    }
    expect(() => followValue(parked({}, { keepReading: false }))).toThrow();
    expect(() => followValue(parked({}, { supportsKeepReading: false }))).toThrow();
  });
  it.each(['codex', 'claude'] as const)('shows the exact %s conversation with a reading status, not a composer prompt', async provider => {
    const f = fixture(parked({ provider })); vi.mocked(f.api.reply).mockResolvedValue({ ...reply(), provider });
    await f.store.refresh(); await f.store.pollFollow(); await tick();
    const display = followPresentation(f.store.state)!;
    expect(display.content).toContain(`${provider.toUpperCase()}: Correct assistant reply`);
    expect(display.status).toBe('Reading while phone sleeps'); expect(display.footer).toContain('Reading while phone sleeps');
    expect(display.footer.length).toBeLessThanOrEqual(42); expect(display.composer).toContain('READ ONLY');
    expect(display.composer).not.toMatch(/Hold Talk|Review, then|press Send/);
    expect(display.feedback?.payload).toMatchObject({ view: 'reply', renderedPage: 0 });
    expect(f.api.open).not.toHaveBeenCalled();
    f.store.state.status!.providers.find(item => item.id === provider)!.canReadReply = false;
    const unavailable = followPresentation(f.store.state)!;
    expect(unavailable.content).not.toContain('Correct assistant reply');
    expect(unavailable.pages.join(' ')).not.toContain('Your draft stays below');
    expect(unavailable.label).toBe('Reply unavailable');
  });
  it('enabling keep-reading while the controller is active does not hide its current draft', async () => {
    const f = fixture(session({ view: 'draft', draft: 'Current words', recording: true }, { supportsKeepReading: true, keepReading: true, readingOnly: false }));
    await f.store.refresh(); await f.store.pollFollow(); await tick();
    expect(followPresentation(f.store.state)?.status).toBe('Voice input');
    expect(followPresentation(f.store.state)?.composer).toContain('Current words');
  });
  it('clears an existing draft and rejects a same-chat read started before parking', async () => {
    const f = fixture(session({ view: 'draft', draft: 'Private unsent words', recording: true }));
    await f.store.refresh(); const old = deferred<Reply>(); const fresh = deferred<Reply>();
    vi.mocked(f.api.reply).mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
    await f.store.pollFollow(); const oldFrame = glassesFrame(f.store.state, host.name);
    f.set(parked({}, { revision: 2 })); await f.store.pollFollow();
    expect(JSON.stringify(f.store.state)).not.toContain('Private unsent');
    expect(f.store.state.reply).toBeNull(); expect(glassesFrame(f.store.state, host.name).context).not.toBe(oldFrame.context);
    old.resolve(reply('one', 'Stale pre-sleep response')); await tick(); expect(f.store.state.reply).toBeNull();
    fresh.resolve(reply('one', 'Current reading response')); await tick();
    expect(glassesFrame(f.store.state, host.name).content).toContain('Current reading response');
    expect(glassesFrame(f.store.state, host.name).composer).not.toContain('Private');
    expect(vi.mocked(f.api.reply).mock.calls[0][3].aborted).toBe(true); expect(f.api.open).not.toHaveBeenCalled();
  });
  it('resuming normal control discards a delayed parked read without losing the new draft', async () => {
    const f = fixture(parked()); await f.store.refresh(); const old = deferred<Reply>();
    vi.mocked(f.api.reply).mockImplementationOnce(() => old.promise);
    await f.store.pollFollow(); f.set(session({ view: 'draft', draft: 'New active words' }, { revision: 2, keepReading: true, readingOnly: false }));
    await f.store.pollFollow(); await tick(); old.resolve(reply('one', 'Late parked response')); await tick();
    expect(f.store.state.reply?.text).toBe('Correct assistant reply');
    expect(followPresentation(f.store.state)?.composer).toContain('New active words');
    expect(followPresentation(f.store.state)?.status).not.toBe('Reading while phone sleeps');
  });
  it('continues bounded exact-chat reads and physical feedback without extending the parked expiry or running commands', async () => {
    const now = Date.now(); const snapshot = parked(); const f = fixture(snapshot);
    await f.store.refresh(); await f.store.pollFollow(); await tick();
    const time = vi.spyOn(Date, 'now').mockReturnValue(now + 2500);
    const next = deferred<Reply>(); vi.mocked(f.api.reply).mockImplementationOnce(() => next.promise);
    await f.store.pollFollow(); await f.store.pollFollow(); expect(f.api.reply).toHaveBeenCalledTimes(2);
    next.resolve(reply('one', 'Fresh while parked')); await tick();
    const ack = glassesFrame(f.store.state, host.name).feedback!;
    vi.mocked(f.api.followFeedback!).mockResolvedValue(parked({}, { expiresAt: new Date(now + 7200000).toISOString() }));
    await f.store.acknowledgeFollow(ack.payload, ack.hostID, ack.sourceID);
    expect(f.store.state.follow?.expiresAt).toBe(snapshot.expiresAt);
    expect(vi.mocked(f.api.followFeedback!).mock.calls[0][1]).toEqual(ack.payload);
    await f.store.openSlot(2); f.store.turnPage(1, 4); f.store.back();
    expect(f.api.open).not.toHaveBeenCalled(); expect(f.store.state.selected?.id).toBe('one'); expect(f.store.state.page).toBe(0);
    time.mockReturnValue(Date.parse(snapshot.expiresAt) + 1); f.store.expireFollow(); await f.store.pollFollow();
    expect(f.store.state.follow).toBeNull(); expect(f.store.state.reply).toBeNull(); expect(f.store.state.selected).toBeNull();
    expect(f.api.reply).toHaveBeenCalledTimes(2);
  });
  it('never acknowledges the old private frame after the same chat enters reading-only mode', async () => {
    const f = fixture(session({ view: 'draft', draft: 'Private words' })); await f.store.refresh(); await f.store.pollFollow(); await tick();
    const port = portFixture(); const create = deferred<number>(); port.createStartUpPageContainer.mockImplementationOnce(() => create.promise);
    const controller = new GlassesController(f.store, () => {}, port); f.store.subscribe(state => controller.render(state));
    f.set(parked({}, { revision: 2 })); await f.store.pollFollow(); await tick(); create.resolve(0); await tick();
    expect(port.rebuildPageContainer).toHaveBeenCalled();
    expect(vi.mocked(f.api.followFeedback!).mock.calls.every(call => call[1].revision === 2 && call[1].view === 'reply')).toBe(true);
    expect(f.api.followFeedback).toHaveBeenCalledTimes(1);
  });
});

describe('native follow transport', () => {
  it('uses only the fixed follow GET and display feedback POST paths with bound global fetch', async () => {
    const calls: { path: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', function(this: unknown, url: RequestInfo | URL, init?: RequestInit) {
      expect(this).toBe(globalThis); expect(typeof url).toBe('string');
      calls.push({ path: new URL(String(url)).pathname, init: init! });
      return Promise.resolve(new Response(JSON.stringify(session())));
    });
    try {
      const api = new HTTPGateway(); const signal = new AbortController().signal;
      await api.follow(host, signal);
      const feedback: FollowFeedback = { revision: 1, provider: 'codex', chatID: 'one', view: 'reply', pageCount: 3, renderedPage: 2, connected: true };
      await api.followFeedback(host, feedback, signal);
      expect(calls.map(c => [c.path, c.init.method])).toEqual([['/api/follow', 'GET'], ['/api/follow-feedback', 'POST']]);
      expect(JSON.parse(String(calls[1].init.body))).toEqual(feedback);
      expect(calls[1].init.body).not.toContain('draft'); expect(calls[1].init.body).not.toContain('lease');
      expect(calls[0].init.headers).toMatchObject({ Authorization: `Bearer ${host.token}` });
    } finally { vi.unstubAllGlobals(); }
  });
  it('validates display bounds, preserves Unicode and drops private/unrecognized fields', () => {
    const input = { ...session({ draft: '🙂'.repeat(16000), view: 'draft' }), leaseID: 'never-public', state: { ...session().state, draft: '🙂'.repeat(16000), view: 'draft', command: 'send' } };
    const parsed = followValue(input); expect(parsed.active).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain('never-public'); expect(JSON.stringify(parsed)).not.toContain('command');
    for (const patch of [{ page: -1 }, { page: 1000 }, { slotIndex: 6 }, { recording: 'true' }, { draft: 'x'.repeat(16001) }, { sendState: 'delivered' }, { view: 'draft', chatID: null }, { refreshNonce: -1 }]) expect(() => followValue(session(patch as never))).toThrow();
    expect(followValue(inactive())).toEqual(inactive());
  });
});

describe('display-only follow and standalone isolation', () => {
  it('follows the exact native chat without opening it, sending, or rescanning chat inventory', async () => {
    const f = fixture(session({ chatID: 'two', slotIndex: 1 })); await f.store.refresh();
    const profileCount = vi.mocked(f.api.profile).mock.calls.length;
    await f.store.pollFollow(); await tick();
    expect(f.store.state.selected).toEqual({ id: 'two', title: 'Correct native title' }); expect(f.store.state.selectedSlot).toBe(2);
    expect(f.api.reply).toHaveBeenCalledWith(host, 'codex', 'two', expect.any(AbortSignal));
    await f.store.openSlot(1); await f.store.openChat({ id: 'one', title: 'One' }); await f.store.setProvider('claude'); f.store.turnPage(1, 20); f.store.back();
    expect(f.api.open).not.toHaveBeenCalled(); expect(f.api.profile).toHaveBeenCalledTimes(profileCount);
    expect(f.store.state.provider).toBe('codex'); expect(f.store.state.selected?.id).toBe('two'); expect(f.store.state.page).toBe(0);
  });
  it('an older companion leaves ordinary manual chat switching intact', async () => {
    const f = fixture(inactive()); await f.store.refresh(); await f.store.pollFollow(); await f.store.openSlot(2);
    expect(f.store.state.follow).toBeNull(); expect(f.store.state.reply?.chatID).toBe('two'); expect(f.api.open).toHaveBeenCalledTimes(1);
  });
  it('allows local leave/manual/resume without claiming or releasing native ownership', async () => {
    const f = fixture(); await f.store.refresh(); await f.store.pollFollow(); await tick();
    await f.store.leaveFollow(); await f.store.setProvider('claude'); await f.store.pollFollow();
    expect(f.store.state.followEnabled).toBe(false); expect(f.api.follow).toHaveBeenCalledTimes(1);
    await f.store.openSlot(2); expect(f.api.open).toHaveBeenCalledTimes(1);
    await f.store.resumeFollow(); await tick();
    expect(f.store.state.follow?.sourceID).toBe('ipad-installation'); expect(f.store.state.provider).toBe('codex');
    expect(f.api.open).toHaveBeenCalledTimes(1); expect(f.api.followFeedback).not.toHaveBeenCalled();
  });
  it('blocks glasses and phone-preview gestures while native controls own navigation', async () => {
    const f = fixture(); await f.store.refresh(); await f.store.pollFollow(); await tick();
    const controller = new GlassesController(f.store, () => {});
    for (const preview of [false, true]) {
      for (const eventType of [0, 1, 2, 3]) controller.handle({ listEvent: { eventType, currentSelectItemIndex: 1 } } as never, preview);
      controller.handle({ menuItemClickEvent: { itemID: 3 } } as never, preview);
    }
    expect(f.store.state.selected?.id).toBe('one'); expect(f.store.state.view).toBe('reader'); expect(f.store.state.page).toBe(0); expect(f.api.open).not.toHaveBeenCalled();
  });
  it('keeps Claude replies explicitly unavailable, but shows its draft, recording and truthful Send state', async () => {
    const f = fixture(session({ provider: 'claude' })); const status = await f.api.status(host, new AbortController().signal); status.providers.find(provider => provider.id === 'claude')!.canReadReply = false; vi.mocked(f.api.status).mockResolvedValue(status); await f.store.refresh(); await f.store.pollFollow();
    expect(followPresentation(f.store.state)?.content.replace(/\s+/g, ' ')).toContain('Claude replies are unavailable on this Mac'); expect(f.api.reply).not.toHaveBeenCalled();
    f.set(session({ provider: 'claude', view: 'draft', draft: '**Keep my literal words**', recording: true, sendState: 'queued' }, { revision: 2 }));
    await f.store.pollFollow(); const display = followPresentation(f.store.state)!;
    expect(display.composer).toContain('**Keep my literal words**'); expect(display.label).toBe('Draft review'); expect(display.status).toBe('Voice input'); expect(display.receipt).toBe('Send queued'); expect(display.receipt).not.toBe('Sent'); expect(f.api.reply).not.toHaveBeenCalled();
    f.set(session({ provider: 'claude', view: 'draft', draft: 'Review me', sendState: 'uncertain' }, { revision: 3 })); await f.store.pollFollow();
    expect(followPresentation(f.store.state)?.receipt).toBe('Send unverified');
  });
});

describe('follow races, expiry and page bounds', () => {
  it('invalidates a manual reader when native follow starts and ignores its late reply', async () => {
    const f = fixture(session({ chatID: 'two' })); await f.store.refresh();
    const old = deferred<Reply>(); vi.mocked(f.api.reply).mockImplementationOnce(() => old.promise);
    const opening = f.store.openSlot(1); await tick(); await f.store.pollFollow(); await tick();
    old.resolve(reply('one', 'Stale manual response')); await opening;
    expect(f.store.state.reply?.chatID).toBe('two'); expect(f.store.state.reply?.text).not.toContain('Stale');
  });
  it('new native chat selection does not wait for an old reply and late reads cannot replace it', async () => {
    const f = fixture(); await f.store.refresh(); const old = deferred<Reply>(); vi.mocked(f.api.reply).mockImplementationOnce(() => old.promise);
    await f.store.pollFollow(); f.set(session({ chatID: 'two', slotIndex: 1 }, { revision: 2 })); await f.store.pollFollow(); await tick();
    expect(f.store.state.reply?.chatID).toBe('two'); old.resolve(reply('one', 'Late old answer')); await tick();
    expect(f.store.state.reply?.chatID).toBe('two'); expect(f.api.open).not.toHaveBeenCalled();
  });
  it('rejects a reply for another chat and does not report placeholder page bounds', async () => {
    const f = fixture(); await f.store.refresh(); vi.mocked(f.api.reply).mockResolvedValue(reply('wrong'));
    await f.store.pollFollow(); await tick();
    expect(f.store.state.reply).toBeNull(); expect(f.store.state.error).toContain('different chat'); expect(glassesFrame(f.store.state, host.name).feedback).toBeUndefined();
  });
  it('a host change discards pending snapshots, drafts, selection and reads', async () => {
    const f = fixture(session({ view: 'draft', draft: 'Private Mini 1 draft' })); await f.store.refresh(); await f.store.pollFollow();
    const pending = deferred<FollowSnapshot>(); vi.mocked(f.api.follow!).mockImplementationOnce(() => pending.promise);
    const poll = f.store.pollFollow(); await f.store.setHost('h2'); pending.resolve(session({ view: 'draft', draft: 'Late private draft' })); await poll;
    expect(f.store.state.follow).toBeNull(); expect(f.store.state.selected).toBeNull(); expect(f.store.state.reply).toBeNull(); expect(JSON.stringify(f.store.state)).not.toContain('private draft');
  });
  it('an old pending poll cannot undo explicit Leave follow', async () => {
    const f = fixture(); await f.store.refresh(); const pending = deferred<FollowSnapshot>(); vi.mocked(f.api.follow!).mockImplementationOnce(() => pending.promise);
    const poll = f.store.pollFollow(); await f.store.leaveFollow(); pending.resolve(session()); await poll;
    expect(f.store.state.follow).toBeNull(); expect(f.store.state.followEnabled).toBe(false);
  });
  it('only issues one concurrent follow poll and checks host identity', async () => {
    const f = fixture(); await f.store.refresh(); const pending = deferred<FollowSnapshot>(); vi.mocked(f.api.follow!).mockImplementationOnce(() => pending.promise);
    const poll = f.store.pollFollow(); await f.store.pollFollow(); await f.store.pollFollow(); expect(f.api.follow).toHaveBeenCalledTimes(1);
    pending.resolve(session({}, { hostID: 'not-this-mac' })); await poll; expect(f.store.state.follow).toBeNull(); expect(f.api.reply).not.toHaveBeenCalled();
  });
  it('clears private drafts and selection on local expiry even without a network response', async () => {
    const snapshot = session({ view: 'draft', draft: 'Private sentence', recording: true }); const f = fixture(snapshot); await f.store.refresh(); await f.store.pollFollow();
    f.store.expireFollow(Date.parse(snapshot.expiresAt) + 1);
    expect(f.store.state.follow).toBeNull(); expect(f.store.state.selected).toBeNull(); expect(f.store.state.page).toBe(0); expect(JSON.stringify(f.store.state)).not.toContain('Private sentence'); expect(glassesFrame(f.store.state, host.name).content).toContain('expired');
  });
  it('clears drafts when the bridge goes offline or the owner releases the session', async () => {
    const f = fixture(session({ view: 'draft', draft: 'Private sentence' })); await f.store.refresh(); await f.store.pollFollow();
    vi.mocked(f.api.follow!).mockRejectedValueOnce(new Error('offline')); await f.store.pollFollow();
    expect(f.store.state.follow).toBeNull(); expect(f.store.state.followNotice).toContain('disconnected');
    await f.store.pollFollow(); f.set(inactive()); await f.store.pollFollow();
    expect(f.store.state.follow).toBeNull(); expect(f.store.state.selected).toBeNull(); expect(f.store.state.followNotice).toContain('ended');
  });
  it('does not clamp a requested page against loading text; uses real reply page bounds once read', async () => {
    const f = fixture(session({ page: 999 })); await f.store.refresh(); const pending = deferred<Reply>(); vi.mocked(f.api.reply).mockImplementationOnce(() => pending.promise);
    await f.store.pollFollow(); expect(glassesFrame(f.store.state, host.name).feedback).toBeUndefined(); expect(f.store.state.page).toBe(999);
    pending.resolve(reply('one', Array.from({ length: 500 }, (_, i) => `word${i}`).join(' '))); await tick();
    const frame = glassesFrame(f.store.state, host.name); const feedback = frame.feedback!.payload;
    expect(feedback.pageCount).toBeGreaterThan(1); expect(feedback.renderedPage).toBe(feedback.pageCount - 1); expect(feedback.pageCount).toBeLessThanOrEqual(1000);
    expect(f.store.state.page).toBe(999); expect(f.api.followFeedback).not.toHaveBeenCalled();
  });
  it('a draft update never paints an in-flight assistant reply over the draft', async () => {
    const f = fixture(); await f.store.refresh(); const pending = deferred<Reply>(); vi.mocked(f.api.reply).mockImplementationOnce(() => pending.promise);
    await f.store.pollFollow(); f.set(session({ view: 'draft', draft: 'My current draft', recording: true }, { revision: 2 })); await f.store.pollFollow();
    pending.resolve(reply('one', 'Late assistant response')); await tick();
    expect(f.store.state.reply?.chatID).toBe('one'); const frame = glassesFrame(f.store.state, host.name); expect(frame.content).toContain('CODEX: Late assistant response'); expect(frame.composer).toContain('YOU > My current draft'); expect(frame.composer).not.toContain('assistant');
  });
});

describe('physical-ACK-only follow feedback', () => {
  it('waits for a real native render ACK and deduplicates unchanged frames and heartbeats', async () => {
    const snapshot = session({ view: 'draft', draft: 'My draft' }); const f = fixture(snapshot); await f.store.refresh(); await f.store.pollFollow();
    const port = portFixture(); const ack = deferred<number>(); port.createStartUpPageContainer.mockImplementationOnce(() => ack.promise);
    const controller = new GlassesController(f.store, () => {}, port); f.store.subscribe(state => controller.render(state));
    await tick(); expect(f.api.followFeedback).not.toHaveBeenCalled(); ack.resolve(0); await tick();
    expect(f.api.followFeedback).toHaveBeenCalledTimes(1); expect(vi.mocked(f.api.followFeedback!).mock.calls[0][1]).toMatchObject({ revision: 1, view: 'draft', connected: true });
    f.set({ ...snapshot, expiresAt: new Date(Date.now() + 46000).toISOString() }); await f.store.pollFollow(); await tick();
    expect(f.api.followFeedback).toHaveBeenCalledTimes(1); expect(port.textContainerUpgrade).not.toHaveBeenCalled(); expect(port.rebuildPageContainer).not.toHaveBeenCalled();
  });
  it('never reports failed rendering or a late ACK for an obsolete native revision', async () => {
    const f = fixture(session({ view: 'draft', draft: 'First' })); await f.store.refresh(); await f.store.pollFollow();
    const port = portFixture(); const ack = deferred<number>(); port.createStartUpPageContainer.mockImplementationOnce(() => ack.promise);
    const controller = new GlassesController(f.store, () => {}, port); controller.render(f.store.state);
    f.set(session({ view: 'draft', draft: 'New selection' }, { revision: 2 })); await f.store.pollFollow();
    ack.resolve(0); await tick(); expect(f.api.followFeedback).not.toHaveBeenCalled();
    port.textContainerUpgrade.mockResolvedValue(false); controller.render(f.store.state); await tick();
    expect(f.api.followFeedback).not.toHaveBeenCalled();
  });
  it('acks an unchanged display for a new revision through native footer ACK, without response feedback loops', async () => {
    const f = fixture(session({ view: 'draft', draft: 'Stable text', page: 999 })); await f.store.refresh(); await f.store.pollFollow();
    const port = portFixture(); const controller = new GlassesController(f.store, () => {}, port); f.store.subscribe(state => controller.render(state)); await tick();
    expect(f.api.followFeedback).toHaveBeenCalledTimes(1);
    f.set(session({ view: 'draft', draft: 'Stable text', page: 0 }, { revision: 2 })); await f.store.pollFollow(); await tick();
    expect(port.textContainerUpgrade).toHaveBeenCalledTimes(1); expect(port.textContainerUpgrade.mock.calls[0][0].containerName).toBe('footer');
    expect(f.api.followFeedback).toHaveBeenCalledTimes(2); await tick(); await tick(); expect(f.api.followFeedback).toHaveBeenCalledTimes(2);
  });
  it('does not acknowledge an old owner after takeover or any display after expiry', async () => {
    const f = fixture(session({ view: 'draft', draft: 'Private' })); await f.store.refresh(); await f.store.pollFollow(); const old = glassesFrame(f.store.state, host.name).feedback!;
    f.set(session({ view: 'draft', draft: 'Another controller' }, { sourceID: 'iphone-owner', sourceName: 'iPhone', revision: 2 })); await f.store.pollFollow();
    await f.store.acknowledgeFollow(old.payload, old.hostID, old.sourceID); expect(f.api.followFeedback).not.toHaveBeenCalled();
    const current = glassesFrame(f.store.state, host.name).feedback!; f.store.expireFollow(Date.now() + 60000);
    await f.store.acknowledgeFollow(current.payload, current.hostID, current.sourceID); expect(f.api.followFeedback).not.toHaveBeenCalled();
  });
});

describe('follow connection freshness', () => {
  it('preserves only valid current-revision feedback from the adapter', () => {
    const acknowledged = { revision: 1, pageCount: 3, renderedPage: 2, connected: true };
    expect((followValue({ ...session(), feedback: acknowledged }) as FollowSession).feedback).toEqual(acknowledged);
    for (const patch of [{ revision: 2 }, { pageCount: 0 }, { renderedPage: 3 }, { connected: 'true' }]) expect(() => followValue({ ...session(), feedback: { ...acknowledged, ...patch } })).toThrow();
  });
  it('a known disconnect reports false only for the previously physically acknowledged frame', async () => {
    const f = fixture(session({ view: 'draft', draft: 'Displayed draft' })); await f.store.refresh(); await f.store.pollFollow();
    const port = portFixture(); const controller = new GlassesController(f.store, () => {}, port); f.store.subscribe(state => controller.render(state)); await tick();
    controller.handle({ sysEvent: { eventType: 7 } } as never); await tick();
    expect(vi.mocked(f.api.followFeedback!).mock.calls.map(call => call[1].connected)).toEqual([true, false]);
    expect(f.store.state.follow?.sourceID).toBe('ipad-installation'); expect(f.api.open).not.toHaveBeenCalled();
  });
  it('re-verifies an expired ACK physically and never marks it connected just because polling succeeded', async () => {
    const base = session({ view: 'draft', draft: 'Stable text' }, { feedback: { revision: 1, pageCount: 1, renderedPage: 0, connected: true } });
    const f = fixture(base); await f.store.refresh(); await f.store.pollFollow();
    const port = portFixture(); const controller = new GlassesController(f.store, () => {}, port); f.store.subscribe(state => controller.render(state)); await tick();
    expect(f.api.followFeedback).toHaveBeenCalledTimes(1);
    const verify = deferred<boolean>(); port.textContainerUpgrade.mockImplementationOnce(() => verify.promise);
    const { feedback: _feedback, ...expired } = base; f.set(expired); await f.store.pollFollow();
    expect(port.textContainerUpgrade).toHaveBeenCalledTimes(1); expect(f.api.followFeedback).toHaveBeenCalledTimes(1);
    await f.store.pollFollow(); await f.store.pollFollow(); expect(port.textContainerUpgrade).toHaveBeenCalledTimes(1);
    verify.resolve(true); await tick(); expect(f.api.followFeedback).toHaveBeenCalledTimes(2);
    await f.store.pollFollow(); await tick(); expect(port.textContainerUpgrade).toHaveBeenCalledTimes(1);
  });
  it('retries missing feedback at a bounded cadence without stacking native verification requests', async () => {
    const f = fixture(session({ view: 'draft', draft: 'Text' })); await f.store.refresh(); await f.store.pollFollow();
    const port = portFixture(); const controller = new GlassesController(f.store, () => {}, port); f.store.subscribe(state => controller.render(state)); await tick();
    const time = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(time + 6000);
    const verify = deferred<boolean>(); port.textContainerUpgrade.mockImplementationOnce(() => verify.promise);
    await f.store.pollFollow(); expect(port.textContainerUpgrade).toHaveBeenCalledTimes(1);
    vi.mocked(Date.now).mockReturnValue(time + 12000); await f.store.pollFollow(); await f.store.pollFollow();
    verify.resolve(true); await tick(); expect(port.textContainerUpgrade).toHaveBeenCalledTimes(1);
  });
  it('orders disconnect and reconnect receipts even while an earlier feedback POST is pending', async () => {
    const f = fixture(session({ view: 'draft', draft: 'Text' })); await f.store.refresh(); await f.store.pollFollow();
    const frame = glassesFrame(f.store.state, host.name).feedback!; const pending = deferred<FollowSnapshot>(); vi.mocked(f.api.followFeedback!).mockImplementationOnce(() => pending.promise);
    const first = f.store.acknowledgeFollow(frame.payload, frame.hostID, frame.sourceID); await tick();
    const disconnected = f.store.disconnectFollowDisplay();
    const reconnected = f.store.acknowledgeFollow(frame.payload, frame.hostID, frame.sourceID);
    expect(f.api.followFeedback).toHaveBeenCalledTimes(1);
    pending.resolve(session()); await Promise.all([first, disconnected, reconnected]);
    expect(vi.mocked(f.api.followFeedback!).mock.calls.map(call => call[1].connected)).toEqual([true, false, true]);
  });
  it('ended follow requires explicit local Leave before manual controls can open chats', async () => {
    const f = fixture(session()); await f.store.refresh(); await f.store.pollFollow(); await tick();
    f.set(inactive()); await f.store.pollFollow(); await f.store.openSlot(2); expect(f.api.open).not.toHaveBeenCalled();
    await f.store.leaveFollow(); await f.store.openSlot(2); expect(f.api.open).toHaveBeenCalledTimes(1);
  });
});

describe('late native pairing storage', () => {
  it('binds a late Even bridge and migrates only Genesis G2 pairings, keeping current tokens', async () => {
    const { HostStorage, validatedHost } = await import('../src/storage');
    const memory = new Map<string, string>(); const local = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); } };
    const current = validatedHost(host); const other = validatedHost(host2);
    const bridge = { getLocalStorage: vi.fn(async () => JSON.stringify([{ ...current, token: 'old-token' }, other])), setLocalStorage: vi.fn(async () => true) };
    const storage = new HostStorage(local); await storage.save([current]);
    const restored = await storage.bindBridge(bridge, () => [current]);
    expect(restored.find(h => h.id === current.id)?.token).toBe(current.token); expect(restored).toHaveLength(2);
    expect(bridge.getLocalStorage).toHaveBeenCalledWith('genesis-g2.hosts.v1'); expect(bridge.setLocalStorage).toHaveBeenCalledWith('genesis-g2.hosts.v1', JSON.stringify(restored));
    expect([...memory.keys()]).toEqual(['genesis-g2.hosts.v1']);
    await storage.bindBridge(bridge, () => restored); expect(bridge.getLocalStorage).toHaveBeenCalledTimes(1);
  });
  it('does not resurrect a forgotten host while native binding is in flight', async () => {
    const { HostStorage, validatedHost } = await import('../src/storage');
    const memory = new Map<string, string>(); const local = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); } };
    let current = [validatedHost(host)]; const get = deferred<string>(); const bridge = { getLocalStorage: vi.fn(() => get.promise), setLocalStorage: vi.fn(async () => true) };
    const storage = new HostStorage(local); const binding = storage.bindBridge(bridge, () => current);
    current = []; await storage.save(current); get.resolve(JSON.stringify([host]));
    expect(await binding).toEqual([]); expect(bridge.setLocalStorage.mock.calls.at(-1)?.[1]).toBe('[]');
  });
  it('serializes native writes and keeps a newer pairing changed during migration', async () => {
    const { HostStorage, validatedHost } = await import('../src/storage');
    const memory = new Map<string, string>(); const local = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); } };
    let current = [validatedHost(host)]; const write = deferred<boolean>();
    const bridge = { getLocalStorage: vi.fn(async () => '[]'), setLocalStorage: vi.fn(async () => true).mockImplementationOnce(() => write.promise) };
    const storage = new HostStorage(local); const binding = storage.bindBridge(bridge, () => current); await tick();
    current = [validatedHost(host2)]; const saving = storage.save(current);
    expect(bridge.setLocalStorage).toHaveBeenCalledTimes(1); write.resolve(true); await saving;
    expect(await binding).toEqual(current); expect(JSON.parse(bridge.setLocalStorage.mock.calls.at(-1)![1])).toEqual(current);
  });
});

it('does not mark a failed native pairing migration bound just because browser fallback saved', async () => {
  const { HostStorage, validatedHost } = await import('../src/storage');
  const memory = new Map<string, string>(); const local = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); } };
  const current = [validatedHost(host)]; const bridge = { getLocalStorage: vi.fn(async () => '[]'), setLocalStorage: vi.fn(async () => true).mockResolvedValueOnce(false) };
  const storage = new HostStorage(local);
  await expect(storage.bindBridge(bridge, () => current)).rejects.toThrow('Native pairing');
  expect(JSON.parse(memory.get('genesis-g2.hosts.v1')!)).toEqual(current);
  expect(await storage.bindBridge(bridge, () => current)).toEqual(current); expect(bridge.setLocalStorage).toHaveBeenCalledTimes(2);
});
