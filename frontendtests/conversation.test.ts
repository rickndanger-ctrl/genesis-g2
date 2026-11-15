import { afterEach, describe, expect, it, vi } from 'vitest';
import { composerPages, conversationPages, replyConversation, visibleWidth } from '../src/pagination';
import { followPresentation } from '../src/follow';
import { GlassesRenderer, glassesFrame, pageFor } from '../src/glasses';
import { ControllerStore } from '../src/store';
import type { ConversationTurn, DisplayState, FollowSession, Gateway, Host, Reply } from '../src/types';

const host: Host = { id: 'fixture-host', name: 'Fixture', baseURL: 'https://fixture.example.test', token: 'test-only' };
const turns: ConversationTurn[] = [{ role: 'user', text: 'Show the next task.' }, { role: 'assistant', text: 'The next task is ready.', phase: 'final_answer' }];
const reply = (chatID = 'one', extra: Partial<Reply> = {}): Reply => ({ provider: 'codex', chatID, title: 'Fixture chat', text: 'The next task is ready.', turns, revision: 'one', updatedAt: null, status: 'unknown', truncated: false, ...extra });
const session = (state: Partial<DisplayState> = {}, outer: Partial<FollowSession> = {}): FollowSession => ({ version: 1, hostID: host.id, active: true, revision: 1, sourceID: 'fixture-ipad', sourceName: 'iPad', expiresAt: new Date(Date.now() + 45000).toISOString(), state: { provider: 'codex', chatID: 'one', slotIndex: 0, view: 'reply', page: 0, draft: '', recording: false, sendState: 'none', refreshNonce: 0, ...state }, ...outer });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };
const stores: ControllerStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.dispose()); vi.restoreAllMocks(); });
function fixture(snapshot = session()) {
  let current = snapshot;
  const api: Gateway = {
    status: vi.fn(async () => ({ host: { id: host.id, name: host.name }, version: 'fixture', providers: [{ id: 'codex', label: 'Codex', available: true, canReadReply: true }] })),
    chats: vi.fn(async (_h, provider) => ({ provider, chats: [] })), profile: vi.fn(async (_h, provider) => ({ provider, slots: [] })), open: vi.fn(async (_h, _p, chat) => ({ ok: true, chat, status: 'confirmed' })),
    reply: vi.fn(async (_h, _p, id) => reply(id)), follow: vi.fn(async () => current), followFeedback: vi.fn(async () => current),
  };
  const store = new ControllerStore(api, [host]); stores.push(store);
  return { store, api, set: (snapshot: FollowSession) => { current = snapshot; } };
}

