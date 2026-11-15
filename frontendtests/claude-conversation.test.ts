import { describe, expect, it } from 'vitest';
import { followPresentation } from '../src/follow';
import { glassesFrame, pageFor } from '../src/glasses';
import { conversationPages, replyConversation, visibleWidth } from '../src/pagination';
import { ControllerStore, type State } from '../src/store';
import type { ConversationTurn, FollowSession, Gateway, Host, Reply } from '../src/types';

const host: Host = { id: 'claude-fixture-host', name: 'Fixture Mac', baseURL: 'https://fixture.example.test', token: 'fixture-only' };
const turns: ConversationTurn[] = [{ role: 'user', text: 'What is next?' }, { role: 'assistant', text: 'Review the current task.', phase: 'final_answer' }];
const reply = (extra: Partial<Reply> = {}): Reply => ({ provider: 'claude', chatID: 'claude-one', title: 'Claude fixture', text: 'Review the current task.', turns, revision: 'fixture-1', updatedAt: null, status: 'unknown', truncated: false, ...extra });
const session = (state: Partial<FollowSession['state']> = {}): FollowSession => ({ version: 1, hostID: host.id, active: true, revision: 1, sourceID: 'fixture-iphone', sourceName: 'iPhone', expiresAt: new Date(Date.now() + 45000).toISOString(), chatTitle: 'Claude fixture', state: { provider: 'claude', chatID: 'claude-one', slotIndex: 0, view: 'reply', page: 0, draft: '', recording: false, sendState: 'none', refreshNonce: 0, ...state } });
const fixture = (display: Partial<FollowSession['state']> = {}): State => ({
  ...new ControllerStore({} as Gateway, [host]).state,
  provider: 'claude', connected: true, view: 'reader', selected: { id: 'claude-one', title: 'Claude fixture' }, selectedSlot: 1,
  status: { host: { id: host.id, name: host.name }, version: 'fixture', providers: [{ id: 'claude', label: 'Claude', available: true, canReadReply: true }, { id: 'codex', label: 'Codex', available: true, canReadReply: true }] },
  follow: session(display), reply: reply(),
});
const compact = (text: string) => text.replace(/\s+/g, ' ');

