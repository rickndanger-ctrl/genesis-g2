import type { Gateway, Host, Provider, Reply, Slot } from './types';
export const DEMO_HOST: Host = { id: 'demo', name: 'Studio preview', baseURL: '', token: '' };
const titles = ['Build something great', 'A calmer workspace', 'Ideas for tomorrow', 'The small details', 'Weekend project', 'One more thing'];
export class DemoGateway implements Gateway {
  async status() { return { host: { id: 'demo', name: 'Studio preview' }, providers: (['codex', 'claude'] as Provider[]).map(id => ({ id, label: id === 'codex' ? 'Codex' : 'Claude', available: true, canReadReply: true })), version: 'preview' }; }
  async profile(_host: Host, provider: Provider) {
    return { provider, slots: titles.map((label, i): Slot => ({ slot: i + 1, label, chatID: `demo-${i + 1}`, kind: 'chat' })) };
  }
  async chats(_host: Host, provider: Provider) { return { provider, chats: titles.map((title, i) => ({ id: `demo-${i + 1}`, title })) }; }
  async open(_host: Host, _provider: Provider, chat: { id: string; title: string }) { return { ok: true as const, chat, status: 'requested' as const }; }
  async reply(_host: Host, provider: Provider, chatID: string): Promise<Reply> {
    return { provider, chatID, title: titles[Number(chatID.split('-')[1]) - 1] ?? titles[0], revision: 'demo-1', updatedAt: null, status: 'done', truncated: false,
      text: 'This is a sample reply, not a live conversation.\n\nGenesis G2 puts your computers, agents, and chats within a glance. Choose a slot, read its latest response, and swipe through longer replies. Double-tap to return to the chat list.\n\nThe phone keeps your familiar six colors. On the glasses, clear slot numbers and a quiet green layout keep the same conversations easy to find.\n\nPair a Genesis bridge to replace this preview with your own chats. This first version opens chats and reads replies. It does not record, send messages, or change your existing controller mappings.' };
  }
}
