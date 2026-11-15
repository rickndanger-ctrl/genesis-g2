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
    const turns = [
      { role: 'user' as const, text: 'Sample question: can I talk on my iPad while reading here?' },
      { role: 'assistant' as const, text: 'Yes. Native Genesis handles Talk and Send. G2 follows the selected Codex conversation and keeps your current draft in the bottom composer.', phase: 'final_answer' as const },
      { role: 'user' as const, text: 'Sample question: how do I see older messages?' },
      { role: 'assistant' as const, text: 'The latest page appears first. Move to Older pages to review this recent conversation. In native Follow, choose Reply to page the conversation or Draft to review every word before you send. These are sample messages; nothing is connected or sent.', phase: 'final_answer' as const },
    ];
    return { provider, chatID, title: titles[Number(chatID.split('-')[1]) - 1] ?? titles[0], revision: 'demo-conversation-1', updatedAt: null, status: 'done', truncated: false, phase: 'final_answer', turns,
      text: turns[turns.length - 1].text };
  }
}
