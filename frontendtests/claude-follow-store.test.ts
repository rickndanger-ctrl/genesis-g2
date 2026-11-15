import { afterEach, expect, it, vi } from 'vitest';
import { ControllerStore } from '../src/store';
import type { FollowSession, Gateway, Host, Reply } from '../src/types';

const host: Host = { id: 'mini1', name: 'Mini 1', baseURL: 'https://mini1.example.test', token: 'fixture-only-token' };
const session = (id = 'code-one'): FollowSession => ({ version: 1, hostID: host.id, active: true, revision: 1, sourceID: 'phone', sourceName: 'iPhone', expiresAt: new Date(Date.now() + 45000).toISOString(), state: { provider: 'claude', chatID: id, slotIndex: 0, view: 'reply', page: 0, draft: '', recording: false, sendState: 'none', refreshNonce: 0 } });
const reply = (id = 'code-one'): Reply => ({ provider: 'claude', chatID: id, title: 'Fixture', text: 'Claude answer', revision: 'r1', updatedAt: null, status: 'unknown', truncated: false, turns: [{ role: 'user', text: 'My request' }, { role: 'assistant', text: 'Claude answer' }] });
const stores: ControllerStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.dispose()); vi.restoreAllMocks(); });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(canReadReply = true) {
  let current = session();
  const api: Gateway = {
    status: vi.fn(async () => ({ host: { id: host.id, name: host.name }, version: 'fixture', providers: [{ id: 'claude', label: 'Claude', available: true, canReadReply }] })),
    profile: vi.fn(async (_host, provider) => ({ provider, slots: [] })), chats: vi.fn(async (_host, provider) => ({ provider, chats: [] })),
    open: vi.fn(async (_host, _provider, chat) => ({ ok: true, chat, status: 'confirmed' })),
    reply: vi.fn(async (_host, _provider, id) => reply(id)), follow: vi.fn(async () => current),
  };
  const store = new ControllerStore(api, [host]); stores.push(store);
  return { store, api, set: (value: FollowSession) => { current = value; } };
}
it('reads a capable Claude follow target without opening or sending a chat', async () => {
  const f = fixture(); await f.store.pollFollow(); await tick();
  expect(f.api.reply).toHaveBeenCalledWith(host, 'claude', 'code-one', expect.any(AbortSignal));
  expect(f.store.state.reply?.turns?.map(turn => turn.role)).toEqual(['user', 'assistant']);
  expect(f.api.open).not.toHaveBeenCalled();
});
it('keeps unsupported Claude follow draft functional without attempting a read', async () => {
  const f = fixture(false); const selected = session(); selected.state.draft = 'Draft stays here'; f.set(selected);
  await f.store.pollFollow(); await tick();
  expect(f.api.reply).not.toHaveBeenCalled(); expect(f.store.state.follow?.state.draft).toBe('Draft stays here');
});
it('discards a late Claude conversation after changing the followed thread', async () => {
  const f = fixture(); let finish!: (value: Reply) => void;
  vi.mocked(f.api.reply).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await f.store.pollFollow(); await tick(); f.set(session('code-two')); await f.store.pollFollow(); await tick();
  finish(reply('code-one')); await tick();
  expect(f.store.state.reply?.chatID).toBe('code-two'); expect(f.api.open).not.toHaveBeenCalled();
});
it('rejects a wrong-provider response to a Claude read', async () => {
  const f = fixture(); vi.mocked(f.api.reply).mockResolvedValueOnce({ ...reply(), provider: 'codex' });
  await f.store.pollFollow(); await tick();
  expect(f.store.state.reply).toBeNull(); expect(f.store.state.error).toContain('different chat');
});
it('retires previous Claude text if later account or session verification fails', async () => {
  const f = fixture(); await f.store.pollFollow(); await tick(); expect(f.store.state.reply).not.toBeNull();
  vi.mocked(f.api.reply).mockRejectedValueOnce(new Error('Conversation identity changed'));
  await f.store.refreshReply();
  expect(f.store.state.reply).toBeNull(); expect(f.store.state.error).not.toBeNull();
});
