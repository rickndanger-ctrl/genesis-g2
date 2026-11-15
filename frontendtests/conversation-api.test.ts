import { describe, expect, it } from 'vitest';
import { conversationValue, HTTPGateway } from '../src/api';

describe('bounded visible conversation wire contract', () => {
  it('keeps real speaker order and drops unadvertised fields', () => {
    expect(conversationValue([{ role: 'user', text: 'My request', phase: 'final_answer', hidden: 'private' }, { role: 'assistant', text: 'Response', phase: 'commentary', truncated: true, tool: 'private' }])).toEqual([
      { role: 'user', text: 'My request' }, { role: 'assistant', text: 'Response', phase: 'commentary', truncated: true },
    ]);
  });
  it.each(['system', 'developer', 'tool', 'reasoning'])('rejects non-display role %s', role => {
    expect(() => conversationValue([{ role, text: 'Not conversation content' }])).toThrow();
  });
  it('never treats a coerced phase value as a typed phase', () => {
    expect(conversationValue([{ role: 'assistant', text: 'Visible reply', phase: ['final_answer'] }])).toEqual([{ role: 'assistant', text: 'Visible reply' }]);
  });
  it('bounds count and Unicode scalars without dropping surrogate pairs', () => {
    expect(conversationValue([{ role: 'user', text: '😀'.repeat(16000) }])[0].text).toHaveLength(32000);
    expect(() => conversationValue([{ role: 'user', text: 'a'.repeat(16001) }])).toThrow();
    expect(() => conversationValue(Array.from({ length: 7 }, () => ({ role: 'assistant', text: 'small' })))).toThrow();
  });
  it('supports old reply-only bridges and passes through a validated transcript', async () => {
    const base = { provider: 'codex', chatID: 'thread', title: 'Thread', text: 'Reply', revision: 'one', status: 'unknown', truncated: false };
    let payload: object = base;
    const api = new HTTPGateway(async () => new Response(JSON.stringify(payload)));
    const host = { id: 'host', name: 'Mac', baseURL: 'https://mac.test', token: 'fixture' };
    expect((await api.reply(host, 'codex', 'thread', new AbortController().signal)).turns).toBeUndefined();
    payload = { ...base, turns: [{ role: 'user', text: 'Request' }, { role: 'assistant', text: 'Reply' }], turnsTruncated: true };
    const reply = await api.reply(host, 'codex', 'thread', new AbortController().signal);
    expect(reply.turns?.map(turn => turn.role)).toEqual(['user', 'assistant']);
    expect(reply.turnsTruncated).toBe(true); expect(reply.status).toBe('unknown');
  });
});