describe('conversation and complete draft presentation', () => {
  it('keeps real roles in reading order with latest content first', () => {
    expect(conversationPages(turns)).toEqual(['YOU: Show the next task.\nCODEX: The next task is ready.']);
    const history: ConversationTurn[] = [{ role: 'user', text: 'First question' }, { role: 'assistant', text: 'First answer' }, { role: 'user', text: 'Latest question' }, { role: 'assistant', text: 'Latest answer' }];
    const pages = conversationPages(history, 42, 3);
    expect(pages[0]).toContain('YOU: Latest question\nCODEX: Latest answer'); expect(pages[1]).toContain('YOU: First question');
  });
  it('pins a truthful one-line request excerpt above a long answer tail and retains complete history', () => {
    const lines = Array.from({ length: 14 }, (_, i) => `Answer line ${i + 1}.`);
    const pages = conversationPages([{ role: 'user', text: 'My original question is quite long and deserves to remain available.' }, { role: 'assistant', text: lines.join('\n') }]);
    expect(pages[0].split('\n')[0]).toMatch(/^YOU: My original question.*…$/);
    expect(pages[0]).toContain('CODEX: Answer line 11.'); expect(pages[0]).toContain('Answer line 14.');
    expect(pages.every(page => page.split('\n').length <= 5 && page.split('\n').every(line => visibleWidth(line) <= 42))).toBe(true);
    const combined = pages.join('\n'); for (const line of lines) expect(combined).toContain(line);
    expect(combined.replace(/\n +/g, ' ')).toContain('deserves to remain available.');
  });
  it('keeps Unicode within visible budgets and every draft word available across newest-first pages', () => {
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`); const draft = words.join('   \n');
    const pages = composerPages(draft, false, 'none', 'iPad');
    expect(pages[0]).toContain('word199'); expect(pages.at(-1)).toContain('word0');
    expect(pages.every(page => page.split('\n').length <= 2 && page.split('\n').every(line => visibleWidth(line) <= 42))).toBe(true);
    const reconstructed = pages.toReversed().map(page => page.replace(/^YOU > /gm, '').replace(/^ {6}/gm, '')).join(' ').replace(/\s+/g, ' ');
    expect(reconstructed).toBe(words.join(' '));
    const unicode = conversationPages([{ role: 'user', text: '你好🙂 '.repeat(30) }, { role: 'assistant', text: '回答🙂 '.repeat(30) }]);
    expect(unicode.every(page => page.split('\n').every(line => visibleWidth(line) <= 42))).toBe(true);
    expect(unicode.every(page => new TextEncoder().encode(page).length < 999)).toBe(true);
    expect(draft).toContain('   \n');
  });
  it('marks older-reader reply-only fallback, bounded excerpts, and never invents a user message', async () => {
    expect(replyConversation(reply('one', { turns: undefined })).replyOnly).toBe(true);
    expect(replyConversation(reply('one', { turnsTruncated: true })).truncated).toBe(true);
    const f = fixture(session({ draft: 'A new unsent question' })); await f.store.refresh(); await f.store.pollFollow(); await tick();
    let display = followPresentation(f.store.state)!;
    expect(display.content).not.toContain('new unsent'); expect(display.composer).toContain('new unsent');
    f.store.state.reply = reply('one', { turns: undefined }); display = followPresentation(f.store.state)!;
    expect(display.replyOnly).toBe(true); expect(display.footer).toContain('Reply only'); expect(display.content).not.toContain('YOU:');
  });
  it('pages the draft independently while keeping latest conversation visible', async () => {
    const draft = Array.from({ length: 90 }, (_, i) => `word${i}`).join(' ');
    const f = fixture(session({ view: 'draft', draft, page: 1 })); await f.store.refresh(); await f.store.pollFollow(); await tick();
    const display = followPresentation(f.store.state)!;
    expect(display.content).toContain('YOU: Show the next task.'); expect(display.composer).toBe(composerPages(draft, false, 'none', 'iPad')[1]);
    expect(display.pageLabel).toMatch(/^Draft · Older 2\//); expect(display.feedback?.payload.pageCount).toBe(composerPages(draft, false, 'none', 'iPad').length);
    f.set(session({ view: 'reply', draft }, { revision: 2 })); await f.store.pollFollow();
    expect(followPresentation(f.store.state)!.composer).toBe(composerPages(draft, false, 'none', 'iPad')[0]);
    expect(followPresentation(f.store.state)!.pageLabel).toBe('Conversation · Latest 1/1');
  });
  it('shows queued, confirmed, uncertain and recording states without guessing agent work', async () => {
    const f = fixture(session({ sendState: 'queued' })); await f.store.refresh(); await f.store.pollFollow(); await tick();
    let display = followPresentation(f.store.state)!;
    expect(display.status).toBe('Send queued'); expect(display.composer).toContain('Awaiting confirmation'); expect(display.footer).not.toContain('Working'); expect(display.status).not.toBe('Sent');
    f.set(session({ sendState: 'confirmed' }, { revision: 2 })); await f.store.pollFollow();
    expect(followPresentation(f.store.state)?.status).toBe('Sent'); expect(followPresentation(f.store.state)?.content).toContain('The next task is ready.');
    f.set(session({ sendState: 'uncertain', draft: 'Unsure' }, { revision: 3 })); await f.store.pollFollow(); expect(followPresentation(f.store.state)?.status).toBe('Send unverified');
    f.set(session({ recording: true, draft: 'Speaking' }, { revision: 4 })); await f.store.pollFollow(); expect(followPresentation(f.store.state)?.status).toBe('Voice input');
    f.set(session({}, { revision: 5 })); await f.store.pollFollow(); f.store.state.reply!.status = 'working'; expect(followPresentation(f.store.state)?.status).toBe('Working');
  });
});

describe('complete compact footer status', () => {
  it.each([
    [{ draft: 'Unsent words' }, 'Draft, not sent'],
    [{ recording: true }, 'Voice input'],
    [{ sendState: 'queued' }, 'Send queued'],
    [{ sendState: 'confirmed' }, 'Sent'],
    [{ sendState: 'uncertain' }, 'Send unverified'],
    [{ sendState: 'failed' }, 'Send failed'],
  ] as [Partial<DisplayState>, string][])('retains the complete status %j', async (state, expected) => {
    const f = fixture(session(state)); await f.store.refresh(); await f.store.pollFollow(); await tick();
    for (const view of ['reply', 'draft'] as const) {
      f.set(session({ ...state, view }, { revision: 2 })); await f.store.pollFollow();
      const presentation = followPresentation(f.store.state)!;
      expect(presentation.footer).toContain(expected); expect(visibleWidth(presentation.footer)).toBeLessThanOrEqual(42); expect(presentation.footer).not.toContain('…');
    }
  });
});

describe('terminal history route isolation and cadence', () => {
  it('retains history through Reply/Draft and explicit refresh but discards an older in-flight refresh', async () => {
    const f = fixture(); await f.store.refresh(); await f.store.pollFollow(); await tick();
    f.set(session({ view: 'draft', draft: 'New speech', recording: true }, { revision: 2 })); await f.store.pollFollow();
    expect(f.store.state.reply?.turns).toEqual(turns);
    const old = deferred<Reply>(); vi.mocked(f.api.reply).mockImplementationOnce(() => old.promise); const read = f.store.refreshReply();
    f.set(session({ view: 'draft', draft: 'New speech continued', refreshNonce: 1 }, { revision: 3 })); await f.store.pollFollow(); await tick();
    expect(f.store.state.reply?.turns).toEqual(turns); old.resolve(reply('one', { text: 'Stale history', turns: [{ role: 'assistant', text: 'Stale history' }] })); await read;
    expect(followPresentation(f.store.state)?.content).not.toContain('Stale'); expect(followPresentation(f.store.state)?.composer).toContain('continued'); expect(f.api.open).not.toHaveBeenCalled();
  });
  it('clears cached history on chat or owner change before the new read arrives', async () => {
    const f = fixture(); await f.store.refresh(); await f.store.pollFollow(); await tick();
    const pending = deferred<Reply>(); vi.mocked(f.api.reply).mockImplementationOnce(() => pending.promise);
    f.set(session({ chatID: 'two' }, { revision: 2 })); await f.store.pollFollow();
    expect(f.store.state.reply).toBeNull(); expect(followPresentation(f.store.state)?.content).toBe('Loading this conversation…');
    pending.resolve(reply('two')); await tick();
    const next = deferred<Reply>(); vi.mocked(f.api.reply).mockImplementationOnce(() => next.promise);
    f.set(session({ chatID: 'two' }, { revision: 3, sourceID: 'other-iphone', sourceName: 'iPhone' })); await f.store.pollFollow(); expect(f.store.state.reply).toBeNull();
    next.resolve(reply('two')); await tick();
  });
  it('reads every two seconds in active Reply or Draft, with one read in flight and none at Home', async () => {
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = fixture(session({ view: 'draft', draft: 'Ongoing words' })); await f.store.refresh(); await f.store.pollFollow(); await tick();
    expect(f.api.reply).toHaveBeenCalledTimes(1); now += 1999; await f.store.pollFollow(); expect(f.api.reply).toHaveBeenCalledTimes(1);
    const pending = deferred<Reply>(); vi.mocked(f.api.reply).mockImplementationOnce(() => pending.promise);
    now++; await f.store.pollFollow(); expect(f.api.reply).toHaveBeenCalledTimes(2); now += 3000; await f.store.pollFollow(); expect(f.api.reply).toHaveBeenCalledTimes(2);
    pending.resolve(reply()); await tick(); f.set(session({ view: 'home', chatID: null, slotIndex: null }, { revision: 2 })); now += 10000; await f.store.pollFollow(); expect(f.api.reply).toHaveBeenCalledTimes(2);
  });
});

describe('four-pane native rendering', () => {
  it('fits the SDK canvas, captures input once, and keeps conversation and composer separate', async () => {
    const f = fixture(session({ view: 'draft', draft: 'New speech' })); await f.store.refresh(); await f.store.pollFollow(); await tick();
    const frame = glassesFrame(f.store.state, host.name); const page = pageFor(frame); const objects = page.textObject!;
    expect(page.containerTotalNum).toBe(4); expect(objects.filter(o => o.isEventCapture === 1)).toHaveLength(1); expect(new Set(objects.map(o => o.containerID)).size).toBe(4);
    for (const o of objects) { expect(o.xPosition! + o.width!).toBeLessThanOrEqual(576); expect(o.yPosition! + o.height!).toBeLessThanOrEqual(288); expect(new TextEncoder().encode(o.content!).length).toBeLessThan(1000); }
    const sorted = [...objects].sort((a,b) => a.yPosition! - b.yPosition!); for (let i = 1; i < sorted.length; i++) expect(sorted[i-1].yPosition! + sorted[i-1].height!).toBeLessThanOrEqual(sorted[i].yPosition!);
    expect(objects.find(o => o.containerName === 'body')?.content).toContain('CODEX:'); expect(objects.find(o => o.containerName === 'composer')?.content).toContain('YOU > New speech');
  });
  it('does not acknowledge a changed composer until its actual SDK update succeeds', async () => {
    const port = { createStartUpPageContainer: vi.fn(async () => 0), rebuildPageContainer: vi.fn(async () => true), textContainerUpgrade: vi.fn(async () => true) }; const ack = vi.fn(); const error = vi.fn();
    const renderer = new GlassesRenderer(port, error, () => {}, ack);
    const frame = { kind: 'text' as const, title: 'Fixture', content: 'YOU: Question\nCODEX: Answer', footer: 'Draft · Latest 1/1', items: [], context: 'same-chat', composer: 'YOU > First words' };
    renderer.render(frame); await tick(); ack.mockClear(); const held = deferred<boolean>(); port.textContainerUpgrade.mockImplementationOnce(() => held.promise);
    renderer.render({ ...frame, composer: 'YOU > Continued words' }); await tick();
    expect(port.textContainerUpgrade).toHaveBeenCalledWith(expect.objectContaining({ containerName: 'composer', content: 'YOU > Continued words' })); expect(ack).not.toHaveBeenCalled();
    held.resolve(true); await tick(); expect(ack).toHaveBeenCalledTimes(1); expect(error).not.toHaveBeenCalled();
    port.textContainerUpgrade.mockResolvedValueOnce('false' as never); renderer.render({ ...frame, composer: 'YOU > Third words' }); await tick(); expect(ack).toHaveBeenCalledTimes(1); expect(error).toHaveBeenCalledTimes(1);
  });
});