describe('provider-neutral verified conversation presentation', () => {
  it('shows real Claude user and assistant turns with separate current draft and matching frame', () => {
    const state = fixture({ draft: 'An unsent follow-up' }); const display = followPresentation(state)!;
    expect(display.content).toBe('YOU: What is next?\nCLAUDE: Review the current task.');
    expect(display.content).not.toContain('CODEX:'); expect(display.content).not.toContain('unsent');
    expect(display.composer).toContain('YOU > An unsent follow-up'); expect(display.label).toBe('Recent conversation');
    expect(display.title).toContain('Claude / C1 / Claude fixture'); expect(display.feedback?.payload).toMatchObject({ provider: 'claude', chatID: 'claude-one', view: 'reply', pageCount: 1, connected: true });
    const frame = glassesFrame(state, host.name); const page = pageFor(frame);
    expect(page.textObject?.find(part => part.containerName === 'body')?.content).toBe(display.content);
    expect(page.textObject?.find(part => part.containerName === 'composer')?.content).toBe(display.composer);
  });
  it('labels a legacy Claude latest-assistant response as reply only without creating a user turn', () => {
    const state = fixture(); state.reply = reply({ turns: undefined }); const display = followPresentation(state)!;
    expect(display.content).toBe('CLAUDE: Review the current task.'); expect(display.replyOnly).toBe(true);
    expect(display.label).toBe('Latest reply only'); expect(display.footer).toContain('Reply only'); expect(display.content).not.toContain('YOU:');
    expect(replyConversation(reply({ turns: undefined })).pages[0]).toContain('CLAUDE:');
    expect(replyConversation(reply({ provider: 'codex', turns: undefined })).pages[0]).toContain('CODEX:');
  });
  it('keeps the wider Claude prefix in bounds on every page, with real prompt pinning', () => {
    const pages = conversationPages([{ role: 'user', text: 'Explain the next steps so I can follow along.' }, { role: 'assistant', text: '你好🙂 more words for this long response. '.repeat(70) }], 42, 5, 'claude');
    expect(pages.length).toBeGreaterThan(5); expect(pages[0]).toMatch(/^YOU: /); expect(pages[0]).toContain('\nCLAUDE:');
    expect(pages.every(page => page.split('\n').length <= 5 && page.split('\n').every(line => visibleWidth(line) <= 42))).toBe(true);
    expect(pages.join('\n')).not.toContain('CODEX:');
  });
  it('keeps Claude history visible while complete draft pages are reviewed', () => {
    const state = fixture({ view: 'draft', draft: Array.from({ length: 90 }, (_, index) => `draft${index}`).join(' '), page: 1, recording: true });
    const display = followPresentation(state)!;
    expect(display.content).toContain('CLAUDE: Review the current task.'); expect(display.composer).toContain('YOU >');
    expect(display.pageLabel).toMatch(/^Draft · Older 2\//); expect(display.status).toBe('Voice input');
    expect(display.feedback?.payload.view).toBe('draft'); expect(display.feedback?.payload.pageCount).toBeGreaterThan(1);
  });
  it.each([{ provider: 'codex' as const }, { chatID: 'another-claude-chat' }])('never shows a wrong-route reply: %j', patch => {
    const state = fixture(); state.reply = reply({ ...patch, text: 'Private stale answer', turns: [{ role: 'assistant', text: 'Private stale answer' }] });
    const display = followPresentation(state)!;
    expect(display.content).toBe('Loading this conversation…'); expect(JSON.stringify(display)).not.toContain('Private stale'); expect(display.feedback).toBeUndefined();
    state.follow = null; expect(glassesFrame(state, host.name).content).not.toContain('Private stale');
  });
  it('shows loading rather than unavailable when the bridge supports Claude but no verified reply arrived', () => {
    const state = fixture(); state.reply = null;
    expect(followPresentation(state)?.content).toBe('Loading this conversation…'); expect(followPresentation(state)?.feedback).toBeUndefined();
    state.error = 'This Claude session has no readable transcript yet. Open it in Claude Code, then refresh.';
    expect(compact(followPresentation(state)!.pages.join(' '))).toContain('no readable transcript yet');
    expect(followPresentation(state)?.feedback).toBeUndefined();
  });
  it('honors unavailable older-bridge capabilities even if a stale same-chat reply remains cached', () => {
    const state = fixture({ view: 'draft', draft: 'Still review my words', sendState: 'queued' });
    state.status!.providers[0].canReadReply = false;
    let display = followPresentation(state)!;
    expect(compact(display.content)).toContain('Claude replies are unavailable on this Mac.'); expect(display.content).not.toContain('Review the current task');
    expect(display.composer).toContain('Still review my words'); expect(display.receipt).toBe('Send queued'); expect(display.status).not.toBe('Sent');
    state.follow!.state.view = 'reply'; display = followPresentation(state)!; expect(display.label).toBe('Reply unavailable'); expect(display.replyOnly).toBe(false);
    state.status!.providers[0].reason = 'This companion cannot read Claude transcripts. Update Genesis on this Mac.';
    expect(compact(followPresentation(state)!.pages.join(' '))).toContain('cannot read Claude transcripts');
    state.follow = null; expect(glassesFrame(state, host.name).content).not.toContain('Review the current task');
  });
  it('requires advertised provider availability and capability, including a missing provider entry', () => {
    const state = fixture(); state.status!.providers[0].available = false;
    expect(followPresentation(state)?.label).toBe('Reply unavailable');
    state.status!.providers = state.status!.providers.filter(provider => provider.id !== 'claude');
    expect(followPresentation(state)?.label).toBe('Reply unavailable'); expect(followPresentation(state)?.content).not.toContain('Review the current task');
    state.status = null;
    expect(followPresentation(state)?.content).toBe('Loading this conversation…'); expect(followPresentation(state)?.feedback).toBeUndefined();
  });
  it('renders standalone Claude reads with the correct agent label', () => {
    const state = fixture(); state.follow = null;
    const frame = glassesFrame(state, host.name); expect(frame.content).toContain('CLAUDE:'); expect(frame.content).toContain('YOU:'); expect(frame.title).toContain('C1 / Claude fixture');
    state.provider = 'codex'; expect(glassesFrame(state, host.name).content).not.toContain('CLAUDE:');
  });
});
